// netlify/functions/archivero-background.mts
//
// Background function que coordina reparador + limpiador en una sola pasada
// (Etapas 1-6 del archivo) y guarda un único agent_run con agente_id='archivero'.
//
// Sustituye los crons separados de reparador (8:15) y limpiador (8:30) — corre
// 8:15 Bogotá y procesa todo. Los crons viejos quedan desactivados (sus
// schedules apuntan a fechas imposibles).
//
// Body opcional:
//   { clienteSlug?: string }       → solo procesa ese cliente (reparador filtra,
//                                     limpiador todavía no — TODO)
//   { skipLimpiador?: boolean }    → solo cross-check (sin LLM)
//   { skipReparador?: boolean }    → solo cleanup (raro)

import { runArchivero } from "../../agentes/Equipo-archivero/lib/archivero";
import { recordRunStart, recordRunEnd } from "../../shared/agents-runtime/src/record-run";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  // Parse body opcional
  let body: {
    clienteSlug?: string;
    skipLimpiador?: boolean;
    skipReparador?: boolean;
  } = {};
  try {
    if (req.headers.get("content-length") !== "0") {
      body = await req.json();
    }
  } catch {
    /* body opcional, default {} */
  }
  const clienteSlugFilter = body.clienteSlug?.trim() || undefined;

  // Registrar el run en agent_runs (cliente_slug = "archivero" como marker)
  let runId: string | null = null;
  try {
    runId = await recordRunStart({
      clienteSlug: "archivero",
      agenteId: "archivero",
      triggeredBy: req.headers.get("x-trigger") === "rerun" ? "rerun" : "cron",
    });
  } catch (err: any) {
    console.error("[archivero] recordRunStart failed (no-fatal):", err.message);
  }

  const startedAt = Date.now();

  try {
    if (clienteSlugFilter) {
      console.log(`[archivero] re-validación on-demand cliente=${clienteSlugFilter}`);
    }
    const report = await runArchivero({
      clienteSlugFilter,
      skipLimpiador: body.skipLimpiador,
      skipReparador: body.skipReparador,
    });

    const r = report.resumen;
    console.log(JSON.stringify({
      level: "info",
      event: "archivero_report",
      fecha: report.fecha,
      clientes_total: r.clientes_total,
      filas_reparadas: r.filas_reparadas,
      huerfanos_residuales: r.pdfs_huerfanos_residuales,
      huerfanos_recuperados: r.huerfanos_recuperados,
      duplicados_movidos: r.duplicados_movidos,
      filas_basura: r.filas_basura,
      clientes_inconsistentes: r.clientes_inconsistentes.length,
      costo_llm_usd: r.costo_llm_usd_total,
      duration_ms_reparador: report.duration_ms_reparador,
      duration_ms_limpiador: report.duration_ms_limpiador,
    }));

    // STATUS:
    //   fail = clientes con 5-fuentes desalineadas residuales (cross-check finaliza con gaps)
    //   warn = errores no críticos en cualquier etapa O huérfanos/sin-pdf residuales
    //   ok   = TODO cuadra
    const tieneInconsistentes = r.clientes_inconsistentes.length > 0;
    const tieneResiduales =
      r.pdfs_huerfanos_residuales > 0 ||
      r.filas_sin_pdf > 0 ||
      r.filas_sheet_duplicadas_grupos > 0 ||
      r.filas_basura > 0;
    const tieneErrores = report.errores.length > 0;

    let status: "ok" | "warn" | "fail";
    if (tieneInconsistentes) {
      status = "fail";
    } else if (tieneErrores || tieneResiduales) {
      status = "warn";
    } else {
      status = "ok";
    }

    const summary = [
      `${r.filas_reparadas} reparadas`,
      `${r.huerfanos_recuperados} recuperadas (LLM)`,
      `${r.duplicados_movidos} dups movidos`,
      tieneInconsistentes
        ? `⚠ ${r.clientes_inconsistentes.length} inconsistentes: ${r.clientes_inconsistentes.join(", ")}`
        : "✓ todos cuadran",
    ].join(" · ");

    if (runId) {
      await recordRunEnd({
        runId,
        status,
        durationMs: Date.now() - startedAt,
        summary,
        payload: {
          // Mantener formato compatible con SaludArchivo (usa estos campos)
          fecha: report.fecha,
          ts_generated: report.ts_generated,
          // Validaciones del reparador (la fuente principal de la sección Salud)
          validaciones: report.reparador.validaciones,
          pdfs_huerfanos: report.reparador.pdfs_huerfanos,
          filas_sin_pdf: report.reparador.filas_sin_pdf,
          filas_reparadas: report.reparador.filas_reparadas,
          auto_repairs: report.reparador.auto_repairs,
          clientes_inconsistentes: report.reparador.clientes_inconsistentes,
          clientes_total: report.reparador.clientes_total,
          clientes_procesados: report.reparador.clientes_procesados,
          clientes_skipped: report.reparador.clientes_skipped,
          // Específicos del limpiador
          limpiador_acciones: report.limpiador?.acciones ?? [],
          filas_sheet_duplicadas: report.limpiador?.filas_sheet_duplicadas ?? [],
          filas_basura: report.limpiador?.filas_basura ?? [],
          self_emitted_ignorados: report.limpiador?.self_emitted_ignorados ?? 0,
          // Resumen consolidado
          resumen: report.resumen,
          duration_ms_reparador: report.duration_ms_reparador,
          duration_ms_limpiador: report.duration_ms_limpiador,
          errores: report.errores,
        } as any,
      });
    }

    return new Response(JSON.stringify({ ok: true, report }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err: any) {
    console.error(JSON.stringify({
      level: "fatal",
      agent: "archivero",
      error: err.message,
      stack: err.stack,
    }));
    if (runId) {
      try {
        await recordRunEnd({
          runId,
          status: "fail",
          durationMs: Date.now() - startedAt,
          summary: `Archivero crasheó: ${err.message}`,
          error: err,
        });
      } catch {
        /* ignorar */
      }
    }
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};
