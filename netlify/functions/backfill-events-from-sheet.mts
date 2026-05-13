// netlify/functions/backfill-events-from-sheet.mts
//
// One-shot backfill: lee el Sheet del cliente y crea agent_events
// para todas las facturas históricas que no tengan event todavía.
//
// Útil cuando:
//   - el cliente fue procesado antes de que existiera agent_events
//   - migramos de un agente a otro y queremos recuperar histórico
//
// Idempotente: matchea por (numero, nit) → no duplica si ya existen.
// Crea un agent_run sintético con triggered_by='manual' para que el FK
// de agent_events.run_id quede satisfecho.
//
// Auth: x-internal-secret (mismo que el cron).
//
// POST body:
//   { customerId: "tomas92", agenteId?: "facturacion", dryRun?: boolean }

import { google } from "googleapis";
import { loadCredentialsBySlug } from "../../shared/agents-runtime/src/credentials-by-slug";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { recordRunStart, recordRunEnd } from "../../shared/agents-runtime/src/record-run";
import {
  emitFacturaEvents,
  type FacturaEventPayload,
} from "../../shared/agents-runtime/src/agent-events";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

interface RequestBody {
  customerId: string;
  agenteId?: string;
  dryRun?: boolean;
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

  const { customerId, agenteId = "facturacion", dryRun = false } = body;
  if (!customerId) {
    return new Response("missing customerId", { status: 400 });
  }

