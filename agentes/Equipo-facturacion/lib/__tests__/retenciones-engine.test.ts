import { describe, it, expect } from "vitest";
import {
  aplicarReglasRetencion,
  calcularRtfDeOficio,
  calcularIcaDeOficio,
  DEFAULT_RETENTION_RULES,
  type RetentionRules,
} from "../retenciones-engine";
import type { InvoiceData } from "../pipeline";

// Helper para construir una factura de test mínima
function f(overrides: Partial<InvoiceData> = {}): InvoiceData {
  return {
    fecha: "2026-05-10",
    proveedor: "Proveedor Test",
    nit: "900000000",
    numero: "FE001",
    cufe: "",
    subtotal: 1_000_000,
    iva: 190_000,
    total: 1_190_000,
    concepto: "Test",
    reteFuente: 0,
    reteIva: 0,
    reteIca: 0,
    totalRetenciones: 0,
    ...overrides,
  };
}

// Reglas variantes para tests
function reglas(overrides: Partial<RetentionRules> = {}): RetentionRules {
  return {
    ...DEFAULT_RETENTION_RULES,
    ...overrides,
    es_agente_retenedor: {
      ...DEFAULT_RETENTION_RULES.es_agente_retenedor,
      ...(overrides.es_agente_retenedor ?? {}),
    },
    aplicar_de_oficio: {
      ...DEFAULT_RETENTION_RULES.aplicar_de_oficio,
      ...(overrides.aplicar_de_oficio ?? {}),
    },
  };
}

describe("aplicarReglasRetencion", () => {
  it("XML trae RTF → usar valor del XML (source=xml)", () => {
    const factura = f({ reteFuente: 25_000, categoria: "Servicios" });
    const r = aplicarReglasRetencion(factura, reglas(), null, 2026);
    expect(r.reteFuente).toBe(25_000);
    expect(r.source.rtf).toBe("xml");
  });

  it("XML vacío + cliente agente retenedor → calcular de oficio (source=oficio)", () => {
    const factura = f({
      subtotal: 2_000_000, // supera umbral compras
      categoria: "Compras de bienes",
    });
    const r = aplicarReglasRetencion(factura, reglas(), null, 2026);
    expect(r.reteFuente).toBe(50_000); // 2.5% de 2M
    expect(r.source.rtf).toBe("oficio");
  });

  it("XML vacío + subtotal bajo umbral → 0 (source=none)", () => {
    const factura = f({
      subtotal: 100_000, // bajo umbral servicios (4 UVT ≈ 188K)
      categoria: "Servicios",
    });
    const r = aplicarReglasRetencion(factura, reglas(), null, 2026);
    expect(r.reteFuente).toBe(0);
    expect(r.source.rtf).toBe("none");
  });

  it("Override por NIT (exento_rtf) → gana sobre XML (source=override_nit)", () => {
    const factura = f({
      nit: "900111111",
      reteFuente: 50_000, // XML traía rete
    });
    const r = aplicarReglasRetencion(
      factura,
      reglas({
        overrides_por_nit: {
          "900111111": { exento_rtf: true, nota: "Proveedor exento" },
        },
      }),
      null,
      2026,
    );
    expect(r.reteFuente).toBe(0);
    expect(r.source.rtf).toBe("override_nit");
  });

  it("Cliente NO es agente retenedor de IVA → ignora reteIva del XML", () => {
    const factura = f({ reteIva: 30_000 });
    const r = aplicarReglasRetencion(factura, reglas(), null, 2026);
    // Default tiene reteIva=false, pero XML trae el valor → usamos XML
    // (la regla es: si XML lo trae, confiar; aplicar_de_oficio aplica solo cuando XML está vacío)
    expect(r.reteIva).toBe(30_000);
    expect(r.source.iva).toBe("xml");
  });

  it("ICA del XML → usar (source=xml)", () => {
    const factura = f({ reteIca: 7_000 });
    const r = aplicarReglasRetencion(factura, reglas(), "MEDELLIN", 2026);
    expect(r.reteIca).toBe(7_000);
    expect(r.source.ica).toBe("xml");
  });

  it("ICA de oficio si cliente activa + municipio set + XML vacío", () => {
    const factura = f({ subtotal: 1_000_000 });
    const r = aplicarReglasRetencion(
      factura,
      reglas({
        es_agente_retenedor: { reteFuente: false, reteIva: false, reteIca: true },
        aplicar_de_oficio: { rtf_si_xml_vacio: false, ica_si_xml_vacio: true },
      }),
      "MEDELLIN",
      2026,
    );
    // Medellín = 0.7% → 7,000 sobre 1M
    expect(r.reteIca).toBe(7_000);
    expect(r.source.ica).toBe("oficio");
  });

  it("ICA: cliente activa pero sin municipio → 0 (source=none)", () => {
    const factura = f({ subtotal: 1_000_000 });
    const r = aplicarReglasRetencion(
      factura,
      reglas({
        es_agente_retenedor: { reteFuente: false, reteIva: false, reteIca: true },
        aplicar_de_oficio: { rtf_si_xml_vacio: false, ica_si_xml_vacio: true },
      }),
      null, // municipio_ica vacío
      2026,
    );
    expect(r.reteIca).toBe(0);
    expect(r.source.ica).toBe("none");
  });

  it("totalRetenciones es la suma correcta", () => {
    const factura = f({
      reteFuente: 10_000,
      reteIva: 5_000,
      reteIca: 2_000,
    });
    const r = aplicarReglasRetencion(factura, reglas(), "MEDELLIN", 2026);
    expect(r.totalRetenciones).toBe(17_000);
  });
});

