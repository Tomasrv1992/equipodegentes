// Edge function: /api/onboarding/save-resources
//
// Guarda Drive folder + Sheet + email destino que el cliente eligió, y
// avanza el step del onboarding token a 'completed'.

import type { Context } from "@netlify/edge-functions";

declare const Netlify: { env: { get: (key: string) => string | undefined } };

interface Body {
  token: string;
  driveFolderId: string;
  driveFolderName?: string;
  sheetId: string;
  sheetName?: string;
  sheetTab?: string;
  notifyEmail?: string;
}

export default async (request: Request, _context: Context) => {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  const supabaseUrl = Netlify.env.get("SUPABASE_URL") ?? "";
  const supabaseAnon = Netlify.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body.token || !body.driveFolderId || !body.sheetId) {
    return json({ error: "missing required fields" }, 400);
  }

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
  if (!Array.isArray(rows) || rows.length === 0) return json({ error: "invalid token" }, 404);
  const ob = rows[0] as { cliente_id: string; agente_id: string };

  // 2. Update client_credentials con los recursos
  const upResp = await fetch(
    `${supabaseUrl}/rest/v1/client_credentials?cliente_id=eq.${ob.cliente_id}&agente_id=eq.${ob.agente_id}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        drive_folder_id: body.driveFolderId,
        drive_folder_name: body.driveFolderName ?? null,
        sheet_id: body.sheetId,
        sheet_name: body.sheetName ?? null,
        sheet_tab: body.sheetTab ?? "Gastos 2026",
        notify_email: body.notifyEmail ?? null,
        onboarded_at: new Date().toISOString(),
      }),
    },
  );
  if (!upResp.ok) {
    const txt = await upResp.text();
    return json({ error: `update failed: ${txt}` }, 500);
  }

  // 3. Marcar token como completed
  const advResp = await fetch(
    `${supabaseUrl}/rest/v1/onboarding_tokens?token=eq.${encodeURIComponent(body.token)}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        step: "completed",
        completed_at: new Date().toISOString(),
      }),
    },
  );
  if (!advResp.ok) {
    console.warn("step advance failed:", await advResp.text());
  }

  // 4. Disparar el primer run del cron en BACKGROUND.
  //    Background functions devuelven 202 inmediatamente — un await acá no
  //    espera el procesamiento, solo confirma que el dispatch llegó OK.
  //    Esto nos da diagnóstico real: sabemos si el primer run quedó encolado
  //    o si falló por env vars / red / secret incorrecto.
  let firstRunTriggered = false;
  let firstRunError: string | null = null;

  try {
    const slugResp = await fetch(
      `${supabaseUrl}/rest/v1/clientes?id=eq.${ob.cliente_id}&select=slug`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
      },
    );
    const slugs = (await slugResp.json()) as Array<{ slug: string }>;
    const clienteSlug = slugs[0]?.slug;

    const mainSiteUrl = Netlify.env.get("MAIN_SITE_URL");
    const internalSecret = Netlify.env.get("FACTURACION_INTERNAL_SECRET");

    if (!clienteSlug) {
      firstRunError = `cliente ${ob.cliente_id} sin slug en public.clientes`;
    } else if (!mainSiteUrl) {
      firstRunError = "MAIN_SITE_URL ausente en Netlify env vars (admin site)";
    } else if (!internalSecret) {
      firstRunError = "FACTURACION_INTERNAL_SECRET ausente en Netlify env vars (admin site)";
    } else if (ob.agente_id !== "facturacion") {
      firstRunError = `agente ${ob.agente_id} no soporta first-run automático`;
    } else {
      const dispatchResp = await fetch(
        `${mainSiteUrl}/.netlify/functions/facturacion-background`,
        {
          method: "POST",
          headers: {
            "x-internal-secret": internalSecret,
            "x-trigger": "onboarding",
            "content-type": "application/json",
          },
          body: JSON.stringify({ customerId: clienteSlug }),
        },
      );
      // Background functions devuelven 202 si encolaron OK
      if (dispatchResp.status === 202 || dispatchResp.status === 200) {
        firstRunTriggered = true;
        console.log(`[first-run] cliente=${clienteSlug} dispatched OK (status=${dispatchResp.status})`);
      } else {
        const txt = await dispatchResp.text();
        firstRunError = `dispatch HTTP ${dispatchResp.status}: ${txt.slice(0, 200)}`;
        console.warn(`[first-run] cliente=${clienteSlug} dispatch failed: ${firstRunError}`);
      }
    }
  } catch (e: any) {
    firstRunError = `dispatch exception: ${e.message}`;
    console.warn(`[first-run] dispatch exception: ${e.message}`);
  }

  return json({ ok: true, firstRunTriggered, firstRunError });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
