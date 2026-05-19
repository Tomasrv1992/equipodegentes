// netlify/functions/limpiador-background.mts
//
// Background function que ejecuta el Equipo-limpiador: descarga PDFs huérfanos
// del mes actual, los analiza con LLM, y los clasifica como duplicados o
// facturas no registradas.

import { runLimpiador } from "../../agentes/Equipo-limpiador/lib/limpiador";
import { buildLimpiadorEmail } from "../../agentes/Equipo-limpiador/lib/email";
import { recordRunStart, recordRunEnd } from "../../shared/agents-runtime/src/record-run";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  let runId: string | null = null;
  try {
    runId = await recordRunStart({
      clienteSlug: "limpiador",
      agenteId: "limpiador",
      triggeredBy: req.headers.get("x-trigger") === "rerun" ? "rerun" : "cron",
    });
  } catch (err: any) {
    console.error("[limpiador] recordRunStart failed (no-fatal):", err.message);
  }

  const startedAt = Date.now();

  try {
    const report = await runLimpiador();
    console.log(JSON.stringify({
      level: "info",
      event: "limpiador_report",
      fecha: report.fecha,
      total_analizados: report.total_huerfanos_analizados,
      duplicados: report.duplicados_movidos,
      recuperadas: report.facturas_recuperadas,
      no_id: report.no_identificables,
      costo_llm: report.costo_llm_usd,
    }));

    // Email diario: DESACTIVADO por default — la info vive en el panel /diagnostico.
    // Para reactivar (debug), setear AGENTS_DAILY_EMAILS_ENABLED=true en Netlify.
    if (process.env.AGENTS_DAILY_EMAILS_ENABLED !== "true") {
      console.log("[limpiador] email diario desactivado (AGENTS_DAILY_EMAILS_ENABLED!=true) — ver /diagnostico");
    } else {
      const fromAddr = process.env.NOTIFY_EMAIL_FROM;
      const adminEmail =
        process.env.MONITOR_ADMIN_EMAIL ??
        process.env.NOTIFY_ADMIN_EMAIL ??
        process.env.NOTIFY_EMAIL_TO;
      const resendKey = process.env.RESEND_API_KEY;

      if (fromAddr && adminEmail && resendKey) {
        const { subject, html, text } = buildLimpiadorEmail(report);
        const resp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ from: fromAddr, to: adminEmail, subject, html, text }),
        });
        if (!resp.ok) {
          console.error(`[limpiador] resend failed: ${await resp.text()}`);
        } else {
          console.log(`[limpiador] email enviado a ${adminEmail}`);
        }
      } else {
        console.warn("[limpiador] email no enviado — faltan env vars");
      }
    }

    // STATUS EXIGENTE (no ser paisaje):
    //   fail = errores graves del agente
    //   warn = quedaron items pendientes que requieren atención humana:
    //     - no_identificables que NO se pudieron clasificar
    //     - filas_sheet_duplicadas con accion='solo_reportar_por_diferencia_monto'
    //       (mismo número pero monto distinto → ambiguo, requiere ojo humano)
    //   ok   = todo limpio
    const duplicadosNoResueltos = (report.filas_sheet_duplicadas ?? []).filter(
      (d) => d.accion === "solo_reportar_por_diferencia_monto",
    ).length;
    const duplicadosBorrados = (report.filas_sheet_duplicadas ?? [])
      .filter((d) => d.accion === "borradas_auto")
      .reduce((s, d) => s + d.filas_borradas.length, 0);
    const requiereAtencionHumana =
      report.no_identificables > 0 || duplicadosNoResueltos > 0;

    let status: "ok" | "warn" | "fail";
    if (report.errores.length > 0) {
      status = "fail";
    } else if (requiereAtencionHumana) {
      status = "warn";
    } else {
      status = "ok";
    }

    const summary = [
      `${duplicadosBorrados} filas duplicadas BORRADAS del Sheet`,
      `${report.duplicados_movidos} PDFs duplicados a Papelera`,
      `${report.facturas_recuperadas} recuperadas`,
      `${report.no_identificables} no identificables → REVISAR_MANUAL`,
      duplicadosNoResueltos > 0
        ? `⚠ ${duplicadosNoResueltos} grupos con monto distinto requieren revisión`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");

    if (runId) {
      await recordRunEnd({
        runId,
        status,
        durationMs: Date.now() - startedAt,
        summary,
        payload: report as any,
      });
    }

    return new Response(JSON.stringify({ ok: true, report }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err: any) {
    console.error(JSON.stringify({
      level: "fatal",
      agent: "limpiador",
      error: err.message,
      stack: err.stack,
    }));
    if (runId) {
      try {
        await recordRunEnd({
          runId,
          status: "fail",
          durationMs: Date.now() - startedAt,
          summary: `Limpiador crasheó: ${err.message}`,
          error: err,
        });
      } catch {
        /* ignorar */
      }
    }
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
