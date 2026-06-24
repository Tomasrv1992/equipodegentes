// Crea un Spreadsheet nuevo + carpeta de Drive nueva (vacíos) en la cuenta del
// OAuth actual, y escribe sus IDs en .env.local (INVOICES_SHEET_ID / FOLDER_ID).
// El pipeline crea solas las pestañas mensuales y subcarpetas; solo necesita estos
// dos contenedores vacíos.
import { google } from "googleapis";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");

function setEnv(key: string, value: string) {
  let c = readFileSync(ENV_PATH, "utf8");
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "m");
  const line = `${key}=${value}`;
  c = re.test(c) ? c.replace(re, line) : (c.endsWith("\n") ? c : c + "\n") + line + "\n";
  writeFileSync(ENV_PATH, c, "utf8");
}

async function main() {
  const year = new Date().getFullYear();
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  const drive = google.drive({ version: "v3", auth });
  const sheets = google.sheets({ version: "v4", auth });

  const me = await google.gmail({ version: "v1", auth }).users.getProfile({ userId: "me" });
  console.log("Cuenta:", me.data.emailAddress, "\n");

  // 1) Carpeta de Drive (parent; el pipeline crea las subcarpetas YYYY-MM).
  const folder = await drive.files.create({
    requestBody: { name: `Facturas Dentilandia`, mimeType: "application/vnd.google-apps.folder" },
    fields: "id, name, webViewLink",
  });
  const folderId = folder.data.id!;
  console.log("✅ Carpeta Drive creada:", folder.data.name);
  console.log("   id:", folderId);
  console.log("   link:", folder.data.webViewLink);

  // 2) Spreadsheet vía Drive API (más confiable que sheets.create).
  //    El pipeline crea las pestañas mensuales + dashboard al correr.
  const ssFile = await drive.files.create({
    requestBody: {
      name: `Gastos Dentilandia ${year}`,
      mimeType: "application/vnd.google-apps.spreadsheet",
    },
    fields: "id, webViewLink",
  });
  const sheetId = ssFile.data.id!;
  console.log("\n✅ Spreadsheet creado:");
  console.log("   id:", sheetId);
  console.log("   url:", ssFile.data.webViewLink);
  void sheets; // (sheets queda disponible por si se necesita; no se usa aquí)

  // 3) Guardar en .env.local
  setEnv("INVOICES_DRIVE_FOLDER_ID", folderId);
  setEnv("INVOICES_SHEET_ID", sheetId);
  console.log("\n✅ .env.local actualizado (INVOICES_DRIVE_FOLDER_ID / INVOICES_SHEET_ID).");
}
main().catch((e) => { console.error("ERROR:", e?.response?.data ?? e?.message ?? e); process.exit(1); });
