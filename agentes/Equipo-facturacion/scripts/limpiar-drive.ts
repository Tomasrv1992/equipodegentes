// Limpieza de Drive (corrección repetible por mes). SEGURO:
//   - DUPLICADO  = numero ya visto en otro PDF de la carpeta -> candidato a papelera.
//   - HUÉRFANO   = numero sin fila en el Sheet -> NO se borra, solo se reporta.
//   - OK         = numero en el Sheet, 1ª copia -> se conserva.
// Normaliza ceros a la izquierda (00846 == 846).
//
// Uso:
//   ... limpiar-drive.ts <mes 1-12>            -> DRY-RUN (no borra, solo reporta)
//   ... limpiar-drive.ts <mes 1-12> --apply    -> manda DUPLICADOS a papelera
//   ... limpiar-drive.ts <mes 1-12> --apply --orphans  -> también HUÉRFANOS (riesgoso)
import { google } from "googleapis";

const MES = ["", "Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

function normNum(name: string): string {
  const base = String(name ?? "").replace(/\.[a-z0-9]+$/i, "");
  const i = base.indexOf(". ");
  const raw = (i > 0 ? base.slice(0, i) : "").trim();
  // strip ceros a la izquierda si es puramente numérico
  return /^\d+$/.test(raw) ? String(parseInt(raw, 10)) : raw.toUpperCase();
}

async function main() {
  const month = parseInt(process.argv[2] || "0", 10);
  const apply = process.argv.includes("--apply");
  const orphans = process.argv.includes("--orphans");
  if (month < 1 || month > 12) { console.log("uso: limpiar-drive.ts <mes 1-12> [--apply] [--orphans]"); return; }
  const mm = String(month).padStart(2, "0");

  const a = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  a.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  const drive = google.drive({ version: "v3", auth: a });
  const sheets = google.sheets({ version: "v4", auth: a });

  // Sheet numeros (col D) normalizados
  const sr = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.INVOICES_SHEET_ID!, range: `'${MES[month]}'!D2:D` });
  const sheetNums = new Set<string>();
  (sr.data.values ?? []).forEach((r: any[]) => { const v = String(r[0] ?? "").trim(); if (v) sheetNums.add(/^\d+$/.test(v) ? String(parseInt(v, 10)) : v.toUpperCase()); });

  // Drive PDFs de la subcarpeta YYYY-MM
  const sub = await drive.files.list({ q: `'${process.env.INVOICES_DRIVE_FOLDER_ID}' in parents and name='2026-${mm}' and trashed=false`, fields: "files(id)" });
  const fid = sub.data.files?.[0]?.id;
  if (!fid) { console.log(`No existe carpeta 2026-${mm}`); return; }
  const files: { id: string; name: string }[] = [];
  let pt: any; do { const r: any = await drive.files.list({ q: `'${fid}' in parents and trashed=false and mimeType='application/pdf'`, fields: "nextPageToken,files(id,name)", pageSize: 1000, pageToken: pt }); files.push(...(r.data.files ?? [])); pt = r.data.nextPageToken; } while (pt);

  const seen = new Set<string>();
  const dups: { id: string; name: string }[] = [];
  const orfa: { id: string; name: string }[] = [];
  let ok = 0;
  for (const f of files) {
    const n = normNum(f.name);
    if (!n) { orfa.push(f); continue; }            // sin numero parseable
    if (seen.has(n)) { dups.push(f); continue; }    // copia extra
    seen.add(n);
    if (sheetNums.has(n)) ok++;
    else orfa.push(f);                              // numero sin fila en Sheet
  }

  console.log(`\n2026-${mm}: ${files.length} PDFs | Sheet ${sheetNums.size} numeros`);
  console.log(`  OK (conservar): ${ok}`);
  console.log(`  DUPLICADOS (a papelera): ${dups.length}`); dups.forEach((f) => console.log(`     - ${f.name}`));
  console.log(`  HUÉRFANOS (revisar, NO se borran salvo --orphans): ${orfa.length}`); orfa.forEach((f) => console.log(`     ? ${f.name}`));

  if (!apply) { console.log("\n[DRY-RUN] no se borró nada. Agregá --apply para mandar DUPLICADOS a papelera."); return; }
  const toTrash = orphans ? [...dups, ...orfa] : dups;
  for (const f of toTrash) { await drive.files.update({ fileId: f.id, requestBody: { trashed: true } }); }
  console.log(`\n[APPLY] ${toTrash.length} archivos a papelera (${orphans ? "duplicados + huérfanos" : "solo duplicados"}).`);
}
main().catch((e) => console.log("ERR", e?.message ?? e));
