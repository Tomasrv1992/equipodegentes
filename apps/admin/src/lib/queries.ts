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
      const { data, error } = await supabase
        .from("clientes")
        .select("*")
        .eq("activo", true)
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
      const { data, error } = await supabase
        .from("agent_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(200);
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
export function useFacturasByCliente(clienteId: string, limit = 1000) {
  return useQuery({
    queryKey: ["facturas-cliente", clienteId, limit],
    enabled: !!clienteId,
    queryFn: async (): Promise<AgentEvent[]> => {
      const { data, error } = await supabase
        .from("agent_events")
        .select("*")
        .eq("cliente_id", clienteId)
        .eq("tipo", "factura_procesada")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data as AgentEvent[];
    },
  });
}

/**
 * Trae todos los agent_events tipo 'factura_procesada' del agente cross-cliente.
 * Útil para vista global del agente.
 */
export function useFacturasByAgente(agenteId: string, limit = 1000) {
  return useQuery({
    queryKey: ["facturas-agente", agenteId, limit],
    enabled: !!agenteId,
    queryFn: async (): Promise<AgentEvent[]> => {
      const { data, error } = await supabase
        .from("agent_events")
        .select("*")
        .eq("agente_id", agenteId)
        .eq("tipo", "factura_procesada")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data as AgentEvent[];
    },
  });
}

/**
 * Trae todos los agent_events globales (todos los clientes, todos los agentes).
 * Para KPIs globales de la home Operatto.
 */
export function useAllFacturas(limit = 2000) {
  return useQuery({
    queryKey: ["facturas-all", limit],
    queryFn: async (): Promise<AgentEvent[]> => {
      const { data, error } = await supabase
        .from("agent_events")
        .select("*")
        .eq("tipo", "factura_procesada")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data as AgentEvent[];
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
