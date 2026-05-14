export type RunStatus = "running" | "ok" | "fail" | "warn";
export type TriggeredBy = "cron" | "manual" | "rerun";

export interface Cliente {
  id: string;
  nombre: string;
  slug: string;
  activo: boolean;
  notas: string | null;
  created_at: string;
}

export interface Agente {
  id: string;
  nombre: string;
  descripcion: string | null;
  cron_default: string | null;
  activo: boolean;
}

export interface ClientAgent {
  cliente_id: string;
  agente_id: string;
  activo: boolean;
  config: Record<string, unknown>;
  activated_at: string;
}

export interface AgentRun {
  id: string;
  cliente_id: string;
  agente_id: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  triggered_by: TriggeredBy;
  summary: string | null;
  payload: unknown;
  error_message: string | null;
  error_stack: string | null;
  netlify_log_url: string | null;
}

export interface AgentEvent {
  id: string;
  run_id: string;
  cliente_id: string;
  agente_id: string;
  tipo: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/**
 * Validación 5 fuentes generada por el Reparador (Bloque B).
 * Vive en agent_runs.payload.validaciones[] del último run del reparador.
 */
export interface ValidacionClienteCliente {
  cliente_slug: string;
  mes: string; // "YYYY-MM"
  gmail: number;
  drive: number;
  sheet: number;
  events: number;
  todo_cuadra: boolean;
  discrepancias: string[];
}
