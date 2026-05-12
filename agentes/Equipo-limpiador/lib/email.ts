import type { LimpiadorReport, AccionLimpiador } from "./limpiador";

export function buildLimpiadorEmail(report: LimpiadorReport): {
  subject: string;
  html: string;
  text: string;
} {
  const dup = report.duplicados_movidos;
  const rec = report.facturas_recuperadas;
  const noid = report.no_identificables;
  const self = report.self_emitted_ignorados;
  const total = report.total_huerfanos_analizados;

  const subject =
    total === 0
      ? `Operatto Limpiador · sin huérfanos · ${report.fecha}`
      : `Operatto Limpiador · ${dup} duplicados, ${rec} recuperadas, ${noid} para revisar · ${report.fecha}`;

  const resumen = `
    <div style="background:#f7f5f0;border:1px solid #d8d3c8;padding:20px;border-radius:8px;margin-bottom:24px;">
      <div style="font-size:11px;letter-spacing:0.1em;color:#666;text-transform:uppercase;margin-bottom:8px;">
        Limpiador diario · ${report.fecha}
      </div>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding-right:14px;border-right:1px solid #e6e0d2;">
            <div style="font-size:26px;font-weight:600;color:${dup > 0 ? "#c4901c" : "#1a1a1a"};">${dup}</div>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.06em;">Duplicados movidos</div>
          </td>
          <td style="padding:0 14px;border-right:1px solid #e6e0d2;">
            <div style="font-size:26px;font-weight:600;color:${rec > 0 ? "#1a8a4a" : "#1a1a1a"};">${rec}</div>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.06em;">Facturas recuperadas</div>
          </td>
          <td style="padding:0 14px;border-right:1px solid #e6e0d2;">
            <div style="font-size:26px;font-weight:600;color:${noid > 0 ? "#c44b27" : "#1a1a1a"};">${noid}</div>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.06em;">Para revisar</div>
          </td>
          <td style="padding:0 14px;">
            <div style="font-size:26px;font-weight:600;color:#1a1a1a;">$${report.costo_llm_usd.toFixed(3)}</div>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.06em;">Costo LLM</div>
          </td>
        </tr>
      </table>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e6e0d2;font-size:11px;color:#666;">
        Analizados ${total} huérfanos · ${report.clientes_procesados}/${report.clientes_total} clientes · ${self} ignorados (cliente=emisor) · ${report.errores.length} errores
      </div>
    </div>
  `;

  const duplicadosBlock = buildBlock(
    "🗑 Duplicados (movidos a Papelera de Drive)",
    "#c4901c",
    report.acciones.filter((a) => a.tipo === "duplicado"),
    "Estos PDFs son copias de facturas ya registradas. Se movieron a la Papelera de Drive — quedan recuperables durante 30 días por si el LLM se equivocó.",
  );

  const selfEmittedBlock = buildBlock(
    "🚫 Ignorados — cliente es emisor",
    "#666",
    report.acciones.filter((a) => a.tipo === "self_emitted_ignorado"),
    "El LLM identificó que el NIT del proveedor coincide con el del cliente. Son cuentas de cobro/planillas que el cliente EMITE, no facturas que recibe. Archivos intactos en Drive.",
  );

  const recuperadasBlock = buildBlock(
    "✓ Facturas recuperadas (creadas en DB + Sheet)",
    "#1a8a4a",
    report.acciones.filter((a) => a.tipo === "factura_recuperada"),
    "Estos PDFs eran facturas que NO estaban registradas. El limpiador identificó datos válidos y creó la fila en Sheet + event en DB.",
  );

  const noIdBlock = buildBlock(
    "⚠ No identificables (requieren revisión manual)",
    "#c44b27",
    report.acciones.filter((a) => a.tipo === "no_identificable"),
    "El LLM no pudo identificar datos válidos. Pueden ser: PDFs escaneados sin OCR, archivos no-factura (catálogos, certificados, etc), o cifrados.",
  );

  const erroresBlock =
    report.errores.length === 0
      ? ""
      : `
        <div style="margin-bottom:24px;">
          <h2 style="font-size:14px;letter-spacing:0.05em;text-transform:uppercase;color:#c44b27;margin:0 0 8px 0;">
            ✗ Errores por cliente
          </h2>
          ${report.errores.map((e) => `
            <div style="font-size:12px;color:#555;padding:6px 0;border-bottom:1px solid #ebe8df;">
              <strong>${escapeHtml(e.cliente_slug)}:</strong> ${escapeHtml(e.error)}
            </div>
          `).join("")}
        </div>
      `;

  const html = `
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"></head>
    <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;background:#fafaf7;padding:24px;">
      <div style="max-width:760px;margin:0 auto;background:#fff;padding:32px;border-radius:12px;border:1px solid #ebe8df;">
        <div style="margin-bottom:24px;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#c44b27;margin-right:8px;"></span>
          <strong style="font-size:14px;letter-spacing:-0.02em;">Operatto</strong>
          <span style="color:#999;font-size:11px;margin-left:8px;">· Limpiador</span>
        </div>
        ${resumen}
        ${duplicadosBlock}
        ${recuperadasBlock}
        ${selfEmittedBlock}
        ${noIdBlock}
        ${erroresBlock}
        <p style="font-size:11px;color:#999;margin:32px 0 0 0;">
          Generado a las ${new Date(report.ts_generated).toLocaleString("es-CO", { timeZone: "America/Bogota" })}.<br>
          El limpiador corre 8:30am Bogotá (después de monitor 8:00 y reparador 8:15).<br>
          Procesa TODOS los PDFs huérfanos sin límite. Descarga + LLM identifica + compara con DB.
        </p>
      </div>
    </body></html>
  `;

  const text = [
    `Operatto Limpiador · ${report.fecha}`,
    ``,
    `Duplicados: ${dup}`,
    `Recuperadas: ${rec}`,
    `Sin identificar: ${noid}`,
    `Total analizados: ${total}`,
    `Costo LLM: $${report.costo_llm_usd.toFixed(3)}`,
  ].join("\n");

  return { subject, html, text };
}

function buildBlock(
  title: string,
  color: string,
  acciones: AccionLimpiador[],
  descripcion: string,
): string {
  if (acciones.length === 0) return "";
  return `
    <div style="margin-bottom:24px;">
      <h2 style="font-size:14px;letter-spacing:0.05em;text-transform:uppercase;color:${color};margin:0 0 8px 0;">
        ${title} · ${acciones.length}
      </h2>
      <p style="font-size:11px;color:#666;margin:0 0 12px 0;">${descripcion}</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="border-bottom:1px solid #d8d3c8;">
            <th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#666;">Cliente</th>
            <th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#666;">Archivo</th>
            <th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#666;">N° Doc</th>
            <th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#666;">Detalle</th>
          </tr>
        </thead>
        <tbody>
          ${acciones.slice(0, 100).map((a) => `
            <tr style="border-bottom:1px solid #ebe8df;">
              <td style="padding:6px 10px;">${escapeHtml(a.cliente_slug)}</td>
              <td style="padding:6px 10px;font-size:11px;">${escapeHtml(a.drive_file_name)}</td>
              <td style="padding:6px 10px;font-family:monospace;font-size:11px;">${escapeHtml(a.num_factura ?? "-")}</td>
              <td style="padding:6px 10px;color:#555;font-size:11px;">${escapeHtml(a.detalle)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${acciones.length > 100 ? `<p style="font-size:10px;color:#999;margin-top:4px;">... y ${acciones.length - 100} más.</p>` : ""}
    </div>
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
