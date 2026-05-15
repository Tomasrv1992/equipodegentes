// netlify/functions/inspector-background.mts
//
// Background function que ejecuta el Equipo-inspector: chequea estado del cron
// de facturación de hoy por cliente, cierra runs zombies, y envía email de
// resumen al admin.
//
// Renombrado de Equipo-monitor → Equipo-inspector el 2026-05-15 (distinguir
// del Equipo-supervisor que orquesta acciones; el inspector solo observa).
//
// Disparado por inspector-cron.mts (8am Bogotá) o curl manual con secret.

import { runInspector } from "../../agentes/Equipo-inspector/lib/inspector";
import { buildInspectorEmail } from "../../agentes/Equipo-inspector/lib/email";
import { recordRunStart, recordRunEnd } from "../../shared/agents-runtime/src/record-run";

export default async (req: Request) => {
  // 1. Auth interna (igual que facturacion-background)
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  // 2. Registrar el run en agent_runs (cliente_slug = "inspector" como marker)
  let runId: string | null = null;
  try {
    runId = await recordRunStart({
      clienteSlug: "inspector",
      agenteId: "inspector",
      triggeredBy: req.headers.get("x-trigger") === "rerun" ? "rerun" : "cron",
    });
  } catch (err: any) {
    console.error("[inspector] recordRunStart failed (no-fatal):", err.message);
  }

  const startedAt = Date.now();
  let report: Awaited<ReturnType<typeof runInspector>> | null = null;

  try {
    // 3. Ejecutar chequeos
    report = await runInspector();
    console.log(JSON.stringify({
      level: "info",
      event: "inspector_report",
      fecha: report.fecha,
      total: report.clientes_total,
      ok: report.clientes_ok,
      alertas: report.clientes_con_alerta,
      zombies_cerrados: report.zombies_cerrados,
    }));

    // 4. Email diario: DESACTIVADO por default — la info vive en el panel /diagnostico.
    // Para reactivar (debug), setear AGENTS_DAILY_EMAILS_ENABLED=true en Netlify.
    if (process.env.AGENTS_DAILY_EMAILS_ENABLED !== "true") {
      console.log("[inspector] email diario desactivado (AGENTS_DAILY_EMAILS_ENABLED!=true) — ver /diagnostico");
    } else {
      const fromAddr = process.env.NOTIFY_EMAIL_FROM;
      const adminEmail =
        process.env.INSPECTOR_ADMIN_EMAIL ??
        process.env.NOTIFY_ADMIN_EMAIL ??
        process.env.NOTIFY_EMAIL_TO;
      const resendKey = process.env.RESEND_API_KEY;

      if (!fromAddr || !adminEmail || !resendKey) {
        console.warn("[inspector] email no enviado — faltan env vars");
      } else {
        const { subject, html, text } = buildInspectorEmail(report);
        const resp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ from: fromAddr, to: adminEmail, subject, html, text }),
        });
        if (!resp.ok) {
          console.error(`[inspector] resend failed: ${await resp.text()}`);
        } else {
          console.log(`[inspector] email enviado a ${adminEmail}`);
        }
      }
    }

    // 5. Determinar status final del run del inspector
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
      agent: "inspector",
      error: err.message,
      stack: err.stack,
    }));
    if (runId) {
      try {
        await recordRunEnd({
          runId,
          status: "fail",
          durationMs: Date.now() - startedAt,
          summary: `Inspector crasheó: ${err.message}`,
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
