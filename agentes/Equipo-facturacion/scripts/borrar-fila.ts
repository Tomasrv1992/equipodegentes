// Lee o borra filas específicas del Sheet. SEGURO: muestra antes; borra solo con --apply.
// Uso:
//   read:   borrar-fila.ts <Mes> <fila>            -> muestra la fila
//   delete: borrar-fila.ts <Mes> <fila> --apply    -> manda la fila a... la borra (deleteDimension)
import { google } from "googleapis";
async function main() {
  const mes = process.argv[2];
  const fila = parseInt(process.argv[3] || "0", 10);
  const apply = process.argv.includes("--apply");
  const a = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  a.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  const s = google.sheets({ version: "v4", auth: a });
  const id = process.env.INVOICES_SHEET_ID!;
  const r = await s.spreadsheets.values.get({ spreadsheetId: id, range: `'${mes}'!A${fila}:M${fila}`, valueRenderOption: "UNFORMATTED_VALUE" });
  console.log(`${mes}!${fila}:`, JSON.stringify(r.data.values?.[0]));
  if (!apply) { console.log("(read-only; --apply para borrar)"); return; }
  const meta = await s.spreadsheets.get({ spreadsheetId: id });
  const sh = (meta.data.sheets || []).find((x: any) => x.properties.title === mes);
  if (!sh) { console.log("pestaña no existe"); return; }
  await s.spreadsheets.batchUpdate({
    spreadsheetId: id,
    requestBody: { requests: [{ deleteDimension: { range: { sheetId: sh.properties!.sheetId, dimension: "ROWS", startIndex: fila - 1, endIndex: fila } } }] },
  });
  console.log(`BORRADA fila ${fila} de ${mes}`);
}
main().catch((e) => console.log("ERR", e?.message ?? e));
