// Edge function: /api/onboarding/save-fiscal-data
//
// Llamada por el cliente al completar el wizard de datos fiscales en el
// onboarding. Recibe el token del onboarding (autenticación basada en el token
// único, NO JWT admin — porque el cliente es público).
//
// Hace 3 cosas:
//   1. Guarda retention_rules + municipio_ica + nit_cliente en client_credentials
//   2. Marca el onboarding_token.step = 'completed'
//   3. Dispara el primer run del agente facturación
//
// POST body: {
//   token: string,
//   tipo_persona: "juridica" | "natural_declarante" | "natural_no_declarante",
//   nit_cliente: string,
//   agente_retenedor: { reteFuente: bool, reteIva: bool, reteIca: bool },
//   municipio_ica: string | null,
//   aplicar_de_oficio: { rtf_si_xml_vacio: bool, ica_si_xml_vacio: bool },
//   notas?: string
// }

import type { Context } from "@netlify/edge-functions";

declare const Netlify: { env: { get: (key: string) => string | undefined } };

interface Body {
  token: string;
  tipo_persona: "juridica" | "natural_declarante" | "natural_no_declarante";
  nit_cliente: string;
  agente_retenedor: {
    reteFuente: boolean;
    reteIva: boolean;
    reteIca: boolean;
  };
  municipio_ica: string | null;
  aplicar_de_oficio: {
    rtf_si_xml_vacio: boolean;
    ica_si_xml_vacio: boolean;
  };
  notas?: string;
}

export default async (request: Request, _context: Context) => {
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const supabaseUrl = Netlify.env.get("SUPABASE_URL") ?? "";
  const supabaseAnon = Netlify.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  // 1. Parsear body
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  // 2. Validaciones básicas
  if (!body.token) return json({ error: "missing token" }, 400);
  if (!body.tipo_persona) return json({ error: "missing tipo_persona" }, 400);
  const nitClean = String(body.nit_cliente ?? "").replace(/\D+/g, "");
  if (!nitClean || nitClean.length < 6) {
    return json({ error: "nit_cliente inválido (mínimo 6 dígitos)" }, 400);
  }

  // 3. Validar token con RPC (mismo que usa el frontend para mostrar la página)
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
    return json({ error: "invalid or expired token" }, 404);
  }
  const onboarding = rows[0] as {
    cliente_id: string;
    agente_id: string;
    cliente_slug: string;
    step?: string;
  };

  // Solo permitir si está en fiscal_pending o ya completed (idempotente)
  if (onboarding.step !== "fiscal_pending" && onboarding.step !== "completed") {
    return json({ error: `step inválido: ${onboarding.step} (debe ser fiscal_pending)` }, 400);
  }

  // 4. Construir retention_rules JSON
  const retention_rules = {
    version: 1,
    tipo_persona: body.tipo_persona,
    es_agente_retenedor: {
      reteFuente: !!body.agente_retenedor?.reteFuente,
      reteIva: !!body.agente_retenedor?.reteIva,
      reteIca: !!body.agente_retenedor?.reteIca,
    },
    aplicar_de_oficio: {
      rtf_si_xml_vacio: !!body.aplicar_de_oficio?.rtf_si_xml_vacio,
      ica_si_xml_vacio: !!body.aplicar_de_oficio?.ica_si_xml_vacio,
    },
    overrides_por_nit: {},
    notas: body.notas ?? "Configurado en onboarding wizard",
  };

  // 5. PATCH client_credentials con retention_rules + municipio_ica + nit_cliente
  const upResp = await fetch(
    `${supabaseUrl}/rest/v1/client_credentials?cliente_id=eq.${onboarding.cliente_id}&agente_id=eq.${onboarding.agente_id}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        retention_rules,
        municipio_ica: body.municipio_ica || null,
        nit_cliente: nitClean,
      }),
    },
  );
  if (!upResp.ok) {
    const txt = await upResp.text();
    return json({ error: `save credentials failed: ${txt}` }, 500);
  }

  // 6. Marcar token como completed
  await fetch(
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

  // 7. Disparar primer run del cron — solo si no se había disparado antes
  //    (idempotente: si el cliente recarga el wizard y vuelve a guardar,
  //    el agente igual lo procesa pero las facturas que ya están en Sheet se
  //    saltan por isDuplicate).
  let dispatchStatus: string = "skipped";
  const mainSiteUrl = Netlify.env.get("MAIN_SITE_URL");
  const internalSecret = Netlify.env.get("FACTURACION_INTERNAL_SECRET");
  if (mainSiteUrl && internalSecret && onboarding.agente_id === "facturacion") {
    try {
      const dispatchResp = await fetch(
        `${mainSiteUrl}/.netlify/functions/facturacion-background`,
        {
          method: "POST",
          headers: {
            "x-internal-secret": internalSecret,
            "x-trigger": "onboarding-fiscal",
            "content-type": "application/json",
          },
          body: JSON.stringify({ customerId: onboarding.cliente_slug }),
        },
      );
      dispatchStatus = `dispatched-${dispatchResp.status}`;
      console.log(
        `[fiscal-wizard] cliente=${onboarding.cliente_slug} dispatch status=${dispatchResp.status}`,
      );
    } catch (e: any) {
      dispatchStatus = `failed-${e.message}`;
      console.warn(`[fiscal-wizard] dispatch failed: ${e.message}`);
    }
  }

  return json({ ok: true, dispatch: dispatchStatus });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
