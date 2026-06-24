// Auto-resize de columnas en todas las pestañas (para que no quede texto cortado).
import { google } from "googleapis";
const M = ["Dashboard","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
async function main() {
  const a = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  a.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  const s = google.sheets({ version: "v4", auth: a });
  const meta = await s.spreadsheets.get({ spreadsheetId: process.env.INVOICES_SHEET_ID! });
  const byTitle: Record<string, number> = {};
  (meta.data.sheets || []).forEach((sh: any) => { byTitle[sh.properties.title] = sh.properties.sheetId; });
  const reqs: any[] = [];
  for (const t of M) {
    const id = byTitle[t];
    if (id == null) continue;
    reqs.push({ autoResizeDimensions: { dimensions: { sheetId: id, dimension: "COLUMNS", startIndex: 0, endIndex: 13 } } });
  }
  await s.spreadsheets.batchUpdate({ spreadsheetId: process.env.INVOICES_SHEET_ID!, requestBody: { requests: reqs } });
  console.log(`Auto-resize aplicado a ${reqs.length} pestañas.`);
}
main().catch((e) => console.log("ERR", e?.message ?? e));
