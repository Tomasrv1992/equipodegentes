/**
 * Extractor de datos estructurados de documentos no-DIAN usando LLM.
 *
 * Para facturas que NO vienen en formato DIAN (ZIP+XML), usamos Claude para
 * leer el texto plano (de Word/PDF/email body) y devolver JSON con los campos
 * que necesitamos para guardarlas en el Sheet del cliente.
 *
 * Tipos soportados:
 *   - cuenta_cobro: Word .docx de proveedores no obligados a fact. electrónica
 *   - recibo_internacional: PDF de Stripe, AWS, Notion, etc
 *   - recibo_servicio: facturas de servicios no DIAN (algunas eléctricas, etc)
 *
 * Costo aproximado por extracción (Claude Haiku 3.5):
 *   - ~500-1500 input tokens por documento
 *   - ~100-200 output tokens
 *   - ~$0.0005 - $0.001 por extracción
 */

import Anthropic from "@anthropic-ai/sdk";
import type { InvoiceData } from "./pipeline";
import { acquireLlmToken } from "../../../shared/agents-runtime/src/llm-rate-limiter";

export type DocumentSource = "cuenta_cobro" | "recibo_internacional" | "recibo_servicio" | "email_body";

export interface ExtractedInvoice extends InvoiceData {
  /** Tipo de documento detectado/asumido. */
  tipo: DocumentSource;
  /** Moneda detectada (default COP). Si != COP, total es valor original. */
  moneda: string;
  /** Total convertido a COP si moneda != COP. Igual a `total` si moneda=COP. */
  totalCop: number;
  /** Confianza del LLM en el dato extraído (0-1). */
  confianza: number;
  /** Razón si confianza < 0.5 o por qué no se pudo extraer. */
  notas?: string;
}

interface ExtractionContext {
  /** Texto del documento extraído. */
  text: string;
  /** Tipo presumido del documento (lo que el pipeline dedujo del filename/sender). */
  presumedType: DocumentSource;
  /** Filename del adjunto (si aplica). */
  filename?: string;
  /** Sender del email (si aplica). */
  sender?: string;
  /** Subject del email (si aplica). */
  subject?: string;
  /** Fecha del email recibido (fallback si no se extrae del texto). */
  emailDate?: string;
  /** NIT del cliente (para evitar extraer al cliente como proveedor — self-emitted). */
  nitCliente?: string | null;
  /** Nombre del cliente (para reforzar el filtro self-emitted). */
  nombreCliente?: string | null;
  /**
   * FIX 2026-06-09: si true, NO retornar null aunque LLM diga `es_factura:false`.
   * Activado por el caller cuando el subject matchea pattern de cuenta de cobro
   * conocido (CC Mayo 2026, documentación cuenta de cobro, SMB) — recupera
   * falsos negativos del LLM. El extracted retorna con flag `_forced=true`
   * para que el caller decida umbrales más laxos.
   */
  forceProcess?: boolean;
}

/**
 * Extrae datos estructurados de un documento usando Claude.
 * Devuelve null si el LLM determina que NO es una factura/cuenta de cobro
 * (e.g., una notificación, un newsletter, etc).
 */
