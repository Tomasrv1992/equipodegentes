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

    // 4. Enviar email al admin si hay email configurado.
    // Aceptamos 3 nombres distintos (en orden de preferencia) para flexibilidad:
    //   - MONITOR_ADMIN_EMAIL (nombre canónico del monitor)
    //   - NOTIFY_ADMIN_EMAIL (alias)
    //   - NOTIFY_EMAIL_TO (legacy del cron facturación)
    const fromAddr = process.env.NOTIFY_EMAIL_FROM;
    const adminEmail =
      process.env.MONITOR_ADMIN_EMAIL ??
      process.env.NOTIFY_ADMIN_EMAIL ??
      process.env.NOTIFY_EMAIL_TO;
    const resendKey = process.env.RESEND_API_KEY;

    // Diagnóstico detallado (sin exponer valores sensibles)
    console.log(
      `[monitor] env check: NOTIFY_EMAIL_FROM=${fromAddr ? "✓ (" + fromAddr.slice(0, 25) + "...)" : "✗ FALTA"} | ` +
      `MONITOR_ADMIN_EMAIL=${process.env.MONITOR_ADMIN_EMAIL ? "✓" : "✗"} | ` +
      `NOTIFY_ADMIN_EMAIL=${process.env.NOTIFY_ADMIN_EMAIL ? "✓" : "✗"} | ` +
      `NOTIFY_EMAIL_TO=${process.env.NOTIFY_EMAIL_TO ? "✓" : "✗"} | ` +
      `resolved adminEmail=${adminEmail ? "✓ (" + adminEmail.slice(0, 5) + "...)" : "✗ FALTA"} | ` +
      `RESEND_API_KEY=${resendKey ? "✓ (length=" + resendKey.length + ")" : "✗ FALTA"}`,
    );

    if (!fromAddr || !adminEmail || !resendKey) {
      const faltantes = [
        !fromAddr ? "NOTIFY_EMAIL_FROM" : null,
        !adminEmail ? "MONITOR_ADMIN_EMAIL / NOTIFY_ADMIN_EMAIL / NOTIFY_EMAIL_TO" : null,
        !resendKey ? "RESEND_API_KEY" : null,
      ].filter(Boolean).join(", ");
      console.warn(`[monitor] email no enviado — falta(n): ${faltantes}`);
    } else {
      const { subject, html, text } = buildMonitorEmail(report);
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: fromAddr,
          to: adminEmail,
          subject,
          html,
          text,
        }),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        console.error(`[monitor] resend failed: ${txt}`);
      } else {
        console.log(`[monitor] email enviado a ${adminEmail}`);
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
