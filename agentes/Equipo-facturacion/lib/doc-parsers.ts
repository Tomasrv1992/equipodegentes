/**
 * Extractores de texto plano de adjuntos no-DIAN:
 *   - .docx (Word) → mammoth
 *   - .pdf → pdf-parse
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
    // Import dinámico — pdf-parse en CommonJS, mejor lazy (después del polyfill)
    const pdfParse = (await import("pdf-parse")).default;
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
export function attachmentType(filename: string): "docx" | "pdf" | "zip" | "xml" | "other" {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".xml")) return "xml";
  return "other";
}

/**
 * Heurísticas para distinguir senders internacionales conocidos.
 * Útil para presumedType del LLM.
 */
const KNOWN_INTL_SENDERS = [
  "@stripe.com",
  "@paypal.com",
  "@amazon",  // amazon.com, amazonaws.com
  "@aws.amazon.com",
  "@billing.amazon",
  "@notion.so",
  "@github.com",
  "@anthropic.com",
  "@openai.com",
  "@vercel.com",
  "@netlify.com",
  "@google.com",  // workspace billing
  "noreply@cursor.sh",
];

export function isLikelyInternationalSender(sender: string): boolean {
  const lower = (sender || "").toLowerCase();
  return KNOWN_INTL_SENDERS.some((domain) => lower.includes(domain));
}
