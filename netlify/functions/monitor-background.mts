// netlify/functions/monitor-background.mts
//
// Background function que ejecuta el Equipo-monitor: chequea estado del cron
// de facturación de hoy por cliente, cierra runs zombies, y envía email de
// resumen al admin.
//
// Disparado por monitor-cron.mts (8am Bogotá) o curl manual con secret.

import { runMonitor } from "../../agentes/Equipo-monitor/lib/monitor";
import { buildMonitorEmail } from "../../agentes/Equipo-monitor/lib/email";
import { recordRunStart, recordRunEnd } from "../../shared/agents-runtime/src/record-run";

export default async (req: Request) => {
  // 1. Auth interna (igual que facturacion-background)
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  // 2. Registrar el run en agent_runs (cliente_slug = "monitor" como marker)
  let runId: string | null = null;
  try {
    runId = await recordRunStart({
      clienteSlug: "monitor",
      agenteId: "monitor",
      triggeredBy: req.headers.get("x-trigger") === "rerun" ? "rerun" : "cron",
    });
  } catch (err: any) {
    console.error("[monitor] recordRunStart failed (no-fatal):", err.message);
  }

  const startedAt = Date.now();
  let report: Awaited<ReturnType<typeof runMonitor>> | null = null;

  try {
    // 3. Ejecutar chequeos
    report = await runMonitor();
    console.log(JSON.stringify({
      level: "info",
      event: "monitor_report",
      fecha: report.fecha,
      total: report.clientes_total,
      ok: report.clientes_ok,
      alertas: report.clientes_con_alerta,
      zombies_cerrados: report.zombies_cerrados,
    }));

    // 4. Email diario: DESACTIVADO por default — la info vive en el panel /diagnostico.
    // Para reactivar (debug), setear AGENTS_DAILY_EMAILS_ENABLED=true en Netlify.
    if (process.env.AGENTS_DAILY_EMAILS_ENABLED !== "true") {
      console.log("[monitor] email diario desactivado (AGENTS_DAILY_EMAILS_ENABLED!=true) — ver /diagnostico");
    } else {
      const fromAddr = process.env.NOTIFY_EMAIL_FROM;
      const adminEmail =
        process.env.MONITOR_ADMIN_EMAIL ??
        process.env.NOTIFY_ADMIN_EMAIL ??
        process.env.NOTIFY_EMAIL_TO;
      const resendKey = process.env.RESEND_API_KEY;

      if (!fromAddr || !adminEmail || !resendKey) {
        console.warn("[monitor] email no enviado — faltan env vars");
      } else {
        const { subject, html, text } = buildMonitorEmail(report);
        const resp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ from: fromAddr, to: adminEmail, subject, html, text }),
        });
        if (!resp.ok) {
          console.error(`[monitor] resend failed: ${await resp.text()}`);
        } else {
          console.log(`[monitor] email enviado a ${adminEmail}`);
        }
      }
    }

    // 5. Determinar status final del run del monitor
    const status: "ok" | "warn" | "fail" =
      report.clientes_con_alerta === 0
        ? "ok"
        : report.clientes_con_alerta < report.clientes_total
          ? "warn"
          : "fail";

    if (runId) {
      await recordRunEnd({
        runId,
        status,
        durationMs: Date.now() - startedAt,
        summary: `${report.clientes_ok}/${report.clientes_total} clientes OK, ${report.clientes_con_alerta} alerta(s)`,
        payload: report as any,
      });
    }

    return new Response(JSON.stringify({ ok: true, report }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err: any) {
    console.error(JSON.stringify({
      level: "fatal",
      agent: "monitor",
      error: err.message,
      stack: err.stack,
    }));
    if (runId) {
      try {
        await recordRunEnd({
          runId,
          status: "fail",
          durationMs: Date.now() - startedAt,
          summary: `Monitor crasheó: ${err.message}`,
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
