// netlify/functions/reparador-background.mts
//
// Background function que ejecuta el Equipo-reparador: detecta gaps entre
// agent_events / Sheet / Drive, auto-repara filas faltantes en Sheet, y
// reporta huérfanos para revisión manual.
//
// Disparado por reparador-cron.mts (8:15am Bogotá) o curl manual con secret.

import { runReparador } from "../../agentes/Equipo-reparador/lib/reparador";
import { buildReparadorEmail } from "../../agentes/Equipo-reparador/lib/email";
import { recordRunStart, recordRunEnd } from "../../shared/agents-runtime/src/record-run";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  // Parse body opcional para clienteSlugFilter (re-validación on-demand 1 cliente)
  let body: { clienteSlug?: string } = {};
  try {
    if (req.headers.get("content-length") !== "0") {
      body = await req.json();
    }
  } catch {
    /* body opcional, default {} */
  }
  const clienteSlugFilter = body.clienteSlug?.trim() || undefined;

  // Registrar el run en agent_runs (cliente_slug = "reparador" como marker)
  let runId: string | null = null;
  try {
    runId = await recordRunStart({
      clienteSlug: "reparador",
      agenteId: "reparador",
      triggeredBy: req.headers.get("x-trigger") === "rerun" ? "rerun" : "cron",
    });
  } catch (err: any) {
    console.error("[reparador] recordRunStart failed (no-fatal):", err.message);
  }

  const startedAt = Date.now();
  let report: Awaited<ReturnType<typeof runReparador>> | null = null;

  try {
    if (clienteSlugFilter) {
      console.log(`[reparador] re-validación on-demand cliente=${clienteSlugFilter}`);
    }
    report = await runReparador({ clienteSlugFilter });
    console.log(JSON.stringify({
      level: "info",
      event: "reparador_report",
      fecha: report.fecha,
      total: report.clientes_total,
      procesados: report.clientes_procesados,
      reparadas: report.filas_reparadas.length,
      huerfanos: report.pdfs_huerfanos.length,
      sin_pdf: report.filas_sin_pdf.length,
      errores: report.errores.length,
    }));

    // Email diario: DESACTIVADO por default — la info vive en el panel /diagnostico.
    // Para reactivar (debug), setear AGENTS_DAILY_EMAILS_ENABLED=true en Netlify.
    if (process.env.AGENTS_DAILY_EMAILS_ENABLED !== "true") {
      console.log("[reparador] email diario desactivado (AGENTS_DAILY_EMAILS_ENABLED!=true) — ver /diagnostico");
    } else {
      const fromAddr = process.env.NOTIFY_EMAIL_FROM;
      const adminEmail =
        process.env.MONITOR_ADMIN_EMAIL ??
        process.env.NOTIFY_ADMIN_EMAIL ??
        process.env.NOTIFY_EMAIL_TO;
      const resendKey = process.env.RESEND_API_KEY;

      if (!fromAddr || !adminEmail || !resendKey) {
        console.warn("[reparador] email no enviado — faltan env vars");
      } else {
        const { subject, html, text } = buildReparadorEmail(report);
        const resp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ from: fromAddr, to: adminEmail, subject, html, text }),
        });
        if (!resp.ok) {
          console.error(`[reparador] resend failed: ${await resp.text()}`);
        } else {
          console.log(`[reparador] email enviado a ${adminEmail}`);
        }
      }
    }

    // STATUS EXIGENTE (no ser paisaje):
    //   fail = quedan clientes con las 5 fuentes desalineadas tras auto-reparar
    //   warn = hubo errores no críticos O hay huérfanos/sin-pdf residuales
    //   ok   = TODO cuadra para TODOS los clientes (Bloque B validó)
    const tieneInconsistentes = report.clientes_inconsistentes.length > 0;
    const tieneResiduales =
      report.pdfs_huerfanos.length > 0 || report.filas_sin_pdf.length > 0;
    const tieneErrores = report.errores.length > 0;

    let status: "ok" | "warn" | "fail";
    if (tieneInconsistentes) {
      status = "fail"; // los 5 fuentes NO cuadran → SUPER crítico
    } else if (tieneErrores || tieneResiduales) {
      status = "warn";
    } else {
      status = "ok";
    }

    const summary = [
      `${report.filas_reparadas.length} reparadas`,
      `${report.pdfs_huerfanos.length + report.filas_sin_pdf.length} para revisar`,
      tieneInconsistentes
        ? `⚠ ${report.clientes_inconsistentes.length} clientes con 5 fuentes desalineadas: ${report.clientes_inconsistentes.join(", ")}`
        : "✓ todos los clientes con fuentes alineadas",
    ].join(" · ");

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
      agent: "reparador",
      error: err.message,
      stack: err.stack,
    }));
    if (runId) {
      try {
        await recordRunEnd({
          runId,
          status: "fail",
          durationMs: Date.now() - startedAt,
          summary: `Reparador crasheó: ${err.message}`,
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
