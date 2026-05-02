// One-off diagnostic — verifica estado de Gmail / Drive / Sheets
// Uso: npx tsx --env-file=.env.local scripts/diagnostico-facturas.ts
import { google } from "googleapis";

async function main() {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });

  const gmail = google.gmail({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });
  const sheets = google.sheets({ version: "v4", auth });

  const sheetId = process.env.INVOICES_SHEET_ID!;
  const folderId = process.env.INVOICES_DRIVE_FOLDER_ID!;

  console.log("=== SHEET Gastos 2026 ===");
  const sh = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "'Gastos 2026'!A:I" });
  const rows = sh.data.values || [];
  console.log("Total filas (incl header):", rows.length);
  console.log("Filas de datos:", rows.length - 1);
  if (rows.length > 1) {
    console.log("Primera fila datos:", JSON.stringify(rows[1]));
    console.log("Última fila datos:", JSON.stringify(rows[rows.length - 1]));
  }

  console.log("\n=== DRIVE subcarpetas en folder de facturas ===");
  const subFolders = await drive.files.list({
    q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name, createdTime)",
    orderBy: "createdTime desc",
  });
  for (const f of subFolders.data.files || []) {
    const inside = await drive.files.list({
      q: `'${f.id}' in parents and trashed=false`,
      fields: "files(id)",
    });
    console.log(`  ${f.name}: ${inside.data.files?.length || 0} archivos (created ${f.createdTime})`);
  }

  console.log("\n=== GMAIL ===");
  const labelsRes = await gmail.users.labels.list({ userId: "me" });
  const procesado = labelsRes.data.labels?.find((l) => l.name === "Procesado");
  if (procesado) {
    const withLabel = await gmail.users.messages.list({
      userId: "me",
      q: "filename:zip label:Procesado newer_than:30d",
      maxResults: 500,
    });
    const withoutLabel = await gmail.users.messages.list({
      userId: "me",
      q: "filename:zip -label:Procesado newer_than:30d",
      maxResults: 500,
    });
    console.log("Facturas ZIP últ 30d CON label Procesado:", withLabel.data.resultSizeEstimate ?? 0);
    console.log("Facturas ZIP últ 30d SIN label (pendientes):", withoutLabel.data.resultSizeEstimate ?? 0);
  } else {
    console.log("Label Procesado no existe todavía");
  }
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
