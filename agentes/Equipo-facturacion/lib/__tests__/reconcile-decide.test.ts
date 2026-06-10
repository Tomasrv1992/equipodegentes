import { describe, it, expect } from "vitest";
import { decide } from "../reconcile-decide";

const FACT = "facturasId";
const DESC = "descartadoId";

describe("decide — reconciliador de labels", () => {
  // Caso 1: histórico sin messageId con overlap → NO tocar (guarda de precedencia)
  // Este es el caso crítico que debe NO romper producción Dentilandia.
  it("histórico con overlap sin event → NO tocar (guarda de precedencia)", () => {
    const r = decide(
      "msg1",
      new Set(["msg1"]),         // F: tiene Facturas
      new Set(["msg1"]),         // D: tiene Descartado (overlap)
      new Set(),                  // esFactura: VACÍO (histórico sin backfill)
      new Set(["msg1"]),         // esDescartado: hay event de descarte
      FACT, DESC,
    );
    expect(r.add).toEqual([]);
    expect(r.remove).toEqual([]);
  });

  // Caso 2: post-backfill con overlap → aplicar Facturas, quitar Descartado
  it("messageId en esFactura + overlap → quitar Descartado", () => {
    const r = decide(
      "msg1",
      new Set(["msg1"]),         // F: tiene Facturas
      new Set(["msg1"]),         // D: tiene Descartado (overlap)
      new Set(["msg1"]),         // esFactura: YES post-backfill
      new Set(["msg1"]),         // esDescartado: tiene event descarte también
      FACT, DESC,
    );
    expect(r.add).toEqual([]);  // ya tiene Facturas
    expect(r.remove).toEqual([DESC]);
  });

  // Caso 3: factura perdió label Facturas, hay event → RECUPERAR
  // Camino de recuperación de los Protokimicas (solo en Descartado pero con event).
  it("solo Descartado pero esFactura YES → agregar Facturas + quitar Descartado", () => {
    const r = decide(
      "msg1",
      new Set(),                  // F: NO tiene Facturas
      new Set(["msg1"]),         // D: tiene Descartado
      new Set(["msg1"]),         // esFactura: YES
      new Set(),                  // esDescartado: vacío (la factura no fue descartada)
      FACT, DESC,
    );
    expect(r.add).toEqual([FACT]);
    expect(r.remove).toEqual([DESC]);
  });

  // Caso 4: descarte legítimo sin label aún → aplicar
  it("event descarte sin label aún → agregar Descartado", () => {
    const r = decide(
      "msg1",
      new Set(),                  // F: vacío
      new Set(),                  // D: vacío
      new Set(),                  // esFactura: vacío
      new Set(["msg1"]),         // esDescartado: tiene event descarte
      FACT, DESC,
    );
    expect(r.add).toEqual([DESC]);
    expect(r.remove).toEqual([]);
  });

  // Caso 5: huérfano (en Gmail pero no en events) → skip
  it("huérfano sin event → NO tocar", () => {
    const r = decide(
      "msg1",
      new Set(["msg1"]),         // F: tiene Facturas (label viejo)
      new Set(),                  // D: vacío
      new Set(),                  // esFactura: vacío (no hay event)
      new Set(),                  // esDescartado: vacío
      FACT, DESC,
    );
    expect(r.add).toEqual([]);
    expect(r.remove).toEqual([]);
  });

  // Caso 6 (bonus): solo en Facturas, esFactura YES → no-op (ya está bien)
  it("solo Facturas, esFactura YES → no-op", () => {
    const r = decide(
      "msg1",
      new Set(["msg1"]),
      new Set(),
      new Set(["msg1"]),
      new Set(),
      FACT, DESC,
    );
    expect(r.add).toEqual([]);
    expect(r.remove).toEqual([]);
  });

  // Caso 7 (bonus): factura recién procesada (post-backfill), no tiene labels aún
  it("nueva factura: esFactura YES sin labels → agregar Facturas", () => {
    const r = decide(
      "msg1",
      new Set(),
      new Set(),
      new Set(["msg1"]),
      new Set(),
      FACT, DESC,
    );
    expect(r.add).toEqual([FACT]);
    expect(r.remove).toEqual([]);
  });
});
