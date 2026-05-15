import type { InspectorReport, ClienteCheckResult } from "./inspector";

/**
 * Genera HTML + subject del email diario del inspector al admin.
 */
export function buildInspectorEmail(report: InspectorReport): {
  subject: string;
  html: string;
  text: string;
} {
  const alertCount = report.clientes_con_alerta;
  const okCount = report.clientes_ok;
  const total = report.clientes_total;

  const subject =
    alertCount > 0
      ? `Operatto · ${alertCount} alerta${alertCount > 1 ? "s" : ""} · ${report.fecha}`
      : `Operatto · ${okCount}/${total} OK · ${report.fecha}`;

  // === Bloque resumen superior ==============================================
  const costoStr = `$${report.costo_anthropic_usd.toFixed(3)}`;
  const costoColor = report.costo_alerta ? "#c44b27" : "#1a8a4a";
  const resumen = `
    <div style="background:#f7f5f0;border:1px solid #d8d3c8;padding:20px;border-radius:8px;margin-bottom:24px;">
      <div style="font-size:11px;letter-spacing:0.1em;color:#666;text-transform:uppercase;margin-bottom:8px;">
        Reporte diario · ${report.fecha}
      </div>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="font-size:32px;font-weight:600;color:#1a1a1a;padding-right:24px;">${okCount}/${total}</td>
          <td style="font-size:13px;color:#555;line-height:1.5;">
            clientes procesados OK
            ${alertCount > 0 ? `<br><strong style="color:#c44b27;">⚠ ${alertCount} requieren atención</strong>` : ""}
            ${report.zombies_cerrados > 0 ? `<br><span style="color:#999;font-size:11px;">${report.zombies_cerrados} runs zombie cerrados automáticamente</span>` : ""}
          </td>
        </tr>
      </table>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e6e0d2;display:flex;gap:16px;font-size:12px;color:#555;">
        <span><strong style="color:${costoColor};">${costoStr}</strong> costo Anthropic hoy</span>
        <span>·</span>
        <span><strong>${report.llm_calls_dia}</strong> llamadas LLM</span>
        ${report.costo_alerta ? '<span style="color:#c44b27;">⚠ supera umbral</span>' : ""}
      </div>
    </div>
  `;

  // === Tabla de alertas (si hay) ============================================
  const alertas = report.clientes.filter((c) =>
    ["fail", "oauth_broken", "no_run", "warn"].includes(c.estado),
  );

  const alertasBlock =
    alertas.length === 0
      ? `<p style="font-size:14px;color:#1a8a4a;margin:24px 0;">✓ Todos los clientes procesaron sin incidencias.</p>`
      : `
        <div style="margin-bottom:24px;">
          <h2 style="font-size:14px;letter-spacing:0.05em;text-transform:uppercase;color:#1a1a1a;margin:0 0 12px 0;">Alertas</h2>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="border-bottom:1px solid #d8d3c8;">
                <th style="text-align:left;padding:8px 12px;font-size:11px;text-transform:uppercase;color:#666;">Cliente</th>
                <th style="text-align:left;padding:8px 12px;font-size:11px;text-transform:uppercase;color:#666;">Estado</th>
                <th style="text-align:left;padding:8px 12px;font-size:11px;text-transform:uppercase;color:#666;">Detalle</th>
              </tr>
            </thead>
            <tbody>
              ${alertas.map(rowHtml).join("")}
            </tbody>
          </table>
        </div>
      `;

  // === Tabla de OK ==========================================================
  const oks = report.clientes.filter((c) => c.estado === "ok");
  const oksBlock =
    oks.length === 0
      ? ""
      : `
        <div style="margin-bottom:24px;">
          <h2 style="font-size:14px;letter-spacing:0.05em;text-transform:uppercase;color:#1a1a1a;margin:0 0 12px 0;">OK (${oks.length})</h2>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <tbody>
              ${oks.map(rowHtml).join("")}
            </tbody>
          </table>
        </div>
      `;

  const html = `
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"></head>
    <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;background:#fafaf7;padding:24px;">
      <div style="max-width:680px;margin:0 auto;background:#fff;padding:32px;border-radius:12px;border:1px solid #ebe8df;">
        <div style="margin-bottom:24px;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#c44b27;margin-right:8px;"></span>
          <strong style="font-size:14px;letter-spacing:-0.02em;">Operatto</strong>
          <span style="color:#999;font-size:11px;margin-left:8px;">· Monitor diario</span>
        </div>
        ${resumen}
        ${alertasBlock}
        ${oksBlock}
        <p style="font-size:11px;color:#999;margin:32px 0 0 0;">
          Reporte generado a las ${new Date(report.ts_generated).toLocaleString("es-CO", { timeZone: "America/Bogota" })}.<br>
          El cron de facturación corre todos los días a las 7am Bogotá. Este reporte corre a las 8am.
        </p>
      </div>
    </body></html>
  `;

  const text = buildPlainText(report);

  return { subject, html, text };
}

function rowHtml(c: ClienteCheckResult): string {
  const badgeColor: Record<string, string> = {
    ok: "#1a8a4a",
    warn: "#c4901c",
    fail: "#c44b27",
    oauth_broken: "#c44b27",
    no_run: "#c44b27",
    running: "#666",
    no_agente: "#999",
  };
  const color = badgeColor[c.estado] ?? "#666";
  const coincidenciaHtml = c.coincidencia
    ? `<br><span style="font-size:10px;color:#999;font-family:monospace;">${escapeHtml(c.coincidencia.detalle)}</span>`
    : "";
  return `
    <tr style="border-bottom:1px solid #ebe8df;">
      <td style="padding:10px 12px;font-weight:500;">${escapeHtml(c.nombre)}</td>
      <td style="padding:10px 12px;">
        <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;background:${color}20;color:${color};">
          ${c.estado.replace("_", " ")}
        </span>
      </td>
      <td style="padding:10px 12px;color:#555;font-size:12px;">
        ${escapeHtml(c.detalle)}
        ${coincidenciaHtml}
      </td>
    </tr>
  `;
}

function escapeHtml(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildPlainText(report: InspectorReport): string {
  const lines: string[] = [
    `Operatto · Monitor diario · ${report.fecha}`,
    ``,
    `Clientes: ${report.clientes_ok}/${report.clientes_total} OK`,
    `Alertas: ${report.clientes_con_alerta}`,
    `Zombies cerrados: ${report.zombies_cerrados}`,
    `Costo Anthropic hoy: $${report.costo_anthropic_usd.toFixed(3)} (${report.llm_calls_dia} llamadas)`,
    report.costo_alerta ? `⚠ Costo supera umbral` : "",
    ``,
  ];
  const alertas = report.clientes.filter((c) =>
    ["fail", "oauth_broken", "no_run", "warn"].includes(c.estado),
  );
  if (alertas.length > 0) {
    lines.push("── Alertas ──");
    for (const a of alertas) {
      lines.push(`[${a.estado.toUpperCase()}] ${a.nombre} (${a.slug})`);
      lines.push(`  ${a.detalle}`);
    }
    lines.push("");
  }
  const oks = report.clientes.filter((c) => c.estado === "ok");
  if (oks.length > 0) {
    lines.push("── OK ──");
    for (const c of oks) {
      lines.push(`✓ ${c.nombre}: ${c.detalle}`);
    }
  }
  return lines.join("\n");
}
