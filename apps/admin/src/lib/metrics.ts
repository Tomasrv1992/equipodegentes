/**
 * Cálculos de métricas operacionales sobre agent_runs.
 * Todos asumen que el `payload` de un run de facturación tiene shape:
 *   { procesadas: number, errores: number, saltadas: number }
 */

import type { AgentRun } from "../types";

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
