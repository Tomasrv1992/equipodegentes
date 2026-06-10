// netlify/functions/inspect-perdidas-background.mts
//
// Diagnóstico: para una lista de facturas (proveedor + numero), reporta su
// estado actual en Sheet + agent_events + agent_events.descartado.
//
// Sirve para decidir el camino correcto de fix:
//   - en_sheet:✓ + en_events>0 + sin messageId → Backfill (Tarea 5B) + Reconcile recupera
//   - en_sheet:✓ + en_events:0                 → Bug emisión event (re-emitir desde Sheet)
//   - en_sheet:null + en_events:0 + descartado → Falso negativo LLM (fix pipeline)
//   - en_sheet:null + en_events:0 + sin descartado → Pipeline nunca lo vio (force=true + ventana amplia)
//
// IMPORTANTE: el síntoma #1 (Dashboard ≠ Sheet) demuestra que events ≠ Sheet realidad.
// Por eso este endpoint consulta AMBAS fuentes — diagnosticar solo contra events da
// falsos NO_ENCONTRADO para facturas que SÍ están en el Sheet.
//
// Body: { clienteSlug, year?, facturas: [{ proveedor_contains, numero? }] }
//
// CRÍTICO: cuando numero="" (caso Protokimicas, Jeisy, comite asesor — los que
// originaron el ticket), `ilike("payload->>numero", "")` NO matchea nada. Manejar
// usando proveedor_contains como criterio principal.

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

// Cols del Sheet (15 cols esquema actual):
// A=#, B=Fecha, C=Proveedor, D=NIT, E=#Documento, F=Subtotal, G=IVA,
// H=ReteFuente, I=ReteIVA, J=ReteICA, K=TotalPagar, L=Concepto, ...

interface Match {
  proveedor_contains: string;
  numero: string | null;
  en_sheet: { mes: string; row: number; proveedor: string; numero: string; nit: string; total: number } | null;
  en_events: number;
  en_events_messageid: string | null;
  en_events_sample: any | null;
  en_descartado: string[];  // motivos
  en_descartado_sample: any | null;
}

async function findInSheet(
  sheets: any,
  spreadsheetId: string,
  proveedorContains: string,
  numero: string | null,
): Promise<Match["en_sheet"]> {
  const provNeedle = proveedorContains.toLowerCase().trim();
  const numNeedle = numero ? numero.toLowerCase().trim() : null;
  for (const mes of MES_TABS) {
    try {
      const r = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${mes}'!A2:E1000`,
      });
      const rows = r.data.values || [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const proveedor = String(row[2] ?? "").toLowerCase();
        const numeroCell = String(row[4] ?? "").toLowerCase();
        const provMatches = proveedor.includes(provNeedle);
        const numMatches = numNeedle ? numeroCell === numNeedle : true;
        if (provMatches && numMatches) {
          return {
            mes,
            row: i + 2,
            proveedor: String(row[2] ?? ""),
            numero: String(row[4] ?? ""),
            nit: String(row[3] ?? ""),
            total: 0,  // no leemos col K acá por simplicidad
          };
        }
      }
    } catch {
      // tab no existe, skip
    }
  }
  return null;
}

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  if (req.headers.get("x-internal-secret") !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const year = Number(body.year) || new Date().getFullYear();
  const facturas: Array<{ proveedor_contains: string; numero?: string }> = body.facturas ?? [];
  if (!clienteSlug || facturas.length === 0) {
    return new Response("missing clienteSlug or facturas", { status: 400 });
  }

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });
  const clienteId = (cli as any).id as string;

  const cred = await loadCredentials(clienteId, "facturacion");
  if (!cred?.google_refresh_token || !cred.sheet_id) {
    return new Response("missing creds", { status: 400 });
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_WEB_CLIENT_ID,
    process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: cred.google_refresh_token });
  const sheets = google.sheets({ version: "v4", auth });

  const results: Match[] = [];

  for (const { proveedor_contains, numero } of facturas) {
    const numKnown = !!numero && numero.trim().length > 0;
    const result: Match = {
      proveedor_contains,
      numero: numKnown ? numero! : null,
      en_sheet: null,
      en_events: 0,
      en_events_messageid: null,
      en_events_sample: null,
      en_descartado: [],
      en_descartado_sample: null,
    };

    // 1. Sheet (read directo)
    result.en_sheet = await findInSheet(sheets, cred.sheet_id, proveedor_contains, numKnown ? numero! : null);

    // 2. agent_events factura_procesada
    let q = supa.from("agent_events")
      .select("payload, created_at")
      .eq("cliente_id", clienteId)
      .eq("agente_id", "facturacion")
      .eq("tipo", "factura_procesada")
      .gte("created_at", `${year}-01-01`)
      .lt("created_at", `${year + 1}-01-01`);
    q = numKnown
      ? q.ilike("payload->>numero", numero!)
      : q.ilike("payload->>proveedor", `%${proveedor_contains}%`);
    const inEvents = await q.limit(5);
    result.en_events = inEvents.data?.length ?? 0;
    result.en_events_sample = inEvents.data?.[0]?.payload ?? null;
    result.en_events_messageid = inEvents.data?.[0]?.payload?.messageId ?? null;

    // 3. agent_events email_descartado
    let qDesc = supa.from("agent_events")
      .select("payload")
      .eq("cliente_id", clienteId)
      .eq("agente_id", "facturacion")
      .eq("tipo", "email_descartado")
      .gte("created_at", `${year}-01-01`)
      .lt("created_at", `${year + 1}-01-01`);
    // Solo buscar por proveedor cuando numero vacío (evita "subject ilike %%" que matchea todo)
    qDesc = numKnown
      ? qDesc.or(`payload->>subject.ilike.%${numero}%,payload->>sender.ilike.%${proveedor_contains}%`)
      : qDesc.ilike("payload->>sender", `%${proveedor_contains}%`);
    const inDesc = await qDesc.limit(5);
    result.en_descartado = inDesc.data?.map((r: any) => r.payload?.motivo).filter(Boolean) ?? [];
    result.en_descartado_sample = inDesc.data?.[0]?.payload ?? null;

    results.push(result);
  }

  return new Response(
    JSON.stringify({ ok: true, cliente: clienteSlug, year, total: results.length, results }, null, 2),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
