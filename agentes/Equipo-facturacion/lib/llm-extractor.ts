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

    const json = parseLlmJson(textBlock.text);
    if (!json) return null;

    // Validación mínima
    if (!json.fecha || !json.total || json.total <= 0) {
      return null; // no parece factura válida
    }

    return {
      fecha: normalizeFecha(json.fecha, ctx.emailDate),
      proveedor: String(json.proveedor || "Sin nombre").trim(),
      nit: String(json.nit || "").replace(/\D+/g, ""),
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

  return `
Sos un extractor de datos contables. Te paso el texto de ${tipoLabel}.

CONTEXTO:
${ctx.filename ? `Filename: ${ctx.filename}` : ""}
${ctx.sender ? `Sender: ${ctx.sender}` : ""}
${ctx.subject ? `Subject: ${ctx.subject}` : ""}
${ctx.emailDate ? `Email recibido: ${ctx.emailDate}` : ""}

TEXTO DEL DOCUMENTO:
"""
${ctx.text.slice(0, 6000)}
"""

EXTRAÉ los siguientes campos en JSON puro (sin markdown, sin comentarios). Si NO es una factura/cuenta de cobro válida (ej: es una notificación de Stripe diciendo "tu pago se procesó" sin detalle), devolvé el objeto con "es_factura": false.

Schema esperado:
{
  "es_factura": true|false,
  "fecha": "YYYY-MM-DD" (fecha de emisión del documento, no del email),
  "proveedor": "nombre razón social del proveedor",
  "nit": "número NIT/Cédula sin puntos ni guiones (Colombia) o tax id internacional",
  "numero": "número de factura/recibo/cuenta de cobro",
  "subtotal": número (sin moneda, sin separadores),
  "iva": número (0 si no aplica),
  "total": número,
  "moneda": "COP" | "USD" | "EUR" | etc (default COP si no se especifica),
  "total_cop": número (si moneda != COP, convertir a COP usando ~4200 COP/USD; si moneda=COP, igual a total),
  "concepto": "descripción corta de qué se factura/cobra",
  "confianza": 0.0-1.0 (qué tan seguro estás de los datos extraídos),
  "notas": "opcional: si confianza < 0.5 o algo está raro, explicá brevemente"
}

REGLAS:
- Devolvé SOLO el JSON, sin texto antes ni después.
- Si "es_factura": false, omití el resto de campos.
- Para cuentas de cobro Colombia: el "proveedor" es la persona/empresa que emite el cobro.
- Para recibos Stripe/PayPal: el "proveedor" es la plataforma + el merchant si se menciona.
- Si el documento no tiene IVA explícito, IVA = 0 (no asumas 19%).
- Si la fecha está en formato "8 de enero de 2026", convertilo a "2026-01-08".

JSON:`;
}

/** Parsea JSON tolerante a wrappers de markdown (\`\`\`json ... \`\`\`). */
function parseLlmJson(text: string): any | null {
  // Quitar markdown fences si los hay
  let clean = text.trim();
  const fenceMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) clean = fenceMatch[1].trim();

  try {
    const parsed = JSON.parse(clean);
    if (parsed.es_factura === false) return null;
    return parsed;
  } catch {
    // Intentar extraer el primer bloque que parezca JSON
    const objMatch = clean.match(/\{[\s\S]*\}/);
    if (!objMatch) return null;
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed.es_factura === false) return null;
      return parsed;
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
