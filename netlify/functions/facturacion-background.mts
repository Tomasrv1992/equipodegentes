// netlify/functions/facturacion-background.mts
//
// Background function (suffix `-background` → 15min timeout en cualquier plan).
// Disparada por: facturacion-cron.mts, o POST manual con x-internal-secret.
//
// Thin Netlify wrapper — la lógica vive en agentes/facturacion/lib/pipeline.ts
// (compartida con CLI local para evitar drift).
//
// Notificaciones: email diario (incondicional) vía Resend.
// Env vars: RESEND_API_KEY, NOTIFY_EMAIL_TO, NOTIFY_EMAIL_FROM.

import type { Config } from "@netlify/functions";
import { run, type PipelineConfig, type PipelineResult } from "../../agentes/facturacion/lib/pipeline";

interface RequestBody {
  /** Forward-compat para SaaS multi-tenant (Proyecto B). */
  customerId?: string;
  /** Override window de búsqueda (ej: "365d" para backfill manual). */
  window?: string;
  /** Solo listar, no procesar. */
  dryRun?: boolean;
}

export default async (req: Request) => {
  // 1. Auth interna: solo el cron stub o un curl con el secret correcto puede invocar
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  // 2. Parse body
  let body: RequestBody = {};
  try {
    if (req.headers.get("content-length") !== "0") {
      body = await req.json();
    }
  } catch {
    /* body opcional, default {} */
  }

  // 3. Resolver config según customerId
  const cfg = await buildConfig(body);

  // 4. Ejecutar pipeline
  const startedAt = Date.now();
  let result;
  try {
    result = await run(cfg);
  } catch (err: any) {
    // Log estructurado para que sea fácil grepear en Netlify logs
    console.error(JSON.stringify({
      level: "fatal",
      customerId: body.customerId ?? "owner",
      error: err.message,
      stack: err.stack,
      hint: err.message?.includes("invalid_grant")
        ? "Refresh token expiró: corré scripts/setup-oauth.mjs local y actualizá GOOGLE_OAUTH_REFRESH_TOKEN en Netlify env vars"
        : undefined,
    }));
    // Email de error fatal (no esperar — best effort)
    try {
      await notifyError(err, body.customerId);
    } catch {
      /* notify falla silencioso */
    }
    return new Response("internal error", { status: 500 });
  }

  const durationMs = Date.now() - startedAt;
  console.log(JSON.stringify({
    level: "result",
    customerId: body.customerId ?? "owner",
    durationMs,
    procesadas: result.procesadas.length,
    errores: result.errores.length,
    saltadas: result.saltadas.length,
    sample: result.procesadas.slice(0, 3),
  }));

  // Email diario incondicional con resumen
  try {
    await notifyResult(result, body.customerId);
  } catch (err: any) {
    console.error("notify failed:", err.message);
    /* no bloquear el flujo si email falla */
  }

  // Background fn: respuesta vacía/202 al caller
  return new Response(JSON.stringify({ ok: true, durationMs }), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {
  // Sin `schedule` → no es scheduled. El sufijo `-background` la marca como bg.
};

// ===== Config builder =====

async function buildConfig(body: RequestBody): Promise<PipelineConfig> {
  // Single-tenant (hoy): credenciales del owner desde env vars del site.
  if (!body.customerId) {
    return {
      google: {
        clientId: requireEnv("GOOGLE_CLIENT_ID"),
        clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
        refreshToken: requireEnv("GOOGLE_OAUTH_REFRESH_TOKEN"),
        driveFolderId: requireEnv("INVOICES_DRIVE_FOLDER_ID"),
        sheetId: requireEnv("INVOICES_SHEET_ID"),
        sheetTab: process.env.INVOICES_SHEET_TAB || "Gastos 2026",
      },
      options: {
        dryRun: body.dryRun ?? false,
        window: body.window ?? "30d",
      },
    };
  }

  // TODO Proyecto B: leer credenciales del customer desde Supabase
  // por `body.customerId`. Por ahora throw — la rama no se ejecuta en single-tenant.
  throw new Error("Multi-tenant aún no implementado (Proyecto B). Sacá customerId del body.");
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta env var: ${name}`);
  return v;
}

// ===== Notificaciones (Resend) =====

const SHEET_LINK = "https://docs.google.com/spreadsheets/d/1dwCu-1ooeyOC5PEd2lBIhua4zUmC5ymymQ6X0O4zcMU/edit";
const DRIVE_LINK = "https://drive.google.com/drive/folders/1ksS7gwlT8OYmMh4Eh2WiIQGNwkERdti2";

async function notifyResult(result: PipelineResult, customerId?: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("RESEND_API_KEY ausente — no se envía notificación");
    return;
  }

  const to = process.env.NOTIFY_EMAIL_TO || "tomasramirezvilla@gmail.com";
  const from = process.env.NOTIFY_EMAIL_FROM || "Procesar-Facturas <onboarding@resend.dev>";

  const total = result.procesadas.length + result.errores.length + result.saltadas.length;
  const today = new Date().toLocaleDateString("es-CO", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Bogota" });

  let subject: string;
  if (result.errores.length > 0) {
    subject = `⚠️ Facturas ${today}: ${result.procesadas.length} OK, ${result.errores.length} con error`;
  } else if (result.procesadas.length > 0) {
    subject = `✅ Facturas ${today}: ${result.procesadas.length} procesadas`;
  } else {
    subject = `📭 Facturas ${today}: sin novedad`;
  }

  const html = renderHtmlSummary(result, today, customerId);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("Resend error:", res.status, txt);
  } else {
    console.log(`Email enviado a ${to} — total ${total} items`);
  }
}

async function notifyError(err: Error, customerId?: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  const to = process.env.NOTIFY_EMAIL_TO || "tomasramirezvilla@gmail.com";
  const from = process.env.NOTIFY_EMAIL_FROM || "Procesar-Facturas <onboarding@resend.dev>";

  const today = new Date().toLocaleDateString("es-CO", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Bogota" });
  const hint = err.message?.includes("invalid_grant")
    ? `<p style="color:#a00"><b>Causa probable:</b> el refresh token expiró o tiene un <code>=</code> de más al inicio en Netlify env vars. Corré <code>scripts/setup-oauth.mjs</code> local y actualizá <code>GOOGLE_OAUTH_REFRESH_TOKEN</code> en Netlify.</p>`
    : "";

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px">
      <h2 style="color:#c00;margin:0 0 8px">🔴 Pipeline cayó — ${today}</h2>
      <p><b>Cliente:</b> ${customerId || "owner"}</p>
      <p><b>Error:</b> <code>${escapeHtml(err.message)}</code></p>
      ${hint}
      <p style="color:#666;font-size:13px;margin-top:24px">Logs completos en Netlify dashboard → Functions → procesar-facturas-background.</p>
    </div>
  `;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject: `🔴 Procesar-Facturas: fatal (${today})`, html }),
  });
}