export async function extractInvoiceFromText(
  ctx: ExtractionContext,
): Promise<ExtractedInvoice | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("ANTHROPIC_API_KEY ausente — skip extracción LLM");
    return null;
  }

  const anthropic = new Anthropic({ apiKey });

  const prompt = buildExtractionPrompt(ctx);

  // Retry con backoff exponencial para errores 529 (overloaded) y 429 (rate limit)
  // Críticos cuando se procesan muchos clientes en paralelo (auto-fan-out + concurrencia).
  const MAX_RETRIES = 3;
  let lastError: any = null;
  let resp: any = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Token bucket: bloquea (await) si superamos el rate limit del minuto.
      // Evita 429s en cascada durante fan-out con muchos clientes/meses paralelos.
      await acquireLlmToken();
      resp = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      });
      break; // éxito → salir del retry loop
    } catch (err: any) {
      lastError = err;
      const status = err?.status ?? err?.response?.status;
      const isRetryable = status === 529 || status === 429 || status === 503;
      if (!isRetryable || attempt === MAX_RETRIES) {
        console.error(`LLM extraction failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}, status=${status}): ${err.message}`);
        return null;
      }
      const delayMs = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500); // 1s, 2s, 4s + jitter
      console.warn(`LLM ${status} overloaded — retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  if (!resp) {
    console.error("LLM extraction failed — sin respuesta tras retries:", lastError?.message);
    return null;
  }

  try {
    const textBlock = resp.content.find((b: any) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;

    // FIX 2026-06-09: parseLlmJsonRaw NO descarta es_factura:false. La decisión
    // de descartar la toma este caller según ctx.forceProcess.
    const json = parseLlmJsonRaw(textBlock.text);
    if (!json) return null;

    // Si LLM dijo es_factura:false:
    //   - forceProcess=false (default) → descartar (comportamiento original)
    //   - forceProcess=true → continuar, marcar _forced para umbrales laxos
    const llmSaidNo = json.es_factura === false;
    if (llmSaidNo && !ctx.forceProcess) return null;

    // Skip certificados de retención INCLUSO con forceProcess (riesgo demasiado alto).
    if (json.es_certificado_retencion === true) {
      console.log("[llm-extractor] skip: es certificado de retención");
      return null;
    }

    // Validación mínima
    if (!json.fecha || !json.total || json.total <= 0) {
      return null; // no parece factura válida
    }

    // Validación self-emitted: si el NIT extraído coincide con el del cliente,
    // significa que el LLM se confundió (probable que extrajo al deudor en vez del proveedor).
    const nitExtraido = String(json.nit || "").replace(/\D+/g, "");
    const nitClienteNorm = ctx.nitCliente
      ? String(ctx.nitCliente).replace(/\D+/g, "")
      : null;
    if (nitClienteNorm && nitExtraido && nitExtraido === nitClienteNorm) {
      console.log(
        `[llm-extractor] skip self-emitted: NIT extraído ${nitExtraido} = NIT cliente ${nitClienteNorm}`,
      );
      return null;
    }

    const result: ExtractedInvoice = {
      fecha: normalizeFecha(json.fecha, ctx.emailDate),
      proveedor: String(json.proveedor || "Sin nombre").trim(),
      nit: nitExtraido,
      numero: String(json.numero || "").trim(),
      cufe: "", // no aplica para no-DIAN
      subtotal: Number(json.subtotal) || Number(json.total),
      iva: Number(json.iva) || 0,
      total: Number(json.total),
      concepto: String(json.concepto || "").trim(),
      tipo: ctx.presumedType,
      moneda: String(json.moneda || "COP").toUpperCase(),
      totalCop: Number(json.total_cop) || Number(json.total),
      confianza: Math.min(1, Math.max(0, Number(json.confianza) || 0.7)),
      notas: json.notas ? String(json.notas).trim() : undefined,
    };
    // FIX 2026-06-09: flag _forced cuando forceProcess rescató una extracción
    // que LLM había marcado como no-factura. El caller usa esto para umbrales
    // de confianza condicionales (0.2 si _forced, 0.4 default).
    if (llmSaidNo && ctx.forceProcess) {
      (result as any)._forced = true;
    }
    return result;
  } catch (err: any) {
    console.error("LLM extraction failed:", err.message);
    return null;
  }
}

function buildExtractionPrompt(ctx: ExtractionContext): string {
  const tipoLabel = {
    cuenta_cobro: "una CUENTA DE COBRO (Colombia, formato Word típico de proveedor no obligado a facturación electrónica)",
    recibo_internacional: "un RECIBO INTERNACIONAL (Stripe, PayPal, AWS, Notion, GitHub, Anthropic, etc)",
    recibo_servicio: "un RECIBO DE SERVICIO público (luz, agua, internet) o factura local sin DIAN",
    email_body: "el cuerpo de un email con información de pago/factura",
  }[ctx.presumedType];

  // Información del cliente (para evitar self-emitted)
  const clienteInfo =
    ctx.nitCliente || ctx.nombreCliente
      ? `\nINFORMACIÓN DEL CLIENTE (el deudor — NUNCA es el proveedor):
- Nombre cliente: ${ctx.nombreCliente ?? "(desconocido)"}
- NIT cliente: ${ctx.nitCliente ?? "(desconocido)"}
⚠️ El proveedor extraído NO puede ser el cliente. Si el cliente aparece en el documento, es el DEUDOR (quien debe pagar), NUNCA el proveedor.`
      : "";

  // Regla específica de cuenta de cobro
  const reglaCuentaCobro =
    ctx.presumedType === "cuenta_cobro"
      ? `
REGLA CRÍTICA PARA CUENTAS DE COBRO:
Una cuenta de cobro típica colombiana tiene esta estructura:
   Nota de cobro No 143
   [NOMBRE EMPRESA CLIENTE]            ← ESTE ES EL CLIENTE (deudor)
   NIT 9XX.XXX.XXX-X
   Debe A:
   [NOMBRE PERSONA/EMPRESA PROVEEDOR]  ← ESTE ES EL PROVEEDOR (acreedor, quien va a recibir el pago)
   C.C. XX.XXX.XXX  o  NIT XXX.XXX.XXX

El PROVEEDOR es **QUIEN COBRA** (después de "Debe a:" o "Cobra a:" o similar).
El CLIENTE es **QUIEN DEBE PAGAR** (aparece primero, con NIT empresarial).

EJEMPLO de mal extraído (NO HAGAS ESTO):
  Documento dice "DENTILANDIA SAS NIT 901... Debe A: MARIA GLADYS C.C. 43076121"
  ❌ MAL: proveedor="DENTILANDIA SAS", nit="901..."
  ✅ BIEN: proveedor="MARIA GLADYS URIBE YARCE", nit="43076121"
`
      : "";

  return `
Sos un extractor de datos contables. Te paso el texto de ${tipoLabel}.

CONTEXTO:
${ctx.filename ? `Filename: ${ctx.filename}` : ""}
${ctx.sender ? `Sender: ${ctx.sender}` : ""}
${ctx.subject ? `Subject: ${ctx.subject}` : ""}
${ctx.emailDate ? `Email recibido: ${ctx.emailDate}` : ""}
${clienteInfo}
${reglaCuentaCobro}

TEXTO DEL DOCUMENTO:
"""
${ctx.text.slice(0, 6000)}
"""

EXTRAÉ los siguientes campos en JSON puro (sin markdown, sin comentarios). Si NO es una factura/cuenta de cobro válida (ej: es una notificación de Stripe diciendo "tu pago se procesó" sin detalle, o es un CERTIFICADO DE RETENCIÓN — no una factura), devolvé el objeto con "es_factura": false.

⚠️ CERTIFICADOS DE RETENCIÓN NO son facturas — son comprobantes de retención ya practicada. Si el texto contiene "Certificado de Retención", "Certificado RTE", "Retención en la Fuente practicada", marcá "es_factura": false con "notas": "Certificado de retención, no es factura".

Schema esperado:
{
  "es_factura": true|false,
  "es_certificado_retencion": true|false (opcional, true si es certificado RTE),
  "fecha": "YYYY-MM-DD" (fecha de emisión del documento, no del email),
  "proveedor": "nombre razón social del proveedor (QUIEN COBRA, NUNCA el cliente)",
  "nit": "número NIT/Cédula del PROVEEDOR sin puntos ni guiones",
  "numero": "número de factura/recibo/cuenta de cobro (consecutivo)",
  "subtotal": número (sin moneda, sin separadores),
  "iva": número (0 si no aplica),
  "total": número,
  "moneda": "COP" | "USD" | "EUR" | etc (default COP si no se especifica),
  "total_cop": número (si moneda != COP, convertir a COP usando ~4200 COP/USD; si moneda=COP, igual a total),
  "concepto": "descripción corta de qué se factura/cobra",
  "confianza": 0.0-1.0 (qué tan seguro estás de los datos extraídos),
  "notas": "opcional: si confianza < 0.5 o algo está raro, explicá brevemente"
}

REGLAS GENERALES:
- Devolvé SOLO el JSON, sin texto antes ni después.
- Si "es_factura": false, omití el resto de campos.
- Si el documento es un certificado de retención (de años anteriores o del año actual), "es_factura": false y "es_certificado_retencion": true.
- Para cuentas de cobro Colombia: el "proveedor" es **QUIEN COBRA** (la persona o empresa que recibe el pago). El cliente que paga NUNCA es el proveedor.
- Para recibos Stripe/PayPal: el "proveedor" es la plataforma + el merchant si se menciona.
- Si el documento no tiene IVA explícito, IVA = 0 (no asumas 19%).
- Si la fecha está en formato "8 de enero de 2026", convertilo a "2026-01-08".
- "numero" debe ser el consecutivo del documento (factura, recibo, nota de cobro). Es la fuente de la verdad para deduplicación.
${ctx.nitCliente ? `- Si el "nit" extraído coincide con el NIT del cliente (${ctx.nitCliente}), revisá: probablemente extrajiste mal. Devolvé "es_factura": false con notas explicando.` : ""}

JSON:`;
}

/**
 * Parsea JSON tolerante a wrappers de markdown (\`\`\`json ... \`\`\`).
 * FIX 2026-06-09: NO descarta `es_factura:false` — esa decisión la toma el
 * caller `extractInvoiceFromText` según `ctx.forceProcess`.
 */
function parseLlmJsonRaw(text: string): any | null {
  // Quitar markdown fences si los hay
  let clean = text.trim();
  const fenceMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) clean = fenceMatch[1].trim();

  try {
    return JSON.parse(clean);
  } catch {
    // Intentar extraer el primer bloque que parezca JSON
    const objMatch = clean.match(/\{[\s\S]*\}/);
    if (!objMatch) return null;
    try {
      return JSON.parse(objMatch[0]);
    } catch {
      return null;
    }
  }
}

/** Normaliza fecha a YYYY-MM-DD; si la del LLM es inválida, fallback a email date. */
function normalizeFecha(llmFecha: string, emailDate?: string): string {
  // Caso ideal: ya viene YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(llmFecha)) return llmFecha;

  // YYYY-MM-DDTHH... → tomar solo la fecha
  const isoMatch = llmFecha.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];

  // DD/MM/YYYY → YYYY-MM-DD
  const dmyMatch = llmFecha.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmyMatch) {
    return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, "0")}-${dmyMatch[1].padStart(2, "0")}`;
  }

  // Fallback al email date
  if (emailDate) {
    const d = new Date(emailDate);
    if (!isNaN(d.getTime())) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    }
  }

  // Último fallback: hoy
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}
