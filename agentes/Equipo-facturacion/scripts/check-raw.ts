import { google } from "googleapis";
async function main() {
  const a = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  a.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  const s = google.sheets({ version: "v4", auth: a });
  const id = process.env.INVOICES_SHEET_ID!;
  const u = await s.spreadsheets.values.get({ spreadsheetId: id, range: "'Enero'!E2:J4", valueRenderOption: "UNFORMATTED_VALUE" });
  console.log("Enero E2:J4 UNFORMATTED:");
  (u.data.values || []).forEach((r: any[], i) => console.log(`  fila${i + 2}:`, JSON.stringify(r), "| tipos:", r.map((v) => typeof v).join(",")));
  for (const [mes, fila] of [["Marzo", 102], ["Abril", 62]] as [string, number][]) {
    const h = await s.spreadsheets.values.get({ spreadsheetId: id, range: `'${mes}'!A${fila}:M${fila}`, valueRenderOption: "UNFORMATTED_VALUE" });
    console.log(`${mes} A${fila}:M${fila}:`, JSON.stringify(h.data.values?.[0]));
  }
}
main().catch((e) => console.log("ERR", e?.message ?? e));
