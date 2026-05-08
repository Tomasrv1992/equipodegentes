/**
 * Extractores de texto plano de adjuntos no-DIAN:
 *   - .docx (Word) → mammoth
 *   - .pdf → pdf-parse (futuro, sub-fase B)
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
