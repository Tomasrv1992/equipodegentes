import { getServerClient } from "./supabase-server";

export type RunStatus = "running" | "ok" | "fail" | "warn";
export type TriggeredBy = "cron" | "manual" | "rerun";

export interface RecordRunStartInput {
  clienteSlug: string;
  agenteId: string;
  triggeredBy?: TriggeredBy;
}

export interface RecordRunEndInput {
  runId: string;
  status: "ok" | "fail" | "warn";
  durationMs: number;
  summary?: string;
  payload?: unknown;
  error?: Error | { message: string; stack?: string };
  netlifyLogUrl?: string;
}

/**
 * Registra el inicio de un run. Inserta una fila en agent_runs con status='running'
 * y devuelve el id del run para que recordRunEnd lo actualice al terminar.
 */
export async function recordRunStart(input: RecordRunStartInput): Promise<string> {
  const supa = getServerClient();

  const { data: cliente, error: errCli } = await supa
    .from("clientes")
    .select("id")
    .eq("slug", input.clienteSlug)
    .single();

  if (errCli || !cliente) {
    throw new Error(
      `Cliente con slug "${input.clienteSlug}" no encontrado: ${errCli?.message ?? "no rows"}`
    );
  }

  const { data, error } = await supa
    .from("agent_runs")
    .insert({
      cliente_id: (cliente as any).id,
      agente_id: input.agenteId,
      status: "running",
      started_at: new Date().toISOString(),
      triggered_by: input.triggeredBy ?? "cron",
    })
    .select("id");

  if (error || !data || data.length === 0) {
    throw new Error(error?.message ?? "insert agent_runs devolvió 0 rows");
  }

  return (data[0] as any).id as string;
}

/**
 * Registra el fin de un run (ok | fail | warn) y actualiza duration + summary.
 */
export async function recordRunEnd(input: RecordRunEndInput): Promise<void> {
  const supa = getServerClient();

  const update: Record<string, unknown> = {
    status: input.status,
    finished_at: new Date().toISOString(),
    duration_ms: input.durationMs,
    summary: input.summary ?? null,
    payload: input.payload ?? null,
    netlify_log_url: input.netlifyLogUrl ?? null,
  };

  if (input.error) {
    update.error_message = input.error.message;
    update.error_stack = "stack" in input.error ? input.error.stack : undefined;
  }

  const { error } = await supa
    .from("agent_runs")
    .update(update)
    .eq("id", input.runId)
    .select("id");

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Wrapper conveniente: corre fn, registra inicio + fin con manejo de errores.
 */
export async function recordRun<T>(
  meta: RecordRunStartInput,
  fn: () => Promise<{ summary?: string; payload?: unknown; result: T }>
): Promise<T> {
  const startedAt = Date.now();
  const runId = await recordRunStart(meta);
  try {
    const { summary, payload, result } = await fn();
    await recordRunEnd({
      runId,
      status: "ok",
      durationMs: Date.now() - startedAt,
      summary,
      payload,
    });
    return result;
  } catch (err: any) {
    await recordRunEnd({
      runId,
      status: "fail",
      durationMs: Date.now() - startedAt,
      error: err,
    });
    throw err;
  }
}
