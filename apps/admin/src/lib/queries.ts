import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";
import type { Cliente, Agente, AgentRun, ClientAgent, AgentEvent } from "../types";

export function useClientAgents() {
  return useQuery({
    queryKey: ["client-agents"],
    queryFn: async (): Promise<ClientAgent[]> => {
      const { data, error } = await supabase
        .from("client_agents")
        .select("*");
      if (error) throw error;
      return data as ClientAgent[];
    },
  });
}

export function useClientes() {
  return useQuery({
    queryKey: ["clientes"],
    queryFn: async (): Promise<Cliente[]> => {
      // Trae TODOS los clientes (activos + inactivos). El filtrado por estado
      // se hace en el frontend (filtros del panel /clientes).
      const { data, error } = await supabase
        .from("clientes")
        .select("*")
        .order("nombre");
      if (error) throw error;
      return data as Cliente[];
    },
  });
}

export function useAgentes() {
  return useQuery({
    queryKey: ["agentes"],
    queryFn: async (): Promise<Agente[]> => {
      const { data, error } = await supabase
        .from("agentes")
        .select("*")
        .eq("activo", true)
        .order("nombre");
      if (error) throw error;
      return data as Agente[];
    },
  });
}

export function useLatestRuns() {
  return useQuery({
    queryKey: ["latest-runs"],
    queryFn: async (): Promise<AgentRun[]> => {
      // AUDIT 2026-05-13: limit subido de 200 a 1000.
      // Con 10 clientes × 13 runs/día (multi-pass + 4 admin) ≈ 130 runs/día.
      // 200 cubre solo ~1.5 días. Con 1000 cubrimos 7+ días para /operacion + /agentes.
      const { data, error } = await supabase
        .from("agent_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return data as AgentRun[];
    },
  });
}

export function useRun(id: string) {
  return useQuery({
    queryKey: ["run", id],
    enabled: !!id,
    queryFn: async (): Promise<AgentRun> => {
      const { data, error } = await supabase
        .from("agent_runs")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data as AgentRun;
    },
  });
}

/**
 * Trae todos los agent_events tipo 'factura_procesada' del cliente.
 * Estos events son la fuente de verdad para conteos por fecha real
 * (no por fecha del run).
 */
/**
 * Trae TODOS los events del cliente paginando en bloques de 1000.
 * AUDIT 2026-05-13: si un cliente supera 1000 events (Freshco con 1098,
 * Dentilandia con 610), la versión anterior con limit(1000) truncaba.
 * Ahora pagina hasta 50_000 (hard ceiling).
 */
export function useFacturasByCliente(clienteId: string) {
  return useQuery({
    queryKey: ["facturas-cliente", clienteId],
    enabled: !!clienteId,
    queryFn: async (): Promise<AgentEvent[]> => {
      const PAGE_SIZE = 1000;
      const HARD_CEILING = 50_000;
      const all: AgentEvent[] = [];
      let from = 0;
      while (from < HARD_CEILING) {
        const { data, error } = await supabase
          .from("agent_events")
          .select("*")
          .eq("cliente_id", clienteId)
          .eq("tipo", "factura_procesada")
          .order("created_at", { ascending: false })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        const batch = (data ?? []) as AgentEvent[];
        all.push(...batch);
        if (batch.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      return all;
    },
    // Cache 5 min — events cambian solo con runs del cron/retrigger
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });
}

/**
 * Trae todos los agent_events tipo 'factura_procesada' del agente cross-cliente.
 * Útil para vista global del agente.
 */
/**
 * Trae TODOS los events del agente paginando.
 * AUDIT 2026-05-13: paginación para no truncar con +1k events.
 */
export function useFacturasByAgente(agenteId: string) {
  return useQuery({
    queryKey: ["facturas-agente", agenteId],
    enabled: !!agenteId,
    queryFn: async (): Promise<AgentEvent[]> => {
      const PAGE_SIZE = 1000;
      const HARD_CEILING = 50_000;
      const all: AgentEvent[] = [];
      let from = 0;
      while (from < HARD_CEILING) {
        const { data, error } = await supabase
          .from("agent_events")
          .select("*")
          .eq("agente_id", agenteId)
          .eq("tipo", "factura_procesada")
          .order("created_at", { ascending: false })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        const batch = (data ?? []) as AgentEvent[];
        all.push(...batch);
        if (batch.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      return all;
    },
    // Cache 5 min — events cambian solo con runs del cron/retrigger
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });
}

/**
 * Trae todos los agent_events globales paginando por bloques de 1000.
 *
 * Supabase tiene cap de 1000 rows por query (PostgREST default). Sin paginar,
 * el panel veía solo los 1000 events más recientes — por eso `/agentes` decía
 * "Histórico total: 1000" cuando la suma real por cliente daba 1070+.
 *
 * Tras backfill masivo (events suben de ~1k a ~5k+), esta función ya no trunca.
 */
export function useAllFacturas() {
  return useQuery({
    queryKey: ["facturas-all"],
    queryFn: async (): Promise<AgentEvent[]> => {
      const PAGE_SIZE = 1000;
      const all: AgentEvent[] = [];
      let from = 0;
      // Hard ceiling: 50_000 events. Si supera, hay algo raro y abortamos.
      const HARD_CEILING = 50_000;
      while (from < HARD_CEILING) {
        const { data, error } = await supabase
          .from("agent_events")
          .select("*")
          .eq("tipo", "factura_procesada")
          .order("created_at", { ascending: false })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        const batch = (data ?? []) as AgentEvent[];
        all.push(...batch);
        if (batch.length < PAGE_SIZE) break; // última página
        from += PAGE_SIZE;
      }
      return all;
    },
    // Cache 5 min — query muy pesada (hasta 50k events paginados).
    // Events cambian solo cuando corre el cron facturacion (1×/día) o un
    // retrigger; 5 min es seguro y ahorra mucha latencia al navegar.
    staleTime: 5 * 60_000,
    // GC 30 min (vs default 5 min): si Tomás navega entre routes y vuelve,
    // no re-fetch.
    gcTime: 30 * 60_000,
  });
}

/**
 * Última validación 5 fuentes del reparador (Bloque B).
 *
 * Returns un Map<cliente_slug, ValidacionClienteCliente> con la última
 * validación de cada cliente. Usada para calcular health-score.
 */
export function useLatestReparadorValidations() {
  return useQuery({
    queryKey: ["reparador-validations"],
    refetchInterval: 5 * 60_000,
    queryFn: async (): Promise<Map<string, any>> => {
      // Buscar el último run del reparador con validaciones
      const { data } = await supabase
        .from("agent_runs")
        .select("payload")
        .eq("agente_id", "reparador")
        .order("started_at", { ascending: false })
        .limit(1);
      const map = new Map<string, any>();
      const payload = (data?.[0]?.payload as any) ?? {};
      const validaciones = payload.validaciones ?? [];
      for (const v of validaciones) {
        if (v.cliente_slug) map.set(v.cliente_slug, v);
      }
      return map;
    },
  });
}

/**
 * Último run completo del reparador con payload entero.
 *
 * Devuelve el run + payload (validaciones, pdfs_huerfanos, filas_sin_pdf,
 * auto_repairs, etc) para que el componente SaludArchivo filtre por cliente
 * y muestre todo en una sola vista. El reparador corre 1 vez al día (8:15
 * Bogotá) — esto es la fuente de verdad para "Salud del archivo".
 *
 * Si necesitás re-correr para un cliente específico (sin esperar al próximo
 * cron), usar el endpoint admin-reparador-trigger-cliente.
 */
export interface ReparadorValidacion {
  cliente_slug: string;
  mes: string; // YYYY-MM
  gmail: number;
  drive: number;
  sheet: number;
  events: number;
  todo_cuadra: boolean;
  discrepancias: string[];
}

export interface ReparadorPdfHuerfano {
  cliente_slug: string;
  mes: number;
  drive_file_id: string;
  drive_file_name: string;
}

export interface ReparadorFilaSinPdf {
  cliente_slug: string;
  mes: number;
  proveedor: string;
  num_factura: string;
}

export interface ReparadorAutoRepair {
  cliente_slug: string;
  tipo: string;
  num_factura?: string;
  detalle: string;
}

export interface ReparadorFullPayload {
  fecha?: string;
  ts_generated?: string;
  validaciones: ReparadorValidacion[];
  pdfs_huerfanos: ReparadorPdfHuerfano[];
  filas_sin_pdf: ReparadorFilaSinPdf[];
  filas_reparadas: any[];
  auto_repairs: ReparadorAutoRepair[];
  clientes_inconsistentes: string[];
  clientes_total?: number;
  clientes_procesados?: number;
  clientes_skipped?: number;
  errores: any[];
}

export interface ReparadorLastRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  duration_ms: number | null;
  summary: string | null;
  payload: ReparadorFullPayload;
}

export function useReparadorLastRun() {
  return useQuery({
    queryKey: ["reparador-last-run"],
    refetchInterval: 5 * 60_000,
    queryFn: async (): Promise<ReparadorLastRun | null> => {
      // Prioriza el último run del archivero (nuevo agente coordinador que
      // sustituyó reparador+limpiador a partir de 2026-05-15). Si todavía no
      // hay archivero runs (deploy reciente), cae al reparador legacy.
      const { data: archiveroData, error: e1 } = await supabase
        .from("agent_runs")
        .select("id, started_at, finished_at, status, duration_ms, summary, payload")
        .eq("agente_id", "archivero")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (e1) throw e1;
      if (archiveroData) return archiveroData as ReparadorLastRun;

      const { data, error } = await supabase
        .from("agent_runs")
        .select("id, started_at, finished_at, status, duration_ms, summary, payload")
        .eq("agente_id", "reparador")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as ReparadorLastRun | null;
    },
  });
}

/** Alias semántico — apunta al mismo hook pero con nombre claro del nuevo agente. */
export const useArchiveroLastRun = useReparadorLastRun;

/**
 * Trae client_credentials de clientes en onboarding (first_run_done=false).
 *
 * Devuelve para cada cliente en proceso de backfill:
 *   - cliente_id, agente_id
 *   - onboarded_at: cuándo se completó el OAuth (referencia ETA)
 *   - sheet_id, drive_folder_id: para mostrar links al admin
 *
 * Usado por el Matriz/operacion para mostrar "clientes en onboarding"
 * con progreso real (cruzado con agent_events y agent_runs).
 */
export interface OnboardingProgressCred {
  cliente_id: string;
  agente_id: string;
  onboarded_at: string | null;
  drive_folder_id: string | null;
  sheet_id: string | null;
}

export function useFirstRunClients() {
  return useQuery({
    queryKey: ["first-run-clients"],
    // 2-min polling — los stats del onboarding cambian rápido durante el backfill.
    refetchInterval: 2 * 60_000,
    queryFn: async (): Promise<OnboardingProgressCred[]> => {
      const { data, error } = await supabase
        .from("client_credentials")
        .select("cliente_id, agente_id, onboarded_at, drive_folder_id, sheet_id")
        .eq("first_run_done", false);
      if (error) throw error;
      return (data ?? []) as OnboardingProgressCred[];
    },
  });
}

export function useRunsByClienteAgente(clienteId: string, agenteId: string, limit = 10) {
  return useQuery({
    queryKey: ["runs", clienteId, agenteId, limit],
    enabled: !!clienteId && !!agenteId,
    queryFn: async (): Promise<AgentRun[]> => {
      const { data, error } = await supabase
        .from("agent_runs")
        .select("*")
        .eq("cliente_id", clienteId)
        .eq("agente_id", agenteId)
        .order("started_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data as AgentRun[];
    },
  });
}
