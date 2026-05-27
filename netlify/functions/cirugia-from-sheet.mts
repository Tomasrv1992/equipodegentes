// netlify/functions/cirugia-from-sheet.mts
//
// Cirugia LEYENDO DESDE EL SHEET (no BD). Identifica filas basura por patron
// de proveedor/numero. Borra fila + event BD si existe + PDF Drive + renumera.
//
// Body: { clienteSlug, dryRun?: boolean (default true) }
// Patrones hardcoded por ahora:
//   - proveedor matching "Planilla Seguridad Social" AND numero != nitCliente → SKIP/BORRAR
//   - proveedor matching "Jorge Aldemar Gallego" → BORRAR (bitácora)

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
  const dryRun = body.dryRun !== false;
  if (!clienteSlug) return new Response("missing clienteSlug", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id, nombre").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });
  const clienteId = (cli as any).id as string;

  const { data: credShort } = await supa
    .from("client_credentials")
    .select("nit_cliente")
    .eq("cliente_id", clienteId)
    .eq("agente_id", "facturacion")
    .single();
  const nitCliente = ((credShort as any)?.nit_cliente ?? "").replace(/\D+/g, "");

  const fullCred = await loadCredentials(clienteId, "facturacion");
  if (!fullCred?.google_refresh_token || !fullCred.sheet_id || !fullCred.drive_folder_id) {
    return new Response("missing creds", { status: 400 });
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_WEB_CLIENT_ID,
    process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: fullCred.google_refresh_token });
  const sheets = google.sheets({ version: "v4", auth });
  const drive = google.drive({ version: "v3", auth });

  // Meta sheets para obtener sheetId
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: fullCred.sheet_id,
    fields: "sheets(properties(sheetId,title,gridProperties))",
  });
  const sheetByTitle = new Map<string, any>();
  for (const s of meta.data.sheets ?? []) {
    if (s.properties?.title) sheetByTitle.set(s.properties.title, s.properties);
  }

  // Listar subfolders Drive
  const driveSubfolders = await drive.files.list({
    q: `'${fullCred.drive_folder_id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)",
    pageSize: 200,
  });
  const subfolderByName = new Map<string, string>();
  for (const f of driveSubfolders.data.files ?? []) {
    if (f.name && f.id) subfolderByName.set(f.name, f.id);
  }

  const reporte: any = {
    cliente: clienteSlug,
    nitCliente,
    dryRun,
    por_mes: {} as Record<string, any>,
    filas_a_borrar_total: 0,
    pdfs_a_borrar_total: 0,
    pdfs_huerfanos_total: 0,
    events_bd_a_borrar_total: 0,
    errores: [] as string[],
  };

  for (let mIdx = 0; mIdx < 12; mIdx++) {
    const tabName = MES_TABS[mIdx];
    const mes = mIdx + 1;
    const subfolderName = `2026-${String(mes).padStart(2, "0")}`;
    const subfolderId = subfolderByName.get(subfolderName);

    // Leer Sheet del mes
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: fullCred.sheet_id,
      range: `'${tabName}'!A2:O1000`,
    });
    const rows = r.data.values || [];
    if (rows.length === 0) continue;

    // Identificar filas basura
    const filasBasura: Array<{ rowIndex: number; row: any[]; razon: string }> = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const proveedor = String(row[2] ?? "").toLowerCase();
      const nit = String(row[3] ?? "").replace(/\D+/g, "");
      const numero = String(row[4] ?? "").trim();

      // Patron 1: Planilla SS de tercero
      if (proveedor.includes("planilla seguridad social")) {
        // El "numero" en planillas SS es la cedula del titular. Si numero != nitCliente → tercero.
        // Si numero está vacío también es tercero (no es del cliente, vendría con su NIT explícito).
        if (numero !== nitCliente) {
          filasBasura.push({ rowIndex: i + 2, row, razon: `planilla_ss_tercero (titular ${numero || "vacio"})` });
          continue;
        }
      }

      // Patron 2: Bitácora Jorge Aldemar Gallego
      if (proveedor.includes("jorge aldemar gallego")) {
        filasBasura.push({ rowIndex: i + 2, row, razon: "bitacora_jorge_aldemar" });
        continue;
      }
    }

    reporte.por_mes[tabName] = {
      total_filas_sheet: rows.length,
      filas_basura: filasBasura.length,
      muestra_basura: filasBasura.slice(0, 5).map((f) => ({
        rowIndex: f.rowIndex,
        consec: f.row[0],
        proveedor: f.row[2],
        nit: f.row[3],
        numero: f.row[4],
        razon: f.razon,
      })),
    };
    reporte.filas_a_borrar_total += filasBasura.length;

    if (dryRun || filasBasura.length === 0) continue;

    // === MODO REAL: borrar filas Sheet + events BD + PDFs Drive ===
    const sheetProps = sheetByTitle.get(tabName);

    // 1. Borrar filas Sheet (de mayor a menor índice)
    if (sheetProps) {
      const requests = filasBasura
        .map((f) => f.rowIndex)
        .sort((a, b) => b - a)
        .map((rowIdx) => ({
          deleteDimension: {
            range: {
              sheetId: sheetProps.sheetId,
              dimension: "ROWS",
              startIndex: rowIdx - 1,
              endIndex: rowIdx,
            },
          },
        }));
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: fullCred.sheet_id,
          requestBody: { requests },
        });
      } catch (e: any) {
        reporte.errores.push(`borrar filas ${tabName}: ${e.message}`);
      }
    }

    // 2. Borrar events BD correspondientes (por nit+numero si existe match)
    for (const f of filasBasura) {
      const nit = String(f.row[3] ?? "").replace(/\D+/g, "");
      const numero = String(f.row[4] ?? "").trim();
      const proveedor = String(f.row[2] ?? "");

      // Buscar event con mismo proveedor + fecha aproximada
      // Si nit+numero está, usar eso. Sino, usar proveedor + fecha del row (col B)
      const fecha = String(f.row[1] ?? "").trim();
      let delQuery = supa
        .from("agent_events")
        .delete({ count: "exact" })
        .eq("cliente_id", clienteId)
        .eq("agente_id", "facturacion");

      if (numero && nit) {
        // Match exacto por payload->>numero y payload->>nit
        delQuery = delQuery
          .eq("payload->>numero", numero)
          .eq("payload->>nit", nit);
      } else if (proveedor && fecha) {
        // Fallback: por proveedor + fecha
        delQuery = delQuery
          .eq("payload->>proveedor", proveedor)
          .eq("payload->>fecha", fecha);
      } else {
        continue;
      }

      try {
        const { count } = await delQuery;
        reporte.events_bd_a_borrar_total += (count ?? 0);
      } catch {}
    }

    // 3. Borrar PDFs Drive correspondientes
    if (subfolderId) {
      const filesInFolder = await drive.files.list({
        q: `'${subfolderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
        fields: "files(id,name)",
        pageSize: 1000,
      });
      const allFiles = filesInFolder.data.files ?? [];

      for (const f of filasBasura) {
        const consec = String(f.row[0] ?? "");
        const numero = String(f.row[4] ?? "");
        for (const file of allFiles) {
          const name = file.name ?? "";
          // Match por consec inicial: "{consec}. ..."
          if (name.startsWith(`${consec}. `) || (numero && name.includes(`. ${numero}.`))) {
            try {
              await drive.files.delete({ fileId: file.id! });
              reporte.pdfs_a_borrar_total++;
            } catch {}
          }
        }
      }
    }
  }

  if (dryRun) {
    return new Response(
      JSON.stringify({ ...reporte, proximo_paso: "llamar con dryRun=false para ejecutar" }, null, 2),
      { headers: { "content-type": "application/json" } },
    );
  }

  // === RENUMERAR + RENOMBRAR DRIVE + HUERFANOS (modo real) ===
  reporte.meses_renumerados = [] as string[];
  reporte.pdfs_renombrados = 0;
  reporte.pdfs_huerfanos_movidos = 0;

  for (let mIdx = 0; mIdx < 12; mIdx++) {
    const tabName = MES_TABS[mIdx];
    const mes = mIdx + 1;
    const subfolderName = `2026-${String(mes).padStart(2, "0")}`;
    const subfolderId = subfolderByName.get(subfolderName);

    try {
      // Re-leer Sheet (post-borrado)
      const r2 = await sheets.spreadsheets.values.get({
        spreadsheetId: fullCred.sheet_id,
        range: `'${tabName}'!A2:O1000`,
      });
      const rowsAfter = (r2.data.values || []).filter((row) => row[4] || row[2]);
      if (rowsAfter.length === 0) continue;

      // Renumerar col A
      const newColA: any[][] = rowsAfter.map((_, i) => [i + 1]);
      await sheets.spreadsheets.values.update({
        spreadsheetId: fullCred.sheet_id,
        range: `'${tabName}'!A2:A${rowsAfter.length + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: newColA },
      });
      reporte.meses_renumerados.push(tabName);

      await supa
        .from("invoice_consecutivo_locks")
        .upsert(
          { cliente_slug: clienteSlug, tab_name: tabName, consecutivo: rowsAfter.length },
          { onConflict: "cliente_slug,tab_name" },
        );

      // Renombrar/mover Drive
      if (subfolderId) {
        const filesNow = await drive.files.list({
          q: `'${subfolderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
          fields: "files(id,name)",
          pageSize: 1000,
        });
        const allFiles = filesNow.data.files ?? [];

        // numero (col E) → nuevo consec
        const numeroToConsec = new Map<string, number>();
        for (let i = 0; i < rowsAfter.length; i++) {
          const numero = String(rowsAfter[i][4] ?? "").trim();
          if (numero) numeroToConsec.set(numero, i + 1);
        }

        // Crear/obtener _huerfanos folder
        let huerfanosFolderId: string | null = null;

        for (const f of allFiles) {
          const name = f.name ?? "";
          // Extraer numero del filename: "{consec}. {numero}..."
          const match = name.match(/^\d+\.\s+([A-Z0-9-]+)\./i);
          if (!match) continue;
          const numero = match[1];
          const nuevoConsec = numeroToConsec.get(numero);

          if (!nuevoConsec) {
            // Huérfano: mover a _huerfanos
            if (!huerfanosFolderId) {
              const huerfanosCheck = await drive.files.list({
                q: `'${subfolderId}' in parents and name='_huerfanos' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                fields: "files(id)",
              });
              if ((huerfanosCheck.data.files ?? []).length > 0) {
                huerfanosFolderId = huerfanosCheck.data.files![0].id ?? null;
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
                fileId: f.id!,
                addParents: huerfanosFolderId!,
                removeParents: subfolderId,
                fields: "id, parents",
              });
              reporte.pdfs_huerfanos_movidos++;
            } catch {}
            continue;
          }

          // Renombrar con nuevo consec
          const newName = name.replace(/^\d+\./, `${nuevoConsec}.`);
          if (newName !== name) {
            try {
              await drive.files.update({
                fileId: f.id!,
                requestBody: { name: newName },
                fields: "id",
              });
              reporte.pdfs_renombrados++;
            } catch {}
          }
        }
      }
    } catch (e: any) {
      reporte.errores.push(`procesar ${tabName}: ${e.message}`);
    }
  }

  return new Response(JSON.stringify(reporte, null, 2), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {};
