// netlify/functions/health-check.mts
//
// Health check cruzado: para un cliente, devuelve por mes el conteo en cada
// fuente (Gmail label, Drive folder, Sheet tab, agent_events) y resalta
// dónde hay discrepancia.
//
// Útil para auditar después del onboarding y para validación periódica.
//
// Auth: x-internal-secret
// POST body: { customerId: "tomas92", year?: 2026 }

import { google } from "googleapis";
import { loadCredentialsBySlug } from "../../shared/agents-runtime/src/credentials-by-slug";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

interface RequestBody {
  customerId: string;
  agenteId?: string;
  year?: number;
}

interface MonthHealth {
  mes: string;
  gmail: number;
  drive: number;
  sheet: number;
  events: number;
  coincide: boolean;
  diff: string | null;
}

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const { customerId, agenteId = "facturacion", year = new Date().getFullYear() } = body;
  if (!customerId) return new Response("missing customerId", { status: 400 });

  const cred = await loadCredentialsBySlug(customerId, agenteId);
  if (!cred || !cred.google_refresh_token || !cred.sheet_id || !cred.drive_folder_id) {
    return new Response(
      JSON.stringify({ error: "credentials not found or incomplete" }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }

  const webClientId = process.env.GOOGLE_OAUTH_WEB_CLIENT_ID;
  const webClientSecret = process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET;
  if (!webClientId || !webClientSecret) {
    return new Response(
      JSON.stringify({ error: "missing GOOGLE_OAUTH_WEB_CLIENT_ID / SECRET" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  const auth = new google.auth.OAuth2(webClientId, webClientSecret);
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const gmail = google.gmail({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });
  const sheets = google.sheets({ version: "v4", auth });
  const supa = getServerClient();

  // Conteos por mes (1..12) en paralelo
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const results: MonthHealth[] = await Promise.all(
    months.map(async (m): Promise<MonthHealth> => {
      const mStr = String(m).padStart(2, "0");
      const folderName = `${year}-${mStr}`;
      const labelName = `Facturas/${year}-${mStr}`;
      const tabName = MES_TABS[m - 1];

      // 1. Gmail: emails con label Facturas/YYYY-MM
      let gmailCount = 0;
      try {
        const res = await gmail.users.messages.list({
          userId: "me",
          q: `label:"${labelName}"`,
          maxResults: 500,
        });
        gmailCount = res.data.messages?.length ?? 0;
      } catch {
        gmailCount = 0;
      }

      // 2. Drive: archivos PDF en folder YYYY-MM
      let driveCount = 0;
      try {
        const folderRes = await drive.files.list({
          q: `name='${folderName}' and '${cred.drive_folder_id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: "files(id)",
        });
        const monthFolderId = folderRes.data.files?.[0]?.id;
        if (monthFolderId) {
          const filesRes = await drive.files.list({
            q: `'${monthFolderId}' in parents and trashed=false and mimeType='application/pdf'`,
            fields: "files(id)",
            pageSize: 1000,
          });
          driveCount = filesRes.data.files?.length ?? 0;
        }
      } catch {
        driveCount = 0;
      }

      // 3. Sheet: filas en pestaña del mes (excluyendo header)
      let sheetCount = 0;
      try {
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: cred.sheet_id!,
          range: `'${tabName}'!A2:A1000`,
        });
        sheetCount = (res.data.values || []).filter((row) => row[0] && String(row[0]).trim()).length;
      } catch {
        sheetCount = 0;
      }

      // 4. Supabase: agent_events con payload->>fecha en YYYY-MM
      let eventsCount = 0;
      const startDate = `${year}-${mStr}-01`;
      const endDate = m === 12 ? `${year + 1}-01-01` : `${year}-${String(m + 1).padStart(2, "0")}-01`;
      try {
        const { count } = await supa
          .from("agent_events")
          .select("*", { count: "exact", head: true })
          .eq("cliente_id", cred.cliente_id)
          .eq("agente_id", agenteId)
          .eq("tipo", "factura_procesada")
          .gte("payload->>fecha", startDate)
          .lt("payload->>fecha", endDate);
        eventsCount = count ?? 0;
      } catch {
        eventsCount = 0;
      }

      const allEqual = gmailCount === driveCount && driveCount === sheetCount && sheetCount === eventsCount;
      let diff: string | null = null;
      if (!allEqual) {
        const parts: string[] = [];
        if (gmailCount !== sheetCount) parts.push(`gmail≠sheet (${gmailCount} vs ${sheetCount})`);
        if (driveCount !== sheetCount) parts.push(`drive≠sheet (${driveCount} vs ${sheetCount})`);
        if (eventsCount !== sheetCount) parts.push(`events≠sheet (${eventsCount} vs ${sheetCount})`);
        diff = parts.join(" · ");
      }

      return {
        mes: `${year}-${mStr}`,
        gmail: gmailCount,
        drive: driveCount,
        sheet: sheetCount,
        events: eventsCount,
        coincide: allEqual,
        diff,
      };
    }),
  );

  // Filtrar meses sin nada (todos en 0) para output más limpio
  const nonEmpty = results.filter((r) => r.gmail + r.drive + r.sheet + r.events > 0);

  // Totales
  const totals = nonEmpty.reduce(
    (acc, r) => ({
      gmail: acc.gmail + r.gmail,
      drive: acc.drive + r.drive,
      sheet: acc.sheet + r.sheet,
      events: acc.events + r.events,
    }),
    { gmail: 0, drive: 0, sheet: 0, events: 0 },
  );

  const totalsCoincide = totals.gmail === totals.drive && totals.drive === totals.sheet && totals.sheet === totals.events;

  const output = {
    customerId,
    year,
    sheet_id: cred.sheet_id,
    drive_folder_id: cred.drive_folder_id,
    google_email: cred.google_email,
    months: nonEmpty,
    totals: {
      ...totals,
      coincide: totalsCoincide,
    },
    summary: {
      meses_con_data: nonEmpty.length,
      meses_con_discrepancia: nonEmpty.filter((m) => !m.coincide).length,
      todo_cuadra: totalsCoincide && nonEmpty.every((m) => m.coincide),
    },
  };

  return new Response(JSON.stringify(output, null, 2), {
    headers: { "content-type": "application/json" },
  });
};
