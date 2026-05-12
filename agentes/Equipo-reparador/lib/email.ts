import type { ReparadorReport } from "./reparador";

export function buildReparadorEmail(report: ReparadorReport): {
  subject: string;
  html: string;
  text: string;
} {
  const totalReparadas = report.filas_reparadas.length;
  const totalHuerfanos = report.pdfs_huerfanos.length;
  const totalFilasSinPdf = report.filas_sin_pdf.length;
  const totalAlertas = totalReparadas + totalHuerfanos + totalFilasSinPdf;

  const subject =
    totalAlertas > 0
      ? `Operatto Reparador · ${totalReparadas} reparadas, ${totalHuerfanos + totalFilasSinPdf} requieren revisión · ${report.fecha}`
      : `Operatto Reparador · todo OK · ${report.fecha}`;

  // === Resumen ==============================================================
  const resumen = `
    <div style="background:#f7f5f0;border:1px solid #d8d3c8;padding:20px;border-radius:8px;margin-bottom:24px;">
      <div style="font-size:11px;letter-spacing:0.1em;color:#666;text-transform:uppercase;margin-bottom:8px;">
        Reparador diario · ${report.fecha}
      </div>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding-right:16px;border-right:1px solid #e6e0d2;">
            <div style="font-size:28px;font-weight:600;color:${totalReparadas > 0 ? "#1a8a4a" : "#1a1a1a"};">${totalReparadas}</div>
            <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.06em;">filas auto-reparadas</div>
          </td>
          <td style="padding:0 16px;border-right:1px solid #e6e0d2;">
            <div style="font-size:28px;font-weight:600;color:${totalHuerfanos > 0 ? "#c4901c" : "#1a1a1a"};">${totalHuerfanos}</div>
            <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.06em;">PDFs huérfanos</div>
          </td>
          <td style="padding:0 16px;">
            <div style="font-size:28px;font-weight:600;color:${totalFilasSinPdf > 0 ? "#c4901c" : "#1a1a1a"};">${totalFilasSinPdf}</div>
            <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.06em;">filas sin PDF</div>
          </td>
        </tr>
      </table>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e6e0d2;font-size:11px;color:#666;">
        Procesados ${report.clientes_procesados}/${report.clientes_total} clientes · ${report.clientes_skipped} skipped (sin OAuth/Sheet) · ${report.errores.length} errores
      </div>
    </div>
  `;

  // === Filas reparadas (Etapa 1, auto) ======================================
  const reparadasBlock =
    totalReparadas === 0
      ? `<p style="font-size:13px;color:#666;margin:16px 0;">✓ No hubo filas faltantes para reparar.</p>`
      : `
        <div style="margin-bottom:24px;">
          <h2 style="font-size:14px;letter-spacing:0.05em;text-transform:uppercase;color:#1a1a1a;margin:0 0 12px 0;">
            ✓ Filas auto-reparadas (insertadas en Sheet)
          </h2>
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr style="border-bottom:1px solid #d8d3c8;">
                <th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#666;">Cliente</th>
                <th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#666;">Mes</th>
                <th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#666;">N° Doc</th>
                <th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#666;">Proveedor</th>
                <th style="text-align:right;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#666;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${report.filas_reparadas.slice(0, 50).map((r) => `
                <tr style="border-bottom:1px solid #ebe8df;">
                  <td style="padding:6px 10px;">${escapeHtml(r.cliente_slug)}</td>
                  <td style="padding:6px 10px;">${r.mes}</td>
                  <td style="padding:6px 10px;font-family:monospace;font-size:11px;">${escapeHtml(r.num_factura)}</td>
                  <td style="padding:6px 10px;">${escapeHtml(r.proveedor)}</td>
                  <td style="padding:6px 10px;text-align:right;font-family:monospace;">$${formatNumber(r.total)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
          ${totalReparadas > 50 ? `<p style="font-size:10px;color:#999;margin-top:4px;">... y ${totalReparadas - 50} más.</p>` : ""}
        </div>
      `;

  // === PDFs huérfanos (Etapa 2 — solo detección) ============================
  const huerfanosBlock =
    totalHuerfanos === 0
      ? ""
      : `
        <div style="margin-bottom:24px;">
          <h2 style="font-size:14px;letter-spacing:0.05em;text-transform:uppercase;color:#c4901c;margin:0 0 8px 0;">
            ⚠ PDFs huérfanos (Drive sin fila en Sheet) — REVISAR MANUAL
          </h2>
          <p style="font-size:11px;color:#666;margin:0 0 12px 0;">
            Solo del mes actual. Posibles causas: factura procesada pero falló el insert al Sheet,
            o archivo cargado manualmente al Drive.
          </p>
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr style="border-bottom:1px solid #d8d3c8;">
                <th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#666;">Cliente</th>
                <th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#666;">Archivo</th>
                <th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#666;">ID Drive</th>
              </tr>
            </thead>
            <tbody>
              ${report.pdfs_huerfanos.slice(0, 30).map((h) => `
                <tr style="border-bottom:1px solid #ebe8df;">
                  <td style="padding:6px 10px;">${escapeHtml(h.cliente_slug)}</td>
                  <td style="padding:6px 10px;">${escapeHtml(h.drive_file_name)}</td>
                  <td style="padding:6px 10px;font-family:monospace;font-size:10px;color:#999;">${escapeHtml(h.drive_file_id.slice(0, 12))}…</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
          ${totalHuerfanos > 30 ? `<p style="font-size:10px;color:#999;margin-top:4px;">... y ${totalHuerfanos - 30} más.</p>` : ""}
        </div>
      `;

  // === Filas sin PDF (Etapa 2 — solo detección) =============================
  const filasSinPdfBlock =
    totalFilasSinPdf === 0
      ? ""
      : `
        <div style="margin-bottom:24px;">
          <h2 style="font-size:14px;letter-spacing:0.05em;text-transform:uppercase;color:#c4901c;margin:0 0 8px 0;">
            ⚠ Filas en Sheet SIN PDF en Drive — REVISAR MANUAL
          </h2>
          <p style="font-size:11px;color:#666;margin:0 0 12px 0;">
            Solo del mes actual. Posibles causas: PDF eliminado manualmente del Drive,
            o fallo del upload al procesar.
          </p>
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr style="border-bottom:1px solid #d8d3c8;">
                <th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#666;">Cliente</th>
                <th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#666;">N° Doc</th>
                <th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#666;">Proveedor</th>
              </tr>
            </thead>
            <tbody>
              ${report.filas_sin_pdf.slice(0, 30).map((f) => `
                <tr style="border-bottom:1px solid #ebe8df;">
                  <td style="padding:6px 10px;">${escapeHtml(f.cliente_slug)}</td>
                  <td style="padding:6px 10px;font-family:monospace;font-size:11px;">${escapeHtml(f.num_factura)}</td>
                  <td style="padding:6px 10px;">${escapeHtml(f.proveedor)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
          ${totalFilasSinPdf > 30 ? `<p style="font-size:10px;color:#999;margin-top:4px;">... y ${totalFilasSinPdf - 30} más.</p>` : ""}
        </div>
      `;

  // === Errores ==============================================================
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
          <span style="color:#999;font-size:11px;margin-left:8px;">· Reparador</span>
        </div>
        ${resumen}
        ${reparadasBlock}
        ${huerfanosBlock}
        ${filasSinPdfBlock}
        ${erroresBlock}
        <p style="font-size:11px;color:#999;margin:32px 0 0 0;">
          Reporte generado a las ${new Date(report.ts_generated).toLocaleString("es-CO", { timeZone: "America/Bogota" })}.<br>
          El reparador corre todos los días a las 8:15am Bogotá (después del monitor).<br>
          Auto-reparación: solo Etapa 1 (filas faltantes en Sheet desde agent_events).<br>
          Etapa 2 es solo detección — los PDFs huérfanos y filas sin PDF requieren revisión manual.
        </p>
      </div>
    </body></html>
  `;

  // === Plain text ===========================================================
  const text = [
    `Operatto · Reparador · ${report.fecha}`,
    ``,
    `Filas auto-reparadas: ${totalReparadas}`,
    `PDFs huérfanos: ${totalHuerfanos}`,
    `Filas sin PDF: ${totalFilasSinPdf}`,
    `Clientes: ${report.clientes_procesados}/${report.clientes_total} procesados`,
    `Errores: ${report.errores.length}`,
    ``,
    totalReparadas > 0
      ? `Reparadas:\n${report.filas_reparadas.slice(0, 20).map((r) => `  - ${r.cliente_slug} mes=${r.mes} #${r.num_factura} ${r.proveedor} $${formatNumber(r.total)}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, html, text };
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

function formatNumber(n: number): string {
  return new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 }).format(n);
}