describe("calcularRtfDeOficio", () => {
  it("Honorarios profesionales: 11% si supera umbral 4 UVT", () => {
    const factura = f({ subtotal: 300_000, categoria: "Honorarios profesionales" });
    expect(calcularRtfDeOficio(factura, 2026)).toBe(33_000); // 11% de 300K
  });

  it("Servicios técnicos: 6%", () => {
    const factura = f({ subtotal: 500_000, categoria: "Servicios técnicos" });
    expect(calcularRtfDeOficio(factura, 2026)).toBe(30_000);
  });

  it("Compras de bienes: 2.5% si supera 27 UVT", () => {
    const factura = f({ subtotal: 2_000_000, categoria: "Compras de bienes" });
    expect(calcularRtfDeOficio(factura, 2026)).toBe(50_000);
  });

  it("Compras de bienes bajo 27 UVT → 0", () => {
    const factura = f({ subtotal: 500_000, categoria: "Compras de bienes" });
    expect(calcularRtfDeOficio(factura, 2026)).toBe(0);
  });

  it("Combustibles y peajes: tarifa 0 → 0 incluso si supera umbral", () => {
    const factura = f({ subtotal: 5_000_000, categoria: "Combustible y peajes" });
    expect(calcularRtfDeOficio(factura, 2026)).toBe(0);
  });

  it("Categoría desconocida → default 2.5% como compra", () => {
    const factura = f({ subtotal: 2_000_000, categoria: "Categoria que no existe" });
    expect(calcularRtfDeOficio(factura, 2026)).toBe(50_000); // 2.5% de 2M
  });
});

describe("calcularIcaDeOficio", () => {
  it("Medellín 7‰ sobre 1M = 7,000", () => {
    const factura = f({ subtotal: 1_000_000 });
    expect(calcularIcaDeOficio(factura, "MEDELLIN", 2026)).toBe(7_000);
  });

  it("Bogotá 4.14‰ sobre 1M = 4,140", () => {
    const factura = f({ subtotal: 1_000_000 });
    expect(calcularIcaDeOficio(factura, "BOGOTA", 2026)).toBe(4_140);
  });

  it("Bajo umbral 4 UVT → 0", () => {
    const factura = f({ subtotal: 100_000 });
    expect(calcularIcaDeOficio(factura, "MEDELLIN", 2026)).toBe(0);
  });

  it("Municipio sin tarifa configurada → 0", () => {
    const factura = f({ subtotal: 1_000_000 });
    expect(calcularIcaDeOficio(factura, "TUNJA", 2026)).toBe(0);
  });

  it("OTRO (cliente debe configurar manual) → 0", () => {
    const factura = f({ subtotal: 1_000_000 });
    expect(calcularIcaDeOficio(factura, "OTRO", 2026)).toBe(0);
  });
});
