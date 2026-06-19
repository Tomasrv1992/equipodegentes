/**
 * Extractores de texto plano de adjuntos no-DIAN:
 *   - .docx (Word) → mammoth
 *   - .pdf → pdf-parse
 *   - .xlsx / .xls (Excel) → xlsx (SheetJS)
 *
 * Devuelve string con el contenido textual del archivo, listo para pasar al LLM.
 */

import fs from "node:fs";
import mammoth from "mammoth";

/** Extrae texto plano de un .docx. Devuelve "" si falla. */
export async function extractTextFromDocx(filePath: string): Promise<string> {
  try {
    const buffer = fs.readFileSync(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return (result.value || "").trim();
  } catch (err: any) {
    console.warn(`extractTextFromDocx: ${filePath} failed: ${err.message}`);
    return "";
  }
}

/**
 * Extrae texto plano de un .xlsx / .xls (Excel) — cuentas de cobro que algunos
 * proveedores mandan como hoja de cálculo en vez de Word.
 *
 * Estrategia: recorrer TODAS las hojas y volcar cada una a CSV (filas y celdas
 * legibles para el LLM). Concatenamos las hojas con un separador para que el LLM
 * tenga el contexto completo. Limitamos por hoja para no inflar el prompt.
 *
 * Usa import dinámico de 'xlsx' (SheetJS) para no cargar la librería salvo que
 * haya un Excel que procesar (mismo patrón que pdf-parse).
 *
 * Devuelve "" si falla (libro corrupto, password, etc).
 */
export async function extractTextFromXlsx(filePath: string): Promise<string> {
  try {
    // Import dinámico: SheetJS es pesado, solo se carga si hay un .xlsx real.
    // @ts-ignore — xlsx no expone types ESM uniformes; casteo manual.
    const XLSX = (await import("xlsx")).default ?? (await import("xlsx"));
    const buffer = fs.readFileSync(filePath);
    const wb = XLSX.read(buffer, { type: "buffer" });
    const partes: string[] = [];
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      if (!ws) continue;
      // sheet_to_csv preserva la estructura tabular (filas/columnas) que es
      // justo lo que una cuenta de cobro en Excel necesita para que el LLM
      // ubique proveedor / NIT / valor.
      const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
      const trimmed = (csv || "").trim();
      if (trimmed.length === 0) continue;
      partes.push(`### Hoja: ${sheetName}\n${trimmed.slice(0, 8000)}`);
    }
    return partes.join("\n\n").trim();
  } catch (err: any) {
    console.warn(`extractTextFromXlsx: ${filePath} failed: ${err.message}`);
    return "";
  }
}

/**
 * Polyfill: pdf-parse internamente usa pdfjs-dist que requiere DOMMatrix
 * (API del navegador). En Node/Netlify functions no existe, entonces
 * pdf-parse falla con "DOMMatrix is not defined" en cualquier PDF.
 *
 * Fix: definir un stub mínimo. pdf-parse solo lo usa para rendering canvas
 * (que no necesitamos — solo queremos texto), entonces stub vacío basta.
 */
function ensureDomMatrixPolyfill(): void {
  const g = globalThis as any;
  if (typeof g.DOMMatrix === "undefined") {
    g.DOMMatrix = class DOMMatrix {
      constructor() {}
    };
  }
  if (typeof g.DOMPoint === "undefined") {
    g.DOMPoint = class DOMPoint {
      constructor() {}
    };
  }
  if (typeof g.ImageData === "undefined") {
    g.ImageData = class ImageData {
      constructor() {}
    };
  }
  if (typeof g.Path2D === "undefined") {
    g.Path2D = class Path2D {
      constructor() {}
    };
  }
}

/** Extrae texto plano de un .pdf. Devuelve "" si falla. */
export async function extractTextFromPdf(filePath: string): Promise<string> {
  try {
    ensureDomMatrixPolyfill();
    const buffer = fs.readFileSync(filePath);
    // Import del módulo interno (no `'pdf-parse'`). El index.js de la librería
    // ejecuta un self-test al cargarse que intenta abrir
    // ./test/data/05-versions-space.pdf — ese archivo no existe en el bundle
    // de Netlify y tira ENOENT en cada PDF que procesamos.
    // @ts-ignore — no hay types para la ruta interna, casteamos manual.
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default as
      (buf: Buffer) => Promise<{ text: string }>;
    const result = await pdfParse(buffer);
    return (result.text || "").trim();
  } catch (err: any) {
    console.warn(`extractTextFromPdf: ${filePath} failed: ${err.message}`);
    return "";
  }
}

/**
 * Detecta el tipo de adjunto por extensión.
 * Usado por el pipeline para decidir qué sub-pipeline aplicar.
 */
export function attachmentType(filename: string): "docx" | "pdf" | "zip" | "xml" | "xlsx" | "other" {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".docx") || lower.endsWith(".doc")) return "docx";
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".xml")) return "xml";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".xlsm")) return "xlsx";
  return "other";
}

/**
 * Heurísticas para distinguir senders internacionales conocidos.
 * Útil para presumedType del LLM.
 */
const KNOWN_INTL_SENDERS = [
  // Pagos / suscripciones
  "@stripe.com",
  "@paypal.com",

  // Cloud / infra
  "@amazon",
  "@aws.amazon.com",
  "@billing.amazon",
  "@vercel.com",
  "@netlify.com",
  "@cloudflare.com",
  "@digitalocean.com",
  "@heroku.com",
  "@firebase.com",

  // SaaS productividad
  "@notion.so",
  "@github.com",
  "@gitlab.com",
  "@anthropic.com",
  "@openai.com",
  "@google.com",
  "@workspace.google.com",
  "@dropbox.com",
  "@slack.com",
  "@zoom.us",
  "@calendly.com",
  "@hubspot.com",
  "@miro.com",
  "@figma.com",
  "@canva.com",
  "@asana.com",
  "@trello.com",
  "@monday.com",
  "@airtable.com",
  "@typeform.com",
  "@loom.com",

  // Ads / marketing platforms (LinkedIn Ads, Meta Ads, Google Ads)
  "@linkedin.com",
  "@facebookmail.com",
  "@business.facebook.com",
  "@meta.com",
  "@ads.google.com",

  // Otros frecuentes
  "@apple.com",
  "@microsoft.com",
  "@adobe.com",
  "@discord.com",
  "@spotify.com",
  "noreply@cursor.sh",
];

/**
 * Patrones que indican que el sender PROBABLEMENTE es billing internacional,
 * aunque su dominio no esté en KNOWN_INTL_SENDERS. Captura senders nuevos
 * sin tener que actualizar la lista hardcoded.
 *
 * Ejemplos que matchean:
 *   - invoice+statements@mail.anthropic.com
 *   - invoice+statements+acct_XXX@stripe.com (Miro vía Stripe)
 *   - billing@new-saas.io
 *   - receipts@anyservice.com
 *   - payments@somewhere.com
 *   - noreply+billing@apple.com
 */
const INTL_BILLING_HEURISTIC: RegExp[] = [
  /\b(invoice|receipt|billing|statements?|payments?|charges?)[+\-_.]/i,
  /^(invoice|receipt|billing|statements?|payments?|charges?)@/i,
  /@invoices?\./i,
  /@billing\./i,
  /noreply[+\-_]billing/i,
];

export function isLikelyInternationalSender(sender: string): boolean {
  const lower = (sender || "").toLowerCase();
  if (KNOWN_INTL_SENDERS.some((domain) => lower.includes(domain))) return true;
  if (INTL_BILLING_HEURISTIC.some((rx) => rx.test(lower))) return true;
  return false;
}
