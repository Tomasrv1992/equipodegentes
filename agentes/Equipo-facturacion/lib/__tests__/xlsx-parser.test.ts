import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { extractTextFromXlsx, attachmentType } from "../doc-parsers";

// Construye un .xlsx real en tmp con la pinta de una cuenta de cobro en Excel.
function makeCuentaCobroXlsx(): string {
  const aoa = [
    ["CUENTA DE COBRO", "", ""],
    ["No.", "143", ""],
    ["Fecha", "2026-01-15", ""],
    ["Debe a:", "MARIA GLADYS URIBE YARCE", ""],
    ["C.C.", "43076121", ""],
    ["Concepto", "Servicios de aseo enero", ""],
    ["Valor", "", 1500000],
    ["Total a pagar", "", 1500000],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Cuenta de cobro");
  const p = path.join(os.tmpdir(), `cc-test-${Date.now()}.xlsx`);
  XLSX.writeFile(wb, p);
  return p;
}

const tmpFiles: string[] = [];
afterAll(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

describe("attachmentType — xlsx", () => {
  it("detecta .xlsx", () => expect(attachmentType("cuenta.xlsx")).toBe("xlsx"));
  it("detecta .xls", () => expect(attachmentType("cuenta.xls")).toBe("xlsx"));
  it("detecta .xlsm", () => expect(attachmentType("macro.xlsm")).toBe("xlsx"));
  it("mayúsculas .XLSX", () => expect(attachmentType("CUENTA.XLSX")).toBe("xlsx"));
  it("docx sigue siendo docx", () => expect(attachmentType("cc.docx")).toBe("docx"));
});

describe("extractTextFromXlsx", () => {
  it("extrae el contenido de la cuenta de cobro en Excel", async () => {
    const p = makeCuentaCobroXlsx();
    tmpFiles.push(p);
    const text = await extractTextFromXlsx(p);
    expect(text).toContain("CUENTA DE COBRO");
    expect(text).toContain("MARIA GLADYS URIBE YARCE");
    expect(text).toContain("43076121");
    expect(text).toContain("1500000");
    expect(text).toContain("Hoja: Cuenta de cobro");
  });

  it("archivo inexistente → '' sin lanzar", async () => {
    const text = await extractTextFromXlsx(path.join(os.tmpdir(), "no-existe-xyz.xlsx"));
    expect(text).toBe("");
  });

  it("texto extraído pasa el pre-filtro de indicadores de factura", async () => {
    const p = makeCuentaCobroXlsx();
    tmpFiles.push(p);
    const text = await extractTextFromXlsx(p);
    const { hasInvoiceIndicators } = await import("../llm-pre-filters");
    expect(hasInvoiceIndicators(text)).toBe(true);
  });
});
