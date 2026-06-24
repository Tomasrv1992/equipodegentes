// Diagnóstico Enero: compara PDFs en Drive 2026-01 vs filas del Sheet (Enero, col D).
import { google } from "googleapis";
function parseNum(name: string): string | null {
  const base = String(name ?? "").replace(/\.[a-z0-9]+$/i, "");
  const i = base.indexOf(". ");
  if (i <= 0) return null;
  return base.slice(0, i).trim() || null;
}
async function main() {
  const a = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  a.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  const drive = google.drive({ version: "v3", auth: a });
  const sheets = google.sheets({ version: "v4", auth: a });

  // Drive: subcarpeta 2026-01
  const sub = await drive.files.list({ q: `'${process.env.INVOICES_DRIVE_FOLDER_ID}' in parents and name='2026-01' and mimeType='application/vnd.google-apps.folder' and trashed=false`, fields: "files(id)" });
  const folderId = sub.data.files?.[0]?.id;
  const files: string[] = [];
  if (folderId) { let pt: any; do { const r: any = await drive.files.list({ q: `'${folderId}' in parents and trashed=false`, fields: "nextPageToken,files(name,mimeType)", pageSize: 1000, pageToken: pt }); files.push(...(r.data.files ?? []).map((f: any) => f.name)); pt = r.data.nextPageToken; } while (pt); }

  // Sheet Enero col B(prov) + D(numero)
  const sr = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.INVOICES_SHEET_ID!, range: `'Enero'!B2:D` });
  const sheetNums = new Set<string>();
  (sr.data.values ?? []).forEach((r: any[]) => { const n = String(r[2] ?? "").trim(); if (n) sheetNums.add(n); });

  const driveNums = new Map<string, string>(); // num -> filename
  files.forEach((f) => { const n = parseNum(f); if (n) driveNums.set(n, f); });

  console.log(`Drive 2026-01: ${files.length} archivos | Sheet Enero: ${sheetNums.size} numeros\n`);
  console.log("== En Drive pero NO en Sheet ==");
  [...driveNums.entries()].filter(([n]) => !sheetNums.has(n)).forEach(([n, f]) => console.log(`  ${f}`));
  const noParse = files.filter((f) => !parseNum(f));
  if (noParse.length) { console.log("\n== Drive sin numero parseable =="); noParse.forEach((f) => console.log("  " + f)); }
  console.log("\n== En Sheet pero NO en Drive ==");
  [...sheetNums].filter((n) => !driveNums.has(n)).slice(0, 20).forEach((n) => console.log(`  ${n}`));
}
main().catch((e) => console.log("ERR", e?.message ?? e));
