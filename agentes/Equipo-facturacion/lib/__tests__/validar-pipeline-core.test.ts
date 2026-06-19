import { describe, it, expect } from "vitest";
import {
  COL,
  normalizeNumero,
  numeroSinCerosIzq,
  parseMonto,
  pareceNumeroDocumento,
  validarFila,
  claveDedup,
  detectarDuplicados,
  cruzarMes,
  veredictoFinal,
  parseNumeroFromFilename,
  type FilaRef,
} from "../validar-pipeline-core";

// Helper: construye una fila A:M sana y permite overrides por índice de columna.
function filaSana(over: Partial<Record<number, any>> = {}): any[] {
  const base: any[] = [
    "2026-01-15", // A Fecha
    "Acme SAS", // B Proveedor
    "900123456", // C NIT
    "FE1234", // D # Documento
    100000, // E Subtotal
    19000, // F IVA
    0, // G ReteFuente
    0, // H ReteIVA
    0, // I ReteICA
    119000, // J Total a Pagar
    "Servicios", // K Categoria
    "5135", // L Cuenta PYG
    "https://drive.google.com/file/d/x", // M Link PDF
  ];
  for (const [k, v] of Object.entries(over)) base[Number(k)] = v;
  return base;
}

describe("normalizeNumero", () => {
  it.each([
    ["FE 001", "FE001"],
    ["FE-001", "FE001"],
    ["fe.001", "FE001"],
    ["  FE001 ", "FE001"],
    ["# 1234", "1234"],
    ["SETP/990", "SETP990"],
    ["", ""],
    [null, ""],
    [undefined, ""],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeNumero(input as any)).toBe(expected);
  });

  it("dos numeros que difieren solo en separadores normalizan igual", () => {
    expect(normalizeNumero("FE 001")).toBe(normalizeNumero("FE-001"));
  });
});

describe("numeroSinCerosIzq", () => {
  it.each([
    ["FE0001", "FE1"],
    ["00012", "12"],
    ["ABC", "ABC"],
    ["FE10", "FE10"],
    ["000", ""],
  ])("%s -> %s", (input, expected) => {
    expect(numeroSinCerosIzq(input)).toBe(expected);
  });
});

describe("parseMonto", () => {
  it("number JS real -> esNumero true", () => {
    expect(parseMonto(119000)).toEqual({ valor: 119000, esNumero: true, crudo: 119000 });
  });
  it("string numerica -> esNumero false (TEXTO)", () => {
    const r = parseMonto("119000");
    expect(r.valor).toBe(119000);
    expect(r.esNumero).toBe(false);
  });
  it("formato COP con puntos de miles y coma decimal", () => {
    expect(parseMonto("1.234.567,89").valor).toBeCloseTo(1234567.89, 2);
  });
  it("formato con simbolo $ y espacios", () => {
    expect(parseMonto("$ 1.234").valor).toBe(1234);
  });
  it("solo coma decimal", () => {
    expect(parseMonto("1234,56").valor).toBeCloseTo(1234.56, 2);
  });
  it("vacio / null -> valor null", () => {
    expect(parseMonto("").valor).toBeNull();
    expect(parseMonto(null).valor).toBeNull();
  });
  it("texto no numerico -> valor null", () => {
    expect(parseMonto("FE1234").valor).toBeNull();
  });
});

describe("pareceNumeroDocumento", () => {
  it.each(["FE1234", "FEL428843", "CC-014", "SETP990", "12345"])("parece numero: %s", (s) => {
    expect(pareceNumeroDocumento(s)).toBe(true);
  });
  it("vacio -> false", () => {
    expect(pareceNumeroDocumento("")).toBe(false);
  });
  it("entero largo SÍ es numero doc válido (ej SODIMAC 13 dígitos) — no se descarta por longitud", () => {
    expect(pareceNumeroDocumento("1234567890123")).toBe(true);
    expect(pareceNumeroDocumento("4009100475683")).toBe(true);
  });
  it("formato de MONTO ($ o miles agrupados) NO parece numero doc", () => {
    expect(pareceNumeroDocumento("$1.234.567")).toBe(false);
    expect(pareceNumeroDocumento("1.234.567")).toBe(false);
    expect(pareceNumeroDocumento("1,234,567")).toBe(false);
  });
});

