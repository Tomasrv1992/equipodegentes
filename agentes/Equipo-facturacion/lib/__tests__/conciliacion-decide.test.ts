import { describe, it, expect } from "vitest";
import {
  conciliarMes,
  soloEnA,
  esMotivoLegitimo,
  esRemitenteGasto,
  cuadrarPorDesenlace,
  type CuadrePorDesenlaceInput,
} from "../conciliacion-decide";

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

describe("esMotivoLegitimo — motivos de descarte reconocidos", () => {
  it.each([
    "planilla-ss-tercero (titular 900123 ≠ cliente 800456)",
    "pre-filter-subject (oferta black friday)",
    "pre-filter-sender (newsletter@acme.com)",
    "pdf-no-es-factura (LLM: recibo)",
    "docx-no-es-factura (LLM)",
    "fecha-año-anterior (2025-12-01 < 2026)",
    "pdf-fecha-año-anterior (2025-11 < 2026)",
    "factura-invalida: sin NIT",
    "pdf-invalido: total=0",
    "docx-invalida: numero vacio",
    "pdf-baja-confianza (0.20): ruido",
    "docx-sin-indicadores-factura",
    "pdf-sin-texto-extraible",
    "sin-zip",
    "zip-sin-xml",
    "zip-no-procesable: bad central directory",
    "no-es-factura-dian",
    "dian-sin-numero (XML malformado)",
    "pdf-self-emitted (cliente es emisor)",
    "pdf-sin-api-key (configurar ANTHROPIC_API_KEY)",
    "dup: DENTILANDIA FE1 (ya en 2026-01)",
    "guard-emergencia: ACME FE9",
  ])("legítimo: %s", (m) => {
    expect(esMotivoLegitimo(m)).toBe(true);
  });

  it.each(["constraint_unique_bd", "algo-raro-nuevo", "", "error-desconocido"])(
    "NO legítimo: %s",
    (m) => {
      expect(esMotivoLegitimo(m)).toBe(false);
    },
  );
});

describe("esRemitenteGasto — remitentes de gasto (recibos de plataforma)", () => {
  it.each([
    "billing@anthropic.com",
    "Google Cloud <payments-noreply@google.com>",
    "invoice+statements@stripe.com",
    "aws-receivables@amazon.com",
    "Meta Platforms",
    "receipts@notion.so",
  ])("gasto: %s", (s) => {
    expect(esRemitenteGasto(s)).toBe(true);
  });

  it.each(["boletin@proveedorlocal.com", "ventas@ferreteria.co", "", null, undefined])(
    "NO gasto: %s",
    (s) => {
      expect(esRemitenteGasto(s as any)).toBe(false);
    },
  );
});

