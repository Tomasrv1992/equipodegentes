// netlify/functions/rename-drive-files-background.mts
//
// Background function (15min timeout). Renombra PDFs en Drive para que
// coincidan con consecutivos actuales del Sheet. Si un PDF no tiene match
// en el Sheet → es huérfano, se mueve a subcarpeta _huerfanos.
//
// Para cada subfolder mensual (2026-01..2026-12):
//   1. Lee Sheet del mes
//   2. Construye mapa: numero (col E) → consecutivo (col A)
//   3. Lista archivos del subfolder Drive
//   4. Para cada archivo:
//      a) Extrae numero del nombre
//      b) Si tiene match en Sheet con consec X → renombrar con X
//      c) Si NO tiene match → mover a _huerfanos
//
// Body: { clienteSlug }

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  if (req.headers.get("x-internal-secret") !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  if (!clienteSlug) return new Response("missing clienteSlug", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });
  const clienteId = (cli as any).id as string;

  const cred = await loadCredentials(clienteId, "facturacion");
  if (!cred?.google_refresh_token || !cred.sheet_id || !cred.drive_folder_id) {
    return new Response("missing creds", { status: 400 });
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_WEB_CLIENT_ID,
    process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const sheets = google.sheets({ version: "v4", auth });
  const drive = google.drive({ version: "v3", auth });

  // Listar subfolders del cliente
  const driveSubfolders = await drive.files.list({
    q: `'${cred.drive_folder_id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)",
    pageSize: 200,
  });
  const subfolderByName = new Map<string, string>();
  for (const f of driveSubfolders.data.files ?? []) {
    if (f.name && f.id) subfolderByName.set(f.name, f.id);
  }

  const reporte: any = {
    cliente: clienteSlug,
    por_mes: [] as any[],
    pdfs_renombrados_total: 0,
    pdfs_huerfanos_total: 0,
    errores: [] as string[],
  };

  for (let mIdx = 0; mIdx < 12; mIdx++) {
    const tabName = MES_TABS[mIdx];
    const mes = mIdx + 1;
    const subfolderName = `2026-${String(mes).padStart(2, "0")}`;
    const subfolderId = subfolderByName.get(subfolderName);
    if (!subfolderId) continue;

    const stats = {
      tab: tabName,
      renombrados: 0,
      huerfanos: 0,
      errores: [] as string[],
    };

    try {
      // Leer Sheet
      const r = await sheets.spreadsheets.values.get({
        spreadsheetId: cred.sheet_id,
        range: `'${tabName}'!A2:O1000`,
      });
      const rows = r.data.values || [];

      // Mapa: numero (col E) → consec (col A)
      const numeroToConsec = new Map<string, number>();
      for (const row of rows) {
        const numero = String(row[4] ?? "").trim();
        const consec = Number(row[0]);
        if (numero && consec) numeroToConsec.set(numero, consec);
      }

      // Listar PDFs del subfolder
      const filesInFolder = await drive.files.list({
        q: `'${subfolderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
        fields: "files(id,name)",
        pageSize: 1000,
      });
      const allFiles = filesInFolder.data.files ?? [];

      // Get/create _huerfanos folder
      let huerfanosFolderId: string | null = null;

      for (const f of allFiles) {
        if (!f.id || !f.name) continue;
        // Extraer numero del filename: "{consec}. {numero}.*"
        const match = f.name.match(/^\d+\.\s+([A-Z0-9-]+)\./i);
        if (!match) continue;
        const numero = match[1];

        const nuevoConsec = numeroToConsec.get(numero);
        if (!nuevoConsec) {
          // Huérfano: mover a _huerfanos
          if (!huerfanosFolderId) {
            const check = await drive.files.list({
              q: `'${subfolderId}' in parents and name='_huerfanos' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
              fields: "files(id)",
            });
            if ((check.data.files ?? []).length > 0) {
              huerfanosFolderId = check.data.files![0].id ?? null;
            } else {
              const newFolder = await drive.files.create({
                requestBody: {
                  name: "_huerfanos",
                  mimeType: "application/vnd.google-apps.folder",
                  parents: [subfolderId],
                },
                fields: "id",
              });
              huerfanosFolderId = newFolder.data.id ?? null;
            }
          }
          try {
            await drive.files.update({
              fileId: f.id,
              addParents: huerfanosFolderId!,
              removeParents: subfolderId,
              fields: "id",
            });
            stats.huerfanos++;
          } catch (e: any) {
            stats.errores.push(`huérfano ${f.name}: ${e.message}`);
          }
          continue;
        }

        // Renombrar si difiere
        const newName = f.name.replace(/^\d+\./, `${nuevoConsec}.`);
        if (newName !== f.name) {
          try {
            await drive.files.update({
              fileId: f.id,
              requestBody: { name: newName },
              fields: "id",
            });
            stats.renombrados++;
          } catch (e: any) {
            stats.errores.push(`renombrar ${f.name}: ${e.message}`);
          }
        }
      }

      reporte.pdfs_renombrados_total += stats.renombrados;
      reporte.pdfs_huerfanos_total += stats.huerfanos;
    } catch (e: any) {
      stats.errores.push(`${tabName}: ${e.message}`);
    }

    reporte.por_mes.push(stats);
  }

  return new Response(JSON.stringify(reporte, null, 2), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {};