describe("validarFila — alineacion + campos obligatorios", () => {
  it("fila sana -> sin HALT (a lo sumo WARNs benignos)", () => {
    const probs = validarFila(filaSana(), 2);
    expect(probs.filter((p) => p.severidad === "HALT")).toEqual([]);
  });

  it("# Documento ausente (col D) -> HALT numero-ausente", () => {
    const probs = validarFila(filaSana({ [COL.NUMERO]: "" }), 5);
    expect(probs.some((p) => p.codigo === "numero-ausente" && p.severidad === "HALT")).toBe(true);
  });

  it("fecha mal formateada -> HALT fecha-formato", () => {
    const probs = validarFila(filaSana({ [COL.FECHA]: "15/01/2026" }), 3);
    expect(probs.some((p) => p.codigo === "fecha-formato" && p.severidad === "HALT")).toBe(true);
  });

  it("total no numerico -> HALT total-no-numerico", () => {
    const probs = validarFila(filaSana({ [COL.TOTAL]: "pendiente" }), 4);
    expect(probs.some((p) => p.codigo === "total-no-numerico" && p.severidad === "HALT")).toBe(true);
  });

  it("total como TEXTO -> WARN total-como-texto", () => {
    const probs = validarFila(filaSana({ [COL.TOTAL]: "119000" }), 4);
    expect(probs.some((p) => p.codigo === "total-como-texto" && p.severidad === "WARN")).toBe(true);
  });

  it("columnas corridas: monto cayo en col D (#Documento) -> HALT", () => {
    // numero contiene un monto con separadores -> no parece numero doc.
    const probs = validarFila(filaSana({ [COL.NUMERO]: "1.234.567" }), 7);
    expect(probs.some((p) => p.codigo === "numero-parece-monto" && p.severidad === "HALT")).toBe(true);
  });

  it("link PDF ausente -> WARN (no HALT: puede ser DIAN solo-XML)", () => {
    const probs = validarFila(filaSana({ [COL.LINK_PDF]: "" }), 8);
    const link = probs.find((p) => p.codigo === "link-pdf-ausente");
    expect(link?.severidad).toBe("WARN");
    expect(probs.some((p) => p.severidad === "HALT")).toBe(false);
  });

  it("total no cuadra con subtotal+iva-retenciones -> WARN total-no-cuadra", () => {
    const probs = validarFila(filaSana({ [COL.TOTAL]: 999999 }), 9);
    expect(probs.some((p) => p.codigo === "total-no-cuadra" && p.severidad === "WARN")).toBe(true);
  });

  it("total cuadra con retenciones aplicadas -> sin total-no-cuadra", () => {
    // 100000 + 19000 - 2500(rtf) = 116500
    const probs = validarFila(
      filaSana({ [COL.RETEFUENTE]: 2500, [COL.TOTAL]: 116500 }),
      10,
    );
    expect(probs.some((p) => p.codigo === "total-no-cuadra")).toBe(false);
  });

  it("fila completamente vacia -> LOG fila-vacia, sin HALT", () => {
    const probs = validarFila(["", "", "", "", "", "", "", "", "", "", "", "", ""], 99);
    expect(probs).toHaveLength(1);
    expect(probs[0]).toMatchObject({ codigo: "fila-vacia", severidad: "LOG" });
  });
});

describe("claveDedup + detectarDuplicados", () => {
  it("mismo numero con distinto formato + mismo NIT -> mismo grupo", () => {
    const filas: FilaRef[] = [
      { tab: "Enero", rowNumber: 2, numero: "FE 001", nit: "900123456", proveedor: "Acme" },
      { tab: "Febrero", rowNumber: 5, numero: "FE-001", nit: "900.123.456", proveedor: "Acme SAS" },
    ];
    const grupos = detectarDuplicados(filas);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].ocurrencias).toHaveLength(2);
    expect(grupos[0].numeroNorm).toBe("FE001");
  });

  it("mismo numero pero proveedores/NIT distintos -> NO es duplicado", () => {
    const filas: FilaRef[] = [
      { tab: "Enero", rowNumber: 2, numero: "001", nit: "900111", proveedor: "Acme" },
      { tab: "Enero", rowNumber: 3, numero: "001", nit: "900222", proveedor: "Beta" },
    ];
    expect(detectarDuplicados(filas)).toEqual([]);
  });

  it("sin NIT cae a proveedor normalizado", () => {
    const filas: FilaRef[] = [
      { tab: "Enero", rowNumber: 2, numero: "CC-9", nit: "", proveedor: "Juan Pérez" },
      { tab: "Enero", rowNumber: 8, numero: "CC9", nit: "", proveedor: "JUAN PEREZ" },
    ];
    const grupos = detectarDuplicados(filas);
    expect(grupos).toHaveLength(1);
  });

  it("filas sin numero se ignoran (no rompen dedup)", () => {
    const filas: FilaRef[] = [
      { tab: "Enero", rowNumber: 2, numero: "", nit: "900111", proveedor: "Acme" },
      { tab: "Enero", rowNumber: 3, numero: "", nit: "900111", proveedor: "Acme" },
    ];
    expect(detectarDuplicados(filas)).toEqual([]);
  });

  it("3 ocurrencias del mismo numero -> un grupo con 3", () => {
    const f = (rn: number): FilaRef => ({ tab: "Enero", rowNumber: rn, numero: "FE7", nit: "900", proveedor: "X" });
    const grupos = detectarDuplicados([f(2), f(3), f(4)]);
    expect(grupos[0].ocurrencias).toHaveLength(3);
  });
});

