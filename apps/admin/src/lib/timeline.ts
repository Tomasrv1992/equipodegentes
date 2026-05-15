/** Helpers para visualizar runs como timeline horizontal (24h, 7d, etc.). */

import type { AgentRun, RunStatus } from "../types";

export type TimelineTickStatus = RunStatus | "empty";

export interface TimelineTick {
  hourOffset: number;       // 0 = ahora, 23 = hace 23h
  status: TimelineTickStatus;
  count: number;            // cuántos runs cayeron en esa hora
  runs: AgentRun[];
}

/**
 * Distribuye runs en buckets de 1 hora durante las últimas 24 horas.
 * Si una hora tiene varios runs, prevalece el peor estado: fail > warn > running > ok > empty.
 */
export function timelineLast24h(
  runs: AgentRun[],
  reference: Date = new Date(),
): TimelineTick[] {
  const HOUR = 60 * 60 * 1000;
  const buckets: TimelineTick[] = Array.from({ length: 24 }, (_, i) => ({
    hourOffset: 23 - i, // 0 = ahora (último), 23 = hace 23 horas (primero)
    status: "empty",
    count: 0,
    runs: [],
  }));

  const refTime = reference.getTime();
  for (const r of runs) {
    const t = new Date(r.started_at).getTime();
    const diffH = Math.floor((refTime - t) / HOUR);
    if (diffH < 0 || diffH >= 24) continue;
    const idx = 23 - diffH;
    const bucket = buckets[idx];
    bucket.count++;
    bucket.runs.push(r);
    bucket.status = worseStatus(bucket.status, r.status);
  }

  return buckets;
}

const STATUS_ORDER: TimelineTickStatus[] = ["empty", "ok", "running", "warn", "fail"];
function worseStatus(a: TimelineTickStatus, b: TimelineTickStatus): TimelineTickStatus {
  return STATUS_ORDER.indexOf(a) > STATUS_ORDER.indexOf(b) ? a : b;
}

/** Generates points for a sparkline of N days, value = count of OK runs that day. */
export interface SparkPoint {
  day: number; // 0..N-1
  value: number;
}

export function sparkRunsByDay(
  runs: AgentRun[],
  days = 14,
  reference: Date = new Date(),
): SparkPoint[] {
  const pts: SparkPoint[] = Array.from({ length: days }, (_, i) => ({ day: i, value: 0 }));
  const DAY = 24 * 60 * 60 * 1000;
  const refStart = new Date(reference);
  refStart.setHours(0, 0, 0, 0);

  for (const r of runs) {
    if (r.status === "fail" || r.status === "running") continue;
    const t = new Date(r.started_at).getTime();
    const diffD = Math.floor((refStart.getTime() - t) / DAY);
    if (diffD < 0 || diffD >= days) continue;
    pts[days - 1 - diffD].value++;
  }
  return pts;
}

/** Sparkline polyline points formatted for SVG (viewBox 0..100 / 0..32). */
export function sparkPolylinePoints(points: SparkPoint[]): string {
  if (points.length === 0) return "";
  const max = Math.max(1, ...points.map((p) => p.value));
  return points
    .map((p, i) => {
      const x = (i / Math.max(1, points.length - 1)) * 100;
      const y = 32 - (p.value / max) * 28 - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
