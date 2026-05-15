// Edge function: /api/onboarding/estimate
//
// Estimación previa del volumen de facturas en Gmail por mes ANTES de
// disparar el primer run. Objetivo: setear expectativas correctas con el
// cliente ("vas a recibir ~287 facturas en ~22 min") en lugar de que vea
// el dashboard vacío durante el backfill y crea que está roto.
//
// Estrategia: para cada mes (1..currentMonth), pedir messages.list con
// maxResults=1 y leer resultSizeEstimate (estimación interna de Gmail).
// No es exacto pero es suficiente. Costo: N invocaciones Gmail (5-12),
// completa en <5s.
//
// Auth: onboarding token (mismo flow que drive-list/sheets-list).
//
// Body: { token: string }
// Output: {
//   total: number,
//   estimatedMinutes: number,
//   porMes: Array<{ mes: number, mesName: string, count: number }>
// }

import type { Context } from "@netlify/edge-functions";

declare const Netlify: { env: { get: (key: string) => string | undefined } };

const MES_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
] as const;

// Tiempo promedio por factura procesada (descarga ZIP/PDF → LLM → Sheet → Drive).
// Medido en runs reales: ~4-6s por factura DIAN. Tomamos 5s como punto medio.
const SECONDS_PER_INVOICE = 5;

export default async (request: Request, _context: Context) => {
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const supabaseUrl = Netlify.env.get("SUPABASE_URL") ?? "";
  const supabaseAnon = Netlify.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const vaultKey = Netlify.env.get("CREDENTIALS_VAULT_KEY") ?? "";
  const googleClientId = Netlify.env.get("GOOGLE_OAUTH_WEB_CLIENT_ID") ?? "";
  const googleClientSecret = Netlify.env.get("GOOGLE_OAUTH_WEB_CLIENT_SECRET") ?? "";

  if (!supabaseUrl || !serviceKey || !vaultKey) {
    return json({ error: "server misconfigured" }, 500);
  }

  let body: { token: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body.token) return json({ error: "missing token" }, 400);

  // 1. Validar token
  const valResp = await fetch(
    `${supabaseUrl}/rest/v1/rpc/onboarding_token_lookup`,
    {
      method: "POST",
      headers: {
        apikey: supabaseAnon,
        Authorization: `Bearer ${supabaseAnon}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ p_token: body.token }),
    },
  );
  if (!valResp.ok) return json({ error: "token validation failed" }, 500);
  const rows = await valResp.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return json({ error: "invalid token" }, 404);
  }
  const ob = rows[0] as { cliente_id: string; agente_id: string };

  // 2. Cargar refresh_token
  const credResp = await fetch(
    `${supabaseUrl}/rest/v1/rpc/client_credentials_load`,
    {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        p_cliente_id: ob.cliente_id,
        p_agente_id: ob.agente_id,
        p_vault_key: vaultKey,
      }),
    },
  );
  if (!credResp.ok) return json({ error: "load credentials failed" }, 500);
  const credRows = await credResp.json();
  const cred = Array.isArray(credRows) ? credRows[0] : null;
  if (!cred?.google_refresh_token) {
    return json({ error: "no refresh_token (run OAuth first)" }, 400);
  }

  // 3. Refresh access_token
  const accessToken = await refreshAccessToken(
    cred.google_refresh_token,
    googleClientId,
    googleClientSecret,
  );
  if (!accessToken) return json({ error: "could not refresh access token" }, 500);

  // 4. Para cada mes del año hasta el actual, contar facturas en Gmail.
  //    Mismo query que pipeline (sin -label:Procesado porque queremos estimar
  //    TOTAL, no solo lo pendiente — el cliente quiere ver "tienes 287
  //    facturas este año" no "te quedan 287 sin procesar").
  const year = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  const porMes = await Promise.all(
    Array.from({ length: currentMonth }, (_, i) => i + 1).map(async (mes) => {
      const mm = String(mes).padStart(2, "0");
      const nextMonth = mes === 12 ? 1 : mes + 1;
      const nextYear = mes === 12 ? year + 1 : year;
      const nmm = String(nextMonth).padStart(2, "0");

      const q =
        `(filename:zip OR filename:pdf OR filename:docx OR ` +
        `filename:autoliquidaciones OR filename:comprobante) ` +
        `after:${year}/${mm}/01 before:${nextYear}/${nmm}/01`;

      try {
        const url =
          `https://gmail.googleapis.com/gmail/v1/users/me/messages` +
          `?q=${encodeURIComponent(q)}&maxResults=1`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) {
          console.warn(`gmail estimate mes ${mes}: ${res.status}`);
          return { mes, mesName: MES_NAMES[mes - 1], count: 0 };
        }
        const data = (await res.json()) as { resultSizeEstimate?: number };
        return {
          mes,
          mesName: MES_NAMES[mes - 1],
          count: data.resultSizeEstimate ?? 0,
        };
      } catch (e: any) {
        console.warn(`gmail estimate mes ${mes} failed: ${e.message}`);
        return { mes, mesName: MES_NAMES[mes - 1], count: 0 };
      }
    }),
  );

  const total = porMes.reduce((s, m) => s + m.count, 0);
  // Tiempo: facturas procesadas en paralelo entre los meses del fan-out.
  // El cuello de botella es el mes más cargado (no la suma).
  const maxMonthCount = Math.max(0, ...porMes.map((m) => m.count));
  const estimatedSeconds = maxMonthCount * SECONDS_PER_INVOICE;
  const estimatedMinutes = Math.max(1, Math.round(estimatedSeconds / 60));

  return json({
    total,
    estimatedMinutes,
    monthsToProcess: currentMonth,
    porMes,
  });
};

async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<string | null> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { access_token?: string };
  return data.access_token ?? null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
