import { describe, it, expect } from "vitest";
import { conciliarMes, soloEnA } from "../conciliacion-decide";

describe("soloEnA — diferencia de conjuntos", () => {
  it("devuelve lo que esta en A pero no en B, sin vacios y deduplicado", () => {
    expect(soloEnA(["a", "b", "b", "", "c"], ["b"])).toEqual(["a", "c"]);
  });
  it("conjuntos iguales -> vacio", () => {
    expect(soloEnA(["a", "b"], ["b", "a"])).toEqual([]);
  });
});

describe("conciliarMes — conciliacion determinista por conjuntos", () => {
  // Caso 1: las 4 fuentes coinciden -> ok, sin discrepancias.
  it("todo coincide -> ok true", () => {
    const r = conciliarMes({
      gmailMessageIds: ["m1", "m2"],
      bdMessageIds: ["m1", "m2"],
      bdNumeros: ["FE1", "FE2"],
      sheetNumeros: ["FE1", "FE2"],
      driveCount: 2,
    });
    expect(r.ok).toBe(true);
    expect(r.conteos).toEqual({ gmail: 2, bd: 2, sheet: 2, drive: 2 });
    expect(r.discrepancias.en_gmail_no_en_bd).toEqual([]);
    expect(r.discrepancias.en_bd_no_en_gmail).toEqual([]);
    expect(r.discrepancias.en_bd_no_en_sheet).toEqual([]);
    expect(r.discrepancias.en_sheet_no_en_bd).toEqual([]);
    expect(r.discrepancias.diferencia_drive).toBe(0);
  });

  // Caso 2: una factura esta en BD pero falta en el Sheet.
  it("falta en Sheet -> en_bd_no_en_sheet la detecta, ok false", () => {
    const r = conciliarMes({
      gmailMessageIds: ["m1", "m2"],
      bdMessageIds: ["m1", "m2"],
      bdNumeros: ["FE1", "FE2"],
      sheetNumeros: ["FE1"], // falta FE2
      driveCount: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.discrepancias.en_bd_no_en_sheet).toEqual(["FE2"]);
    expect(r.discrepancias.en_sheet_no_en_bd).toEqual([]);
  });

  // Caso 3: un email en Gmail con label Facturas que no llego a BD.
  it("sobra en Gmail -> en_gmail_no_en_bd la detecta, ok false", () => {
    const r = conciliarMes({
      gmailMessageIds: ["m1", "m2", "m3"], // m3 no esta en BD
      bdMessageIds: ["m1", "m2"],
      bdNumeros: ["FE1", "FE2"],
      sheetNumeros: ["FE1", "FE2"],
      driveCount: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.discrepancias.en_gmail_no_en_bd).toEqual(["m3"]);
    expect(r.discrepancias.en_bd_no_en_gmail).toEqual([]);
  });

  // Caso 4 (EL MAS IMPORTANTE): mismos TOTALES pero conjuntos distintos.
  // BD = {FE1, FE2}, Sheet = {FE1, FE9}: ambos tienen 2 filas, un conteo simple
  // (2 == 2) lo dejaria pasar. La comparacion por conjuntos lo atrapa.
  it("errores que se compensan en el total pero difieren en conjuntos -> ok false", () => {
    const r = conciliarMes({
      gmailMessageIds: ["m1", "m2"],
      bdMessageIds: ["m1", "m2"],
      bdNumeros: ["FE1", "FE2"],
      sheetNumeros: ["FE1", "FE9"], // mismo conteo (2) que BD, pero FE2->FE9
      driveCount: 2,
    });
    expect(r.conteos.bd).toBe(r.conteos.sheet); // los totales coinciden...
    expect(r.ok).toBe(false); // ...pero la conciliacion falla
    expect(r.discrepancias.en_bd_no_en_sheet).toEqual(["FE2"]);
    expect(r.discrepancias.en_sheet_no_en_bd).toEqual(["FE9"]);
  });

  // Caso 5: Drive por conteo (sin driveNumeros) — falta 1 PDF.
  it("Drive con menos PDFs que filas BD -> diferencia_drive negativa, ok false", () => {
    const r = conciliarMes({
      gmailMessageIds: ["m1", "m2"],
      bdMessageIds: ["m1", "m2"],
      bdNumeros: ["FE1", "FE2"],
      sheetNumeros: ["FE1", "FE2"],
      driveCount: 1, // falta un PDF
    });
    expect(r.ok).toBe(false);
    expect(r.discrepancias.diferencia_drive).toBe(-1);
  });

  // Caso 6: Drive por conjunto (con driveNumeros parseados del filename).
  it("Drive por conjunto detecta un PDF cuyo numero no esta en BD", () => {
    const r = conciliarMes({
      gmailMessageIds: ["m1", "m2"],
      bdMessageIds: ["m1", "m2"],
      bdNumeros: ["FE1", "FE2"],
      sheetNumeros: ["FE1", "FE2"],
      driveCount: 2,
      driveNumeros: ["FE1", "FE3"], // FE3 en Drive no esta en BD; falta FE2
    });
    expect(r.ok).toBe(false);
    expect(r.discrepancias.en_drive_no_en_bd).toEqual(["FE3"]);
    expect(r.discrepancias.en_bd_no_en_drive).toEqual(["FE2"]);
  });
});
