/**
 * Cálculos de métricas operacionales.
 *
 * IMPORTANTE: hay 2 fuentes de verdad:
 *
 * 1. **`agent_runs`** (1 fila por corrida). `payload = {procesadas, errores, saltadas}`.
 *    Para info de runs (status, errores, duration). Las funciones legacy
 *    (`totalProcesadas(runs)`, `aggByMonth(runs)`) suman los `procesadas` de cada run
 *    pero AGRUPAN POR FECHA DEL RUN — incorrecto para mostrar conteos por mes real.
 *
 * 2. **`agent_events`** tipo `factura_procesada` (1 fila por factura individual).
 *    `payload = {fecha, proveedor, total, ...}`. La fuente de verdad para conteos
 *    por mes/proveedor/categoría — agrupa por la fecha REAL de la factura.
 *
 * Para KPIs visibles al cliente (panel admin, email mensual, etc.) USAR `agent_events`.
 * Para info técnica (¿está corriendo?, ¿hubo errores?) usar `agent_runs`.
 */

import type { AgentRun, AgentEvent } from "../types";

/** Minutos que tarda un humano en procesar manualmente una factura DIAN. */
export const MINUTES_PER_FACTURA = 24;

export interface RunPayloadFacturacion {
  procesadas?: number;
  errores?: number;
  saltadas?: number;
}

/** Suma de facturas procesadas en runs OK/WARN. */
export function totalProcesadas(runs: AgentRun[]): number {
  let total = 0;
  for (const r of runs) {
    if (r.status === "fail" || r.status === "running") continue;
    const p = (r.payload as RunPayloadFacturacion | null)?.procesadas;
    if (typeof p === "number") total += p;
  }
  return total;
}

/** Filtra runs ocurridos en el mes actual (zona Bogota). */
export function runsThisMonth(runs: AgentRun[], reference: Date = new Date()): AgentRun[] {
  const refY = reference.getFullYear();
  const refM = reference.getMonth();
  return runs.filter((r) => {
    const d = new Date(r.started_at);
    return d.getFullYear() === refY && d.getMonth() === refM;
  });
}

/** Filtra runs en los últimos N días. */
export function runsLastDays(runs: AgentRun[], days: number, reference: Date = new Date()): AgentRun[] {
  const cutoff = reference.getTime() - days * 24 * 60 * 60 * 1000;
  return runs.filter((r) => new Date(r.started_at).getTime() >= cutoff);
}

/** Filtra runs ocurridos hoy (calendario, zona local del browser). */
export function runsToday(runs: AgentRun[], reference: Date = new Date()): AgentRun[] {
  const today = reference.toDateString();
  return runs.filter((r) => new Date(r.started_at).toDateString() === today);
}

/** Tiempo ahorrado en horas por procesado de N facturas. */
export function tiempoAhorradoHoras(facturas: number): number {
  return (facturas * MINUTES_PER_FACTURA) / 60;
}

/** Format pretty of hours: 5.5 → "5.5 h"; 0.4 → "24 min". */
export function formatHoras(horas: number): string {
  if (horas < 1) {
    const mins = Math.round(horas * 60);
    return `${mins}m`;
  }
  const rounded = Math.round(horas * 10) / 10;
  return `${rounded}h`;
}

/** Cantidad de errores en runs (status='fail'). */
export function totalErrores(runs: AgentRun[]): number {
  return runs.filter((r) => r.status === "fail").length;
}

/**
 * Agrupa runs por mes (clave: "YYYY-MM") con conteo de procesadas y errores.
 * Devuelve los últimos N meses, en orden cronológico ascendente.
 */
export interface MesAgg {
  key: string;       // "2026-05"
  label: string;     // "may"
  procesadas: number;
  errores: number;
  runs: number;
}

