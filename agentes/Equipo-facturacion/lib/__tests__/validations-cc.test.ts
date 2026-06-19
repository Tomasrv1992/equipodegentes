import { describe, it, expect } from "vitest";
import {
  validarFacturaCompleta,
  validarDocumentoCobro,
  esNumeroDocumentoCobroValido,
} from "../validations";

// === Reglas LAXAS para cuenta_cobro =========================================
// Una cuenta de cobro real (persona natural no obligada a fact. electrónica)
// frecuentemente NO trae NIT formal, ni numero consecutivo "tipo factura".
// Lo único innegociable: proveedor (quién cobra), fecha y monto > 0.
describe("validarDocumentoCobro (reglas laxas para cuenta_cobro)", () => {
  const baseCC = {
    numero: "143",
    fecha: "2026-01-15",
    nit: "43076121",
    total: 1_500_000,
    proveedor: "Maria Gladys Uribe Yarce",
  };

  it("CC completa y bien formada → válida", () => {
    expect(validarDocumentoCobro(baseCC).esValida).toBe(true);
  });

  it("CC persona natural SIN NIT → válida (NIT es opcional)", () => {
    const r = validarDocumentoCobro({ ...baseCC, nit: "" });
    expect(r.esValida).toBe(true);
  });

  it("CC SIN numero consecutivo → válida (se sintetiza después)", () => {
    const r = validarDocumentoCobro({ ...baseCC, numero: "" });
    expect(r.esValida).toBe(true);
  });

  it("CC con numero informal corto ('1') → válida", () => {
    const r = validarDocumentoCobro({ ...baseCC, numero: "1" });
    expect(r.esValida).toBe(true);
  });

  it("CC con numero 'CC-001' → válida", () => {
    expect(validarDocumentoCobro({ ...baseCC, numero: "CC-001" }).esValida).toBe(true);
  });

  // ---- Lo que SÍ debe rechazar (no abrir la puerta a basura) ----
  it("rechaza si NO hay proveedor (sin quién cobra no es gasto contabilizable)", () => {
    const r = validarDocumentoCobro({ ...baseCC, proveedor: "" });
    expect(r.esValida).toBe(false);
    expect(r.motivos.join(" ")).toMatch(/proveedor/);
  });

  it("rechaza si total <= 0", () => {
    const r = validarDocumentoCobro({ ...baseCC, total: 0 });
    expect(r.esValida).toBe(false);
    expect(r.motivos.join(" ")).toMatch(/monto/);
  });

  it("rechaza fecha basura", () => {
    const r = validarDocumentoCobro({ ...baseCC, fecha: "mayo de 2026" });
    expect(r.esValida).toBe(false);
    expect(r.motivos.join(" ")).toMatch(/fecha/);
  });

  it("rechaza monto excesivo (>$100M) como sospechoso", () => {
    const r = validarDocumentoCobro({ ...baseCC, total: 200_000_000 });
    expect(r.esValida).toBe(false);
  });

  it("rechaza numero que es palabra de prueba aunque sea CC", () => {
    const r = validarDocumentoCobro({ ...baseCC, numero: "PRUEBA" });
    // numero opcional, pero si viene y es basura explícita → rechazo
    expect(r.esValida).toBe(false);
  });
});

describe("esNumeroDocumentoCobroValido", () => {
  it("vacío → true (numero opcional en CC)", () => {
    expect(esNumeroDocumentoCobroValido("")).toBe(true);
    expect(esNumeroDocumentoCobroValido(null)).toBe(true);
  });
  it("'1' → true (informal pero legítimo)", () => {
    expect(esNumeroDocumentoCobroValido("1")).toBe(true);
  });
  it("'PRUEBA 002' → false (palabra reservada)", () => {
    expect(esNumeroDocumentoCobroValido("PRUEBA 002")).toBe(false);
  });
  it("'mayo de 2026' → false (mes, no numero)", () => {
    expect(esNumeroDocumentoCobroValido("mayo de 2026")).toBe(false);
  });
  it("'0,00E+00' → false (notación científica Excel)", () => {
    expect(esNumeroDocumentoCobroValido("0,00E+00")).toBe(false);
  });
});

// La validación estricta original NO cambia (facturas DIAN siguen exigentes).
describe("validarFacturaCompleta (estricta, sin cambios para DIAN)", () => {
  it("numero corto '1' → inválida en modo estricto", () => {
    const r = validarFacturaCompleta({
      numero: "1",
      fecha: "2026-01-15",
      nit: "900123456",
      total: 100000,
      proveedor: "Proveedor SA",
    });
    expect(r.esValida).toBe(false);
  });
});