describe("cuadrarPorDesenlace — clasificación 1-a-1 por messageId", () => {
  const base: CuadrePorDesenlaceInput = {
    gmailFacturasIds: [],
    gmailDescartadoIds: [],
    gmailSinLabelIds: [],
    eventProcesadaIds: [],
    bdProcesadaIds: [],
    descartadoMotivoById: {},
    bloqueadoBdIds: [],
    numeroByMessageId: {},
    sheetNumeros: [],
    driveNumeros: [],
  };

  it("cuadre perfecto: todo PROCESADA_OK", () => {
    const r = cuadrarPorDesenlace({
      ...base,
      gmailFacturasIds: ["m1", "m2"],
      eventProcesadaIds: ["m1", "m2"],
      numeroByMessageId: { m1: "FE1", m2: "FE2" },
      sheetNumeros: ["FE1", "FE2"],
      driveNumeros: ["FE1", "FE2"],
    });
    expect(r.cuadra).toBe(true);
    expect(r.conteos.procesadas_ok).toBe(2);
    expect(r.conteos.procesadas_incompletas).toBe(0);
    expect(r.incompletas).toEqual([]);
    expect(r.perdidas_reales).toEqual([]);
  });

  it("etiquetada pero FALTA EN DRIVE -> PROCESADA_INCOMPLETA", () => {
    const r = cuadrarPorDesenlace({
      ...base,
      gmailFacturasIds: ["m1"],
      eventProcesadaIds: ["m1"],
      numeroByMessageId: { m1: "FE1" },
      sheetNumeros: ["FE1"],
      driveNumeros: [], // no quedó el PDF
    });
    expect(r.conteos.procesadas_incompletas).toBe(1);
    expect(r.incompletas).toEqual([
      { messageId: "m1", numero: "FE1", falta_en_sheet: false, falta_en_drive: true },
    ]);
    expect(r.cuadra).toBe(true);
  });

  it("etiquetada pero FALTA EN SHEET -> PROCESADA_INCOMPLETA", () => {
    const r = cuadrarPorDesenlace({
      ...base,
      gmailFacturasIds: ["m1"],
      eventProcesadaIds: ["m1"],
      numeroByMessageId: { m1: "FE1" },
      sheetNumeros: [], // no quedó la fila
      driveNumeros: ["FE1"],
    });
    expect(r.incompletas[0]).toEqual({
      messageId: "m1",
      numero: "FE1",
      falta_en_sheet: true,
      falta_en_drive: false,
    });
  });

  it("procesada SIN numero resoluble -> INCOMPLETA (no verificable)", () => {
    const r = cuadrarPorDesenlace({
      ...base,
      gmailFacturasIds: ["m1"],
      eventProcesadaIds: ["m1"],
      numeroByMessageId: {}, // sin numero
      sheetNumeros: ["FE1"],
      driveNumeros: ["FE1"],
    });
    expect(r.conteos.procesadas_incompletas).toBe(1);
    expect(r.incompletas[0]).toMatchObject({
      messageId: "m1",
      numero: "",
      falta_en_sheet: true,
      falta_en_drive: true,
    });
  });

  it("etiquetada Facturas SIN evento ni BD -> PERDIDA_REAL origen Facturas", () => {
    const r = cuadrarPorDesenlace({ ...base, gmailFacturasIds: ["m1"] });
    expect(r.conteos.perdidas_reales).toBe(1);
    expect(r.perdidas_reales).toEqual([{ messageId: "m1", origen: "Facturas" }]);
  });

  it("en INBOX sin label y sin evento -> PERDIDA_REAL origen sin-label", () => {
    const r = cuadrarPorDesenlace({ ...base, gmailSinLabelIds: ["m9"] });
    expect(r.perdidas_reales).toEqual([{ messageId: "m9", origen: "sin-label" }]);
  });

  it("descarte con motivo desconocido -> DESCARTE_SOSPECHOSO", () => {
    const r = cuadrarPorDesenlace({
      ...base,
      gmailDescartadoIds: ["m1"],
      descartadoMotivoById: { m1: "constraint_unique_bd" },
    });
    expect(r.conteos.descartes_sospechosos).toBe(1);
    expect(r.descartes_sospechosos).toEqual([
      { messageId: "m1", motivo: "constraint_unique_bd" },
    ]);
  });

  it("duplicado bloqueado BD -> cuenta como procesada, NO pérdida", () => {
    const r = cuadrarPorDesenlace({
      ...base,
      gmailDescartadoIds: ["m1"],
      bloqueadoBdIds: ["m1"],
      numeroByMessageId: { m1: "FE1" },
      sheetNumeros: ["FE1"],
      driveNumeros: ["FE1"],
    });
    expect(r.conteos.procesadas_ok).toBe(1);
    expect(r.conteos.perdidas_reales).toBe(0);
  });

  it("PROCESADA gana sobre email_descartado viejo (re-run)", () => {
    const r = cuadrarPorDesenlace({
      ...base,
      gmailFacturasIds: ["m1"],
      eventProcesadaIds: ["m1"],
      descartadoMotivoById: { m1: "pre-filter-subject (viejo)" },
      numeroByMessageId: { m1: "FE1" },
      sheetNumeros: ["FE1"],
      driveNumeros: ["FE1"],
    });
    expect(r.clasificacion["m1"].categoria).toBe("PROCESADA_OK");
    expect(r.conteos.descartes_legitimos).toBe(0);
  });

  it("BD refuerza Gmail: sin evento pero en facturas_registro -> PROCESADA", () => {
    const r = cuadrarPorDesenlace({
      ...base,
      gmailFacturasIds: ["m1"],
      bdProcesadaIds: ["m1"],
      numeroByMessageId: { m1: "FE1" },
      sheetNumeros: ["FE1"],
      driveNumeros: ["FE1"],
    });
    expect(r.clasificacion["m1"].categoria).toBe("PROCESADA_OK");
  });

  it("cuenta de cobro docx etiquetada Facturas y completa -> PROCESADA_OK", () => {
    const r = cuadrarPorDesenlace({
      ...base,
      gmailFacturasIds: ["mcc"],
      eventProcesadaIds: ["mcc"],
      numeroByMessageId: { mcc: "CC-014" },
      sheetNumeros: ["CC-014"],
      driveNumeros: ["CC-014"],
    });
    expect(r.conteos.procesadas_ok).toBe(1);
    expect(r.clasificacion["mcc"].categoria).toBe("PROCESADA_OK");
  });

  it("driveLink VACÍO (DIAN solo-XML) -> PROCESADA_OK aunque no haya PDF en Drive", () => {
    const r = cuadrarPorDesenlace({
      ...base,
      gmailFacturasIds: ["m1"],
      eventProcesadaIds: ["m1"],
      numeroByMessageId: { m1: "FE1" },
      sheetNumeros: ["FE1"],
      driveNumeros: [], // no hay PDF en Drive...
      driveLinkByMessageId: { m1: "" }, // ...pero el evento dice que nunca hubo PDF
    });
    expect(r.conteos.procesadas_ok).toBe(1);
    expect(r.conteos.procesadas_incompletas).toBe(0);
    expect(r.incompletas).toEqual([]);
  });

  it("driveLink LLENO pero PDF ausente en Drive -> PROCESADA_INCOMPLETA (pérdida real)", () => {
    const r = cuadrarPorDesenlace({
      ...base,
      gmailFacturasIds: ["m1"],
      eventProcesadaIds: ["m1"],
      numeroByMessageId: { m1: "FE1" },
      sheetNumeros: ["FE1"],
      driveNumeros: [], // PDF ausente
      driveLinkByMessageId: { m1: "https://drive.google.com/file/d/abc" }, // debía existir
    });
    expect(r.conteos.procesadas_incompletas).toBe(1);
    expect(r.incompletas[0]).toMatchObject({ messageId: "m1", falta_en_drive: true });
  });

  it("recibo de plataforma descartado como 'no es factura' -> SOSPECHOSO, no legítimo", () => {
    const r = cuadrarPorDesenlace({
      ...base,
      gmailDescartadoIds: ["m1"],
      descartadoMotivoById: { m1: "pdf-no-es-factura (LLM: recibo)" },
      senderByMessageId: { m1: "billing@anthropic.com" },
    });
    expect(r.conteos.descartes_sospechosos).toBe(1);
    expect(r.conteos.descartes_legitimos).toBe(0);
    expect(r.descartes_sospechosos).toEqual([
      { messageId: "m1", motivo: "pdf-no-es-factura (LLM: recibo)" },
    ]);
  });

  it("mismo motivo pero remitente NO-plataforma -> DESCARTE_LEGITIMO", () => {
    const r = cuadrarPorDesenlace({
      ...base,
      gmailDescartadoIds: ["m1"],
      descartadoMotivoById: { m1: "pdf-no-es-factura (LLM: newsletter)" },
      senderByMessageId: { m1: "boletin@proveedorlocal.com" },
    });
    expect(r.conteos.descartes_legitimos).toBe(1);
    expect(r.conteos.descartes_sospechosos).toBe(0);
  });

  it("invariante: universo === Σ conteos y cada messageId clasificado 1 sola vez", () => {
    const r = cuadrarPorDesenlace({
      ...base,
      gmailFacturasIds: ["m1", "m2", "m3"],
      gmailDescartadoIds: ["m4", "m5"],
      gmailSinLabelIds: ["m6"],
      eventProcesadaIds: ["m1", "m2"],
      bloqueadoBdIds: ["m3"],
      descartadoMotivoById: {
        m4: "planilla-ss-tercero (titular X)",
        m5: "motivo-raro",
      },
      numeroByMessageId: { m1: "FE1", m2: "FE2", m3: "FE3" },
      sheetNumeros: ["FE1", "FE2", "FE3"],
      driveNumeros: ["FE1", "FE3"], // FE2 falta en Drive -> m2 incompleta
    });
    const c = r.conteos;
    const suma =
      c.procesadas_ok +
      c.procesadas_incompletas +
      c.descartes_legitimos +
      c.descartes_sospechosos +
      c.perdidas_reales;
    expect(r.universo).toBe(6);
    expect(suma).toBe(6);
    expect(r.cuadra).toBe(true);
    expect(Object.keys(r.clasificacion).sort()).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
    ]);
    // desglose esperado
    expect(c.procesadas_ok).toBe(2); // m1, m3
    expect(c.procesadas_incompletas).toBe(1); // m2 (falta drive)
    expect(c.descartes_legitimos).toBe(1); // m4
    expect(c.descartes_sospechosos).toBe(1); // m5
    expect(c.perdidas_reales).toBe(1); // m6
  });
});
