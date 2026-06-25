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
  parseProveedorFromFilename,
  normProveedorCruce,
  clasificarDocSinProcesar,
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
  // Helpers: proveedor por defecto prefijado por lado (S-/D-) para que NO haya
  // match por proveedor accidental entre lados en los casos de cruce por numero.
  const S = (numero: string, proveedor = `S-${numero}`) => ({ numero, proveedor });
  const D = (numero: string, proveedor = `D-${numero}`) => ({ numero, proveedor });

  it("Sheet = Drive (mismos numeros normalizados) -> ok", () => {
    const r = cruzarMes({
      tab: "Enero",
      sheetDocs: [S("FE 001"), S("FE002")],
      driveDocs: [D("FE001"), D("FE 002")],
      gmailFacturasCount: 2,
    });
    expect(r.ok).toBe(true);
    expect(r.sheet_sin_drive).toEqual([]);
    expect(r.drive_sin_sheet).toEqual([]);
  });

  it("fila en Sheet sin PDF en Drive -> sheet_sin_drive, ok false", () => {
    const r = cruzarMes({
      tab: "Enero",
      sheetDocs: [S("FE001"), S("FE002")],
      driveDocs: [D("FE001")],
      gmailFacturasCount: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.sheet_sin_drive).toEqual(["FE2"]); // normalizado sin ceros a la izq
  });

  it("ceros a la izquierda NO generan huérfano: Sheet '846' = Drive '00846'", () => {
    const r = cruzarMes({
      tab: "Enero",
      sheetDocs: [S("846"), S("FE001")],
      driveDocs: [D("00846"), D("FE001")],
      gmailFacturasCount: 2,
    });
    expect(r.ok).toBe(true);
    expect(r.sheet_sin_drive).toEqual([]);
    expect(r.drive_sin_sheet).toEqual([]);
  });

  it("PDF en Drive sin fila en Sheet -> drive_sin_sheet, ok false", () => {
    const r = cruzarMes({
      tab: "Enero",
      sheetDocs: [S("FE001")],
      driveDocs: [D("FE001"), D("FE999")],
      gmailFacturasCount: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.drive_sin_sheet).toEqual(["FE999"]);
  });

  // --- Match por proveedor (CC con numero sintético: filename ≠ numero Sheet) ---
  it("CC con numero sintético se empareja por proveedor 1:1 -> ok, sin huérfano", () => {
    // Sheet usa "CC-202605-19e18514"; Drive conserva "sin número de consecutivo".
    const r = cruzarMes({
      tab: "Mayo",
      sheetDocs: [S("FE001", "Lab Ramírez"), S("CC-202605-19e18514", "Alvaro Hernán Ruiz Oviedo")],
      driveDocs: [D("FE001", "Lab Ramírez"), D("sin número de consecutivo", "Alvaro Hernan Ruiz Oviedo")],
      gmailFacturasCount: 2,
    });
    expect(r.ok).toBe(true);
    expect(r.sheet_sin_drive).toEqual([]);
    expect(r.drive_sin_sheet).toEqual([]);
  });

  it("NO empareja por proveedor si el mismo proveedor tiene 2 leftovers (ambiguo) -> huérfano", () => {
    const r = cruzarMes({
      tab: "Mayo",
      sheetDocs: [S("A", "Mismo Prov"), S("B", "Mismo Prov")],
      driveDocs: [D("C", "Mismo Prov")],
      gmailFacturasCount: 2,
    });
    expect(r.ok).toBe(false); // 2 en Sheet vs 1 en Drive del mismo prov: no se asume pareja
  });

  it("pérdida real (proveedor sin contraparte en Drive) sigue marcada -> huérfano", () => {
    // FD30000529 XML-only: fila en Sheet, NINGÚN archivo de ese proveedor en Drive.
    const r = cruzarMes({
      tab: "Marzo",
      sheetDocs: [S("FE001", "Otro Prov"), S("FD30000529", "Clínica XML Only")],
      driveDocs: [D("FE001", "Otro Prov")],
      gmailFacturasCount: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.sheet_sin_drive).toEqual(["FD30000529"]);
  });

  it("fila DIAN XML-only (tienePdf:false) NO es huérfano -> ok (es WARN aparte)", () => {
    const r = cruzarMes({
      tab: "Marzo",
      sheetDocs: [S("FE001"), { numero: "FD30000529", proveedor: "Clínica XML Only", tienePdf: false }],
      driveDocs: [D("FE001")],
      gmailFacturasCount: 2,
    });
    expect(r.ok).toBe(true);
    expect(r.sheet_sin_drive).toEqual([]);
  });

  it("Gmail != Sheet NO tumba ok (borde de mes) pero se reporta", () => {
    const r = cruzarMes({
      tab: "Enero",
      sheetDocs: [S("FE001")],
      driveDocs: [D("FE001")],
      gmailFacturasCount: 3,
    });
    expect(r.ok).toBe(true);
    expect(r.gmail_vs_sheet).toBe(2);
  });
});

describe("clasificarDocSinProcesar (completitud)", () => {
  const sheet = new Set(["7654", "FE100"]);
  it("CV / seguridad social sola -> ruido", () => {
    expect(clasificarDocSinProcesar("Fwd: Hoja de vida auxiliar", sheet).tipo).toBe("ruido");
    expect(clasificarDocSinProcesar("Fwd: SEGURIDAD SOCIAL Lina Maria", sheet).tipo).toBe("ruido");
  });
  it("nota crédito (NTC/NC) -> nota-credito (bien excluida)", () => {
    expect(clasificarDocSinProcesar("Fwd: 1040182652;Ruby;NTC00309;91;Ruby", sheet).tipo).toBe("nota-credito");
  });
  it("tipo DIAN 91/92 en el asunto (numero plano) -> nota-credito", () => {
    // Caso real JEISY: numero "97" plano pero tipo 91 = nota crédito.
    expect(clasificarDocSinProcesar("Fwd: 1152685817;JEISY;97;91;JEISY", sheet).tipo).toBe("nota-credito");
    expect(clasificarDocSinProcesar("Fwd: 900123456;PROV;123;92;PROV", sheet).tipo).toBe("nota-credito");
  });
  it("numero ya en el Sheet -> ya-en-sheet", () => {
    expect(clasificarDocSinProcesar("Fwd: 1040182652;Ruby;7654;01;Ruby", sheet).tipo).toBe("ya-en-sheet");
  });
  it("factura DIAN cuyo numero NO está en el Sheet -> falta", () => {
    const r = clasificarDocSinProcesar("Fwd: 890900608;EXITO;WE53314;03;EXITO", sheet);
    expect(r.tipo).toBe("falta");
    expect(r.numero).toBe("WE53314");
  });
  it("sin formato DIAN en el asunto -> revisar (CC no-DIAN, predial…)", () => {
    expect(clasificarDocSinProcesar("Fwd: CC Junio 2026 Maria Araque", sheet).tipo).toBe("revisar");
  });
});

describe("veredictoFinal", () => {
  it("facturas sin procesar > 0 -> ok false (gasto perdido)", () => {
    const v = veredictoFinal({
      problemasFila: [], duplicados: [], crucesMes: [], descartesSospechosos: 0, facturasSinProcesar: 3,
    });
    expect(v.ok).toBe(false);
    expect(v.facturas_sin_procesar).toBe(3);
  });
  it("0 HALT, 0 duplicados, 0 huerfanos -> ok true", () => {
    const v = veredictoFinal({
      problemasFila: [{ rowNumber: 2, codigo: "link-pdf-ausente", severidad: "WARN", mensaje: "" }],
      duplicados: [],
      crucesMes: [cruzarMes({ tab: "Enero", sheetDocs: [{ numero: "A", proveedor: "PA" }], driveDocs: [{ numero: "A", proveedor: "PA" }], gmailFacturasCount: 1 })],
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
    const cruce = cruzarMes({ tab: "Enero", sheetDocs: [{ numero: "A", proveedor: "PA" }, { numero: "B", proveedor: "PB" }], driveDocs: [{ numero: "A", proveedor: "PA" }], gmailFacturasCount: 2 });
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

describe("parseProveedorFromFilename", () => {
  it.each([
    ["FEL428843. Seguros De Vida.pdf", "Seguros De Vida"],
    ["sin número de consecutivo. Alvaro Hernan Ruiz Oviedo.pdf", "Alvaro Hernan Ruiz Oviedo"],
    ["CUENTA DE COBRO MAYO 2026. Catalina Manes Uribe.docx", "Catalina Manes Uribe"],
    ["Sin Separador.pdf", ""],
  ])("%s -> %s", (input, expected) => {
    expect(parseProveedorFromFilename(input)).toBe(expected);
  });
});

describe("normProveedorCruce", () => {
  it("ignora acentos, mayúsculas y sufijos legales", () => {
    expect(normProveedorCruce("María Isabel Araque")).toBe(normProveedorCruce("MARIA ISABEL ARAQUE"));
    expect(normProveedorCruce("B2chat SAS")).toBe(normProveedorCruce("B2CHAT S.A.S"));
    expect(normProveedorCruce("Alvaro Hernán Ruiz Oviedo")).toBe(normProveedorCruce("Alvaro Hernan Ruiz Oviedo"));
  });
  it("vacío -> vacío", () => {
    expect(normProveedorCruce("")).toBe("");
    expect(normProveedorCruce(null)).toBe("");
  });
});
