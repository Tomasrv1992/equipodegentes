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
    staleTime: 60_000,
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
    staleTime: 60_000,
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
    // Cache 1 min — query pesada con muchos events
    staleTime: 60_000,
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