describe("cruzarMes — Sheet ⇄ Drive por conjunto", () => {
  it("Sheet = Drive (mismos numeros normalizados) -> ok", () => {
    const r = cruzarMes({
      tab: "Enero",
      sheetNumeros: ["FE 001", "FE002"],
      driveNumeros: ["FE001", "FE 002"],
      gmailFacturasCount: 2,
    });
    expect(r.ok).toBe(true);
    expect(r.sheet_sin_drive).toEqual([]);
    expect(r.drive_sin_sheet).toEqual([]);
  });

  it("fila en Sheet sin PDF en Drive -> sheet_sin_drive, ok false", () => {
    const r = cruzarMes({
      tab: "Enero",
      sheetNumeros: ["FE001", "FE002"],
      driveNumeros: ["FE001"],
      gmailFacturasCount: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.sheet_sin_drive).toEqual(["FE2"]); // normalizado sin ceros a la izq
  });

  it("ceros a la izquierda NO generan huérfano: Sheet '846' = Drive '00846'", () => {
    const r = cruzarMes({
      tab: "Enero",
      sheetNumeros: ["846", "FE001"],
      driveNumeros: ["00846", "FE001"],
      gmailFacturasCount: 2,
    });
    expect(r.ok).toBe(true);
    expect(r.sheet_sin_drive).toEqual([]);
    expect(r.drive_sin_sheet).toEqual([]);
  });

  it("PDF en Drive sin fila en Sheet -> drive_sin_sheet, ok false", () => {
    const r = cruzarMes({
      tab: "Enero",
      sheetNumeros: ["FE001"],
      driveNumeros: ["FE001", "FE999"],
      gmailFacturasCount: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.drive_sin_sheet).toEqual(["FE999"]);
  });

  it("Gmail != Sheet NO tumba ok (borde de mes) pero se reporta", () => {
    const r = cruzarMes({
      tab: "Enero",
      sheetNumeros: ["FE001"],
      driveNumeros: ["FE001"],
      gmailFacturasCount: 3,
    });
    expect(r.ok).toBe(true);
    expect(r.gmail_vs_sheet).toBe(2);
  });
});

describe("veredictoFinal", () => {
  it("0 HALT, 0 duplicados, 0 huerfanos -> ok true", () => {
    const v = veredictoFinal({
      problemasFila: [{ rowNumber: 2, codigo: "link-pdf-ausente", severidad: "WARN", mensaje: "" }],
      duplicados: [],
      crucesMes: [cruzarMes({ tab: "Enero", sheetNumeros: ["A"], driveNumeros: ["A"], gmailFacturasCount: 1 })],
      descartesSospechosos: 0,
    });
    expect(v.ok).toBe(true);
    expect(v.warns).toBe(1);
  });

  it("un HALT -> ok false", () => {
    const v = veredictoFinal({
      problemasFila: [{ rowNumber: 2, codigo: "numero-ausente", severidad: "HALT", mensaje: "" }],
      duplicados: [],
      crucesMes: [],
      descartesSospechosos: 0,
    });
    expect(v.ok).toBe(false);
    expect(v.halts).toBe(1);
  });

  it("un duplicado -> ok false", () => {
    const v = veredictoFinal({
      problemasFila: [],
      duplicados: [{ key: "FE1|900", numeroNorm: "FE1", ocurrencias: [] as any }],
      crucesMes: [],
      descartesSospechosos: 0,
    });
    expect(v.ok).toBe(false);
  });

  it("mes con huerfanos -> ok false", () => {
    const cruce = cruzarMes({ tab: "Enero", sheetNumeros: ["A", "B"], driveNumeros: ["A"], gmailFacturasCount: 2 });
    const v = veredictoFinal({ problemasFila: [], duplicados: [], crucesMes: [cruce], descartesSospechosos: 0 });
    expect(v.ok).toBe(false);
    expect(v.meses_con_huerfanos).toBe(1);
  });

  it("descartes sospechosos NO tumban ok pero se cuentan", () => {
    const v = veredictoFinal({ problemasFila: [], duplicados: [], crucesMes: [], descartesSospechosos: 4 });
    expect(v.ok).toBe(true);
    expect(v.descartes_sospechosos).toBe(4);
  });
});

describe("parseNumeroFromFilename", () => {
  it.each([
    ["FEL428843. Seguros De Vida.pdf", "FEL428843"],
    ["CC-014. Juan Perez.pdf", "CC-014"],
    ["Sin Proveedor.pdf", null],
    ["", null],
  ])("%s -> %s", (input, expected) => {
    expect(parseNumeroFromFilename(input)).toBe(expected);
  });
});
