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

/** Extrae texto plano de un .pdf. Devuelve "" si falla. */
export async function extractTextFromPdf(filePath: string): Promise<string> {
  try {
    const buffer = fs.readFileSync(filePath);
    // Import dinámico — pdf-parse en CommonJS, mejor lazy
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