function renderHtmlSummary(result: PipelineResult, today: string, customerId?: string): string {
  const moneyCO = (n: number) =>
    "$" + Math.round(n).toLocaleString("es-CO");

  const procRows = result.procesadas
    .map((p) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(p.fecha)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(p.proveedor)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(p.numero)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${moneyCO(p.total)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee"><a href="${escapeHtml(p.driveLink)}">PDF</a></td>
      </tr>`)
    .join("");

  const errRows = result.errores
    .map((e) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #fcc">${escapeHtml(e.asunto || "(sin asunto)")}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #fcc"><code>${escapeHtml(e.error)}</code></td>
      </tr>`)
    .join("");

  const totalProc = result.procesadas.reduce((s, p) => s + (p.total || 0), 0);

  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:720px;color:#222">
      <h2 style="margin:0 0 4px">Resumen de facturas — ${today}</h2>
      ${customerId ? `<p style="color:#666;margin:0 0 12px">Cliente: ${customerId}</p>` : ""}

      <div style="background:#f5f7fa;padding:12px 16px;border-radius:6px;margin:16px 0">
        <strong>${result.procesadas.length}</strong> procesadas
        · <strong>${result.saltadas.length}</strong> saltadas
        · <strong style="color:${result.errores.length ? "#c00" : "#222"}">${result.errores.length}</strong> errores
        ${result.procesadas.length > 0 ? `<br><span style="color:#666">Total procesado: <b>${moneyCO(totalProc)}</b></span>` : ""}
      </div>

      ${
        procRows
          ? `<h3 style="margin:20px 0 8px">✅ Procesadas (${result.procesadas.length})</h3>
             <table style="border-collapse:collapse;width:100%;font-size:14px">
               <thead><tr style="background:#fafafa">
                 <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #ddd">Fecha</th>
                 <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #ddd">Proveedor</th>
                 <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #ddd">N° Factura</th>
                 <th style="padding:8px 10px;text-align:right;border-bottom:2px solid #ddd">Total</th>
                 <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #ddd"></th>
               </tr></thead>
               <tbody>${procRows}</tbody>
             </table>`
          : `<p style="color:#666;margin:16px 0">Sin facturas nuevas hoy.</p>`
      }

      ${
        errRows
          ? `<h3 style="margin:24px 0 8px;color:#c00">⚠️ Errores (${result.errores.length})</h3>
             <table style="border-collapse:collapse;width:100%;font-size:14px">
               <thead><tr style="background:#fff5f5">
                 <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #fcc">Asunto</th>
                 <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #fcc">Error</th>
               </tr></thead>
               <tbody>${errRows}</tbody>
             </table>`
          : ""
      }

      <p style="margin:28px 0 4px;color:#666;font-size:13px">
        <a href="${SHEET_LINK}">📊 Abrir Sheet</a>
        &nbsp;·&nbsp;
        <a href="${DRIVE_LINK}">📁 Abrir Drive</a>
      </p>
    </div>
  `;
}

function escapeHtml(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
