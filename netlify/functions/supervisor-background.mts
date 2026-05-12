// netlify/functions/supervisor-background.mts
//
// Background fn que ejecuta el Equipo-supervisor: valida estado final
// del día y retriggea agentes si quedan gaps. Email solo si crítico.

import { runSupervisor } from "../../agentes/Equipo-supervisor/lib/supervisor";
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
      clienteSlug: "supervisor",
      agenteId: "supervisor",
      triggeredBy: req.headers.get("x-trigger") === "rerun" ? "rerun" : "cron",
    });
  } catch (err: any) {
    console.error("[supervisor] recordRunStart failed (no-fatal):", err.message);
  }

  const startedAt = Date.now();

  try {
    const report = await runSupervisor();
    console.log(JSON.stringify({
      level: "info",
      event: "supervisor_report",
      fecha: report.fecha,
      total: report.clientes_total,
      ok: report.clientes_ok,
      warn: report.clientes_warn,
      fail: report.clientes_fail,
      retriggers: report.retriggers_disparados,
    }));

    // Email SOLO si hay atención crítica (no spam diario)
    if (report.requiere_atencion_critica) {
      const fromAddr = process.env.NOTIFY_EMAIL_FROM;
      const adminEmail =
        process.env.MONITOR_ADMIN_EMAIL ??
        process.env.NOTIFY_ADMIN_EMAIL ??
        process.env.NOTIFY_EMAIL_TO;
      const resendKey = process.env.RESEND_API_KEY;

      if (fromAddr && adminEmail && resendKey) {
        const subject = `🚨 Operatto Supervisor · ${report.clientes_fail} clientes FAIL · ${report.fecha}`;
        const html = `
          <h2>Operatto Supervisor — atención crítica</h2>
          <p>El supervisor detectó <strong>${report.clientes_fail} clientes con estado FAIL</strong> que no se resolvieron automáticamente:</p>
          <ul>
            ${report.chequeos.filter((c) => c.estado === "fail").map((c) =>
              `<li><strong>${c.cliente_slug}</strong>: ${c.detalle}</li>`
            ).join("")}
          </ul>
          <p>Retriggers disparados: ${report.retriggers_disparados}. Aún así requieren revisión manual.</p>
          <p>Ver detalle completo en el panel admin: /diagnostico</p>
        `;
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ from: fromAddr, to: adminEmail, subject, html }),
        });
        console.log(`[supervisor] email crítico enviado a ${adminEmail}`);
      }
    } else {
      console.log(`[supervisor] sin atención crítica, NO se envía email`);
    }

    const status: "ok" | "warn" | "fail" =
      report.clientes_fail > 0 ? "fail" :
        report.clientes_warn > 0 ? "warn" : "ok";

    if (runId) {
      await recordRunEnd({
        runId,
        status,
        durationMs: Date.now() - startedAt,
        summary: `${report.clientes_ok}/${report.clientes_total} OK, ${report.clientes_warn} warn, ${report.clientes_fail} fail, ${report.retriggers_disparados} retriggers`,
        payload: report as any,
      });
    }

    return new Response(JSON.stringify({ ok: true, report }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err: any) {
    console.error(JSON.stringify({
      level: "fatal",
      agent: "supervisor",
      error: err.message,
      stack: err.stack,
    }));
    if (runId) {
      try {
        await recordRunEnd({
          runId,
          status: "fail",
          durationMs: Date.now() - startedAt,
          summary: `Supervisor crasheó: ${err.message}`,
          error: err,
        });
      } catch {
        /* ignorar */
      }
    }
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