export function aggByMonth(runs: AgentRun[], lastNMonths = 6, reference: Date = new Date()): MesAgg[] {
  const meses: MesAgg[] = [];
  for (let i = lastNMonths - 1; i >= 0; i--) {
    const d = new Date(reference.getFullYear(), reference.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("es-CO", { month: "short" }).replace(".", "");
    meses.push({ key, label, procesadas: 0, errores: 0, runs: 0 });
  }

  for (const r of runs) {
    const d = new Date(r.started_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const target = meses.find((m) => m.key === key);
    if (!target) continue;
    target.runs++;
    if (r.status === "fail") target.errores++;
    const p = (r.payload as RunPayloadFacturacion | null)?.procesadas;
    if (typeof p === "number") target.procesadas += p;
  }

  return meses;
}

// ===== Helpers basados en agent_events (fuente de verdad por FECHA REAL) =====

interface FacturaEventPayload {
  fecha?: string;        // YYYY-MM-DD (fecha emisión factura)
  proveedor?: string;
  nit?: string;
  total?: number;
  categoria?: string;
}

/** Total de facturas procesadas (cuenta de events). */
export function totalFacturas(events: AgentEvent[]): number {
  return events.length;
}

/** Filtra events por fecha REAL (payload.fecha) en el mes en curso. */
export function facturasThisMonth(events: AgentEvent[], reference: Date = new Date()): AgentEvent[] {
  const refY = reference.getFullYear();
  const refM = reference.getMonth();
  return events.filter((ev) => {
    const fecha = (ev.payload as FacturaEventPayload | null)?.fecha;
    if (!fecha) return false;
    const d = new Date(fecha + "T00:00:00");
    return d.getFullYear() === refY && d.getMonth() === refM;
  });
}

/** Filtra events con fecha REAL en los últimos N días. */
export function facturasLastDays(events: AgentEvent[], days: number, reference: Date = new Date()): AgentEvent[] {
  const cutoff = new Date(reference);
  cutoff.setDate(cutoff.getDate() - days);
  cutoff.setHours(0, 0, 0, 0);
  return events.filter((ev) => {
    const fecha = (ev.payload as FacturaEventPayload | null)?.fecha;
    if (!fecha) return false;
    const d = new Date(fecha + "T00:00:00");
    return d.getTime() >= cutoff.getTime();
  });
}

/** Filtra events con fecha REAL = hoy. */
export function facturasToday(events: AgentEvent[], reference: Date = new Date()): AgentEvent[] {
  const today = reference.toDateString();
  return events.filter((ev) => {
    const fecha = (ev.payload as FacturaEventPayload | null)?.fecha;
    if (!fecha) return false;
    return new Date(fecha + "T00:00:00").toDateString() === today;
  });
}

/**
 * Suma de montos totales de facturas procesadas.
 * Devuelve en COP (asumiendo que payload.total ya está en COP enteros).
 */
export function totalMonto(events: AgentEvent[]): number {
  let total = 0;
  for (const ev of events) {
    const t = (ev.payload as FacturaEventPayload | null)?.total;
    if (typeof t === "number") total += t;
  }
  return total;
}

/**
 * Agrupa facturas (agent_events) por mes según FECHA REAL de la factura.
 * Devuelve los últimos N meses en orden cronológico ascendente.
 */
export function aggFacturasByMonth(
  events: AgentEvent[],
  lastNMonths = 6,
  reference: Date = new Date(),
): MesAgg[] {
  const meses: MesAgg[] = [];
  for (let i = lastNMonths - 1; i >= 0; i--) {
    const d = new Date(reference.getFullYear(), reference.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("es-CO", { month: "short" }).replace(".", "");
    meses.push({ key, label, procesadas: 0, errores: 0, runs: 0 });
  }

  for (const ev of events) {
    const fecha = (ev.payload as FacturaEventPayload | null)?.fecha;
    if (!fecha) continue;
    const key = fecha.slice(0, 7); // YYYY-MM
    const target = meses.find((m) => m.key === key);
    if (!target) continue;
    target.procesadas++;
  }

  return meses;
}

/** Top N proveedores por cantidad de facturas. */
export interface ProveedorAgg {
  proveedor: string;
  count: number;
  total: number;
}
export function topProveedores(events: AgentEvent[], topN = 3): ProveedorAgg[] {
  const map = new Map<string, ProveedorAgg>();
  for (const ev of events) {
    const p = ev.payload as FacturaEventPayload | null;
    const proveedor = p?.proveedor;
    if (!proveedor) continue;
    const existing = map.get(proveedor) ?? { proveedor, count: 0, total: 0 };
    existing.count++;
    existing.total += p?.total ?? 0;
    map.set(proveedor, existing);
  }
  return Array.from(map.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}