  const cred = await loadCredentialsBySlug(customerId, agenteId);
  if (!cred || !cred.google_refresh_token || !cred.sheet_id) {
    return new Response(
      JSON.stringify({ error: "credentials not found or sheet_id missing" }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }

  // Multi-tenant: usar el OAuth Web Client (con el que se firmó el refresh_token
  // durante el onboarding del cliente). NO usar GOOGLE_CLIENT_ID legacy.
  const webClientId = process.env.GOOGLE_OAUTH_WEB_CLIENT_ID;
  const webClientSecret = process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET;
  if (!webClientId || !webClientSecret) {
    return new Response(
      JSON.stringify({ error: "missing GOOGLE_OAUTH_WEB_CLIENT_ID / SECRET env vars" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
  const auth = new google.auth.OAuth2(webClientId, webClientSecret);
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const sheets = google.sheets({ version: "v4", auth });

  // 1. Leer todas las pestañas mensuales que existan
  const meta = await sheets.spreadsheets.get({ spreadsheetId: cred.sheet_id });
  const existingTabs = new Set(
    (meta.data.sheets || []).map((s) => s.properties?.title || ""),
  );

  const allFacturas: FacturaEventPayload[] = [];
  const tabsLeidas: string[] = [];
  for (const tab of MES_TABS) {
    if (!existingTabs.has(tab)) continue;
    tabsLeidas.push(tab);
    const tabRange = `'${tab.replace(/'/g, "''")}'`;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: cred.sheet_id,
      range: `${tabRange}!A2:O1000`, // 15 cols nueva estructura (skip header)
    });
    const rows = res.data.values || [];
    for (const row of rows) {
      // Cols nueva estructura (15):
      //   A=#(0), B=Fecha(1), C=Proveedor(2), D=NIT(3), E=#Documento(4),
      //   F=Subtotal(5), G=IVA(6),
      //   H=ReteFuente(7), I=ReteIVA(8), J=ReteICA(9),
      //   K=Total a Pagar(10),
      //   L=Concepto(11), M=Categoría(12), N=Cuenta PYG(13), O=Link PDF(14)
      const fechaRaw = String(row[1] || "").trim();
      const numero = String(row[4] || "").trim();
      const nit = String(row[3] || "").replace(/\D+/g, "");
      if (!fechaRaw || !numero || !nit) continue; // fila incompleta o vacía

      const fecha = parseFecha(fechaRaw);
      if (!fecha) continue;

      const reteFuente = parseNum(row[7]);
      const reteIva = parseNum(row[8]);
      const reteIca = parseNum(row[9]);

      allFacturas.push({
        fecha,
        proveedor: String(row[2] || "").trim(),
        nit,
        numero,
        subtotal: parseNum(row[5]),
        iva: parseNum(row[6]),
        reteFuente,
        reteIva,
        reteIca,
        totalRetenciones: reteFuente + reteIva + reteIca,
        total: parseNum(row[10]),
        concepto: String(row[11] || "").trim() || undefined,
        categoria: String(row[12] || "").trim() || undefined,
        cuentaPyg: String(row[13] || "").trim() || undefined,
        driveLink: String(row[14] || "").trim() || undefined,
      });
    }
  }

  // 2. Idempotencia: filtrar las que ya tienen event
  const supa = getServerClient();
  const { data: existing, error: existingErr } = await supa
    .from("agent_events")
    .select("payload")
    .eq("cliente_id", cred.cliente_id)
    .eq("agente_id", agenteId)
    .eq("tipo", "factura_procesada");

  if (existingErr) {
    return new Response(
      JSON.stringify({ error: `query existing events failed: ${existingErr.message}` }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  const existingKeys = new Set(
    (existing || []).map((ev) => {
      const p = (ev as { payload: { numero?: string; nit?: string } }).payload;
      return `${p.numero || ""}|${p.nit || ""}`;
    }),
  );

  const newFacturas = allFacturas.filter(
    (f) => !existingKeys.has(`${f.numero}|${f.nit}`),
  );

  if (dryRun) {
    return new Response(
      JSON.stringify({
        dryRun: true,
        tabsLeidas,
        sheetRowsCount: allFacturas.length,
        existingEventsCount: existingKeys.size,
        wouldInsertCount: newFacturas.length,
        sample: newFacturas.slice(0, 3),
      }, null, 2),
      { headers: { "content-type": "application/json" } },
    );
  }

  if (newFacturas.length === 0) {
    return new Response(
      JSON.stringify({
        inserted: 0,
        message: "todos los events ya existen",
        tabsLeidas,
        sheetRowsCount: allFacturas.length,
        existingEventsCount: existingKeys.size,
      }),
      { headers: { "content-type": "application/json" } },
    );
  }

  // 3. Crear un agent_run sintético "backfill" (FK requirement)
  const startedAt = Date.now();
  let runId: string;
  try {
    runId = await recordRunStart({
      clienteSlug: customerId,
      agenteId,
      triggeredBy: "manual",
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: `failed creating backfill run: ${err.message}` }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  // 4. Emitir events
  await emitFacturaEvents({
    runId,
    clienteId: cred.cliente_id,
    agenteId,
    facturas: newFacturas,
  });

  // 5. Cerrar el run sintético
  await recordRunEnd({
    runId,
    status: "ok",
    durationMs: Date.now() - startedAt,
    summary: `Backfill desde Sheet · ${newFacturas.length} events creados (de ${allFacturas.length} filas en ${tabsLeidas.length} pestañas)`,
    payload: {
      mode: "backfill_from_sheet",
      tabs: tabsLeidas,
      total_filas_sheet: allFacturas.length,
      events_pre_existentes: existingKeys.size,
      events_creados: newFacturas.length,
    },
  });

  return new Response(
    JSON.stringify({
      ok: true,
      inserted: newFacturas.length,
      runId,
      tabsLeidas,
      sheetRowsCount: allFacturas.length,
      existingEventsCount: existingKeys.size,
    }, null, 2),
    { headers: { "content-type": "application/json" } },
  );
};

function parseNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (v == null || v === "") return 0;
  const s = String(v).replace(/[^\d.-]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/** Parsea fecha en formato YYYY-MM-DD o DD/MM/YYYY → ISO YYYY-MM-DD. */
function parseFecha(s: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const d = m[1].padStart(2, "0");
    const mo = m[2].padStart(2, "0");
    const y = m[3];
    return `${y}-${mo}-${d}`;
  }
  return null;
}

