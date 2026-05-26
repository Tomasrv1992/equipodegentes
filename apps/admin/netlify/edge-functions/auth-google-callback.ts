// Edge function: /auth/google/callback
//
// Recibe el code de Google, lo intercambia por refresh_token, lo encripta
// y guarda en Supabase. Después redirige al user a la siguiente etapa
// del onboarding (selección de Drive folder + Sheet).

import type { Context } from "@netlify/edge-functions";

declare const Netlify: { env: { get: (key: string) => string | undefined } };

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const adminUrl = Netlify.env.get("ADMIN_SITE_URL") ?? url.origin;

  if (error) {
    return Response.redirect(
      `${adminUrl}/onboarding/${state}?error=${encodeURIComponent(error)}`,
      302,
    );
  }

  if (!code || !state) {
    return new Response("missing code or state", { status: 400 });
  }

  // 1. Validar token y obtener cliente_id, agente_id
  const supabaseUrl = Netlify.env.get("SUPABASE_URL") ?? "";
  const supabaseAnon = Netlify.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const vaultKey = Netlify.env.get("CREDENTIALS_VAULT_KEY") ?? "";
  const clientId = Netlify.env.get("GOOGLE_OAUTH_WEB_CLIENT_ID") ?? "";
  const clientSecret = Netlify.env.get("GOOGLE_OAUTH_WEB_CLIENT_SECRET") ?? "";

  if (!supabaseUrl || !serviceKey || !vaultKey || !clientId || !clientSecret) {
    return new Response("server misconfigured (env vars)", { status: 500 });
  }

  const valResp = await fetch(
    `${supabaseUrl}/rest/v1/rpc/onboarding_token_lookup`,
    {
      method: "POST",
      headers: {
        apikey: supabaseAnon,
        Authorization: `Bearer ${supabaseAnon}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ p_token: state }),
    },
  );
  if (!valResp.ok) return new Response("token validation failed", { status: 500 });
  const rows = await valResp.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return new Response("invalid or expired token", { status: 404 });
  }
  const onboarding = rows[0] as {
    cliente_id: string;
    agente_id: string;
    cliente_slug: string;
    step?: string;
  };

  // 1.5. Si el token ya fue completado, redirigir al frontend SIN re-procesar.
  //      Evita que un cliente que abre el link 2 veces (o reenvía el callback)
  //      sobreescriba folder/sheet con nuevos recursos cada vez.
  if (onboarding.step === "completed") {
    console.log(`callback: token ya completado para ${onboarding.cliente_slug} — skip re-OAuth`);
    return Response.redirect(
      `${adminUrl}/onboarding/${state}?oauth=ok&completed=1`,
      302,
    );
  }

  // 2. Intercambiar code por tokens
  const redirectUri = `${adminUrl}/api/auth/google/callback`;
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResp.ok) {
    const txt = await tokenResp.text();
    console.error("token exchange failed:", txt);
    return Response.redirect(
      `${adminUrl}/onboarding/${state}?error=oauth_exchange_failed`,
      302,
    );
  }

  const tokens = (await tokenResp.json()) as {
    access_token: string;
    refresh_token?: string;
    scope: string;
    token_type: string;
    id_token?: string;
    expires_in: number;
  };

  if (!tokens.refresh_token) {
    // Sin refresh_token no podemos correr crons. Google solo lo da en el primer
    // consent. Si el user ya autorizó antes, debe revocar en myaccount.google.com
    return Response.redirect(
      `${adminUrl}/onboarding/${state}?error=no_refresh_token`,
      302,
    );
  }

  // 3. Obtener email Google del user (para guardar como info)
  const userInfoResp = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  );
  const userInfo = userInfoResp.ok
    ? ((await userInfoResp.json()) as { email?: string })
    : { email: undefined };

  // 4. Guardar refresh_token encriptado en client_credentials (RPC)
  const saveResp = await fetch(
    `${supabaseUrl}/rest/v1/rpc/client_credentials_save_oauth`,
    {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        p_cliente_id: onboarding.cliente_id,
        p_agente_id: onboarding.agente_id,
        p_refresh_token: tokens.refresh_token,
        p_google_email: userInfo.email ?? null,
        p_scopes: tokens.scope ? tokens.scope.split(" ") : null,
        p_vault_key: vaultKey,
      }),
    },
  );

  if (!saveResp.ok) {
    const txt = await saveResp.text();
    console.error("save oauth failed:", txt);
    return Response.redirect(
      `${adminUrl}/onboarding/${state}?error=save_failed`,
      302,
    );
  }

  // 5. AUTO-CREAR carpeta Drive + Sheet (skip paso 2 manual)
  //    Operatto crea la carpeta y el Sheet a nombre del cliente, sin fricción.
  //    El cliente sofisticado podrá editarlo desde el panel admin después
  //    si lo necesita.
  let folderId: string | null = null;
  let folderName: string | null = null;
  let sheetId: string | null = null;
  let sheetName: string | null = null;

  try {
    // Get cliente nombre para naming
    const cliResp = await fetch(
      `${supabaseUrl}/rest/v1/clientes?id=eq.${onboarding.cliente_id}&select=nombre`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    const cliRows = (await cliResp.json()) as Array<{ nombre: string }>;
    const clienteNombre = cliRows[0]?.nombre || onboarding.cliente_slug;

    folderName = `Facturas ${clienteNombre} - Operatto`;
    sheetName = `Control Facturas ${clienteNombre}`;

    // IDEMPOTENCIA: si client_credentials ya tiene folder/sheet asignados
    // (de un intento previo de onboarding), reusarlos en vez de crear duplicados.
    // Esto cubre: doble-click del cliente en "conectar Google", refresh durante
    // OAuth, reintento del callback por error transitorio, etc.
    const credResp = await fetch(
      `${supabaseUrl}/rest/v1/client_credentials?cliente_id=eq.${onboarding.cliente_id}&agente_id=eq.${onboarding.agente_id}&select=drive_folder_id,sheet_id`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    const credRows = (await credResp.json()) as Array<{
      drive_folder_id: string | null;
      sheet_id: string | null;
    }>;
    const existingFolderId = credRows[0]?.drive_folder_id ?? null;
    const existingSheetId = credRows[0]?.sheet_id ?? null;

    folderId = await resolveOrCreateFolder(
      tokens.access_token,
      existingFolderId,
      folderName,
    );
    sheetId = await resolveOrCreateSheet(
      tokens.access_token,
      folderId,
      existingSheetId,
      sheetName,
    );
  } catch (e: any) {
    console.error("auto-create resources failed:", e.message);
    // Si falla la auto-creación, redirigir al paso 2 manual (fallback)
    await fetch(
      `${supabaseUrl}/rest/v1/onboarding_tokens?token=eq.${encodeURIComponent(state)}`,
      {
        method: "PATCH",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "content-type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ step: "oauth_done" }),
      },
    );
    return Response.redirect(
      `${adminUrl}/onboarding/${state}?oauth=ok&autocreate_failed=1`,
      302,
    );
  }

  // 6. Update client_credentials con los recursos auto-creados
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
        drive_folder_id: folderId,
        drive_folder_name: folderName,
        sheet_id: sheetId,
        sheet_name: sheetName,
        notify_email: userInfo.email ?? null,
        onboarded_at: new Date().toISOString(),
      }),
    },
  );
  if (!upResp.ok) {
    console.warn("update client_credentials failed:", await upResp.text());
  }

  // 7. Marcar onboarding token como FISCAL_PENDING (no completed todavía).
  //    El cliente todavía tiene que llenar el wizard fiscal antes del primer run.
  //    Si el agente NO es facturacion (futuros agentes sin retenciones), saltea
  //    directo a completed.
  const nextStep = onboarding.agente_id === "facturacion" ? "fiscal_pending" : "completed";
  await fetch(
    `${supabaseUrl}/rest/v1/onboarding_tokens?token=eq.${encodeURIComponent(state)}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        step: nextStep,
        // completed_at solo si saltamos a completed (agente no facturacion).
        ...(nextStep === "completed" ? { completed_at: new Date().toISOString() } : {}),
      }),
    },
  );

  // 8. Si el agente NO es facturacion, disparar primer run aquí (flow viejo).
  //    Si SÍ es facturacion, el primer run se dispara desde la edge function
  //    onboarding-save-fiscal-data después de que el cliente complete el wizard.
  //
  // FIX 2026-05-26: el operador estaba al revés (`===` en lugar de `!==`) —
  // disparaba facturacion-background CADA vez que el cliente volvía del OAuth
  // (incluido cuando reabría el link múltiples veces). Eso generaba 2-3
  // dispatches paralelos al onboarding y rompía la indexación. Ahora respeta
  // el comentario: solo dispara para agentes NO-facturacion (flow viejo).
  if (nextStep === "completed") {
    const mainSiteUrl = Netlify.env.get("MAIN_SITE_URL");
    const internalSecret = Netlify.env.get("FACTURACION_INTERNAL_SECRET");
    if (mainSiteUrl && internalSecret && onboarding.agente_id !== "facturacion") {
      try {
        const dispatchResp = await fetch(`${mainSiteUrl}/.netlify/functions/facturacion-background`, {
          method: "POST",
          headers: {
            "x-internal-secret": internalSecret,
            "x-trigger": "onboarding",
            "content-type": "application/json",
          },
          body: JSON.stringify({ customerId: onboarding.cliente_slug }),
        });
        console.log(`[first-run] cliente=${onboarding.cliente_slug} dispatch status=${dispatchResp.status}`);
      } catch (e: any) {
        console.warn(`[first-run] dispatch failed (no-fatal): ${e.message}`);
      }
    } else if (onboarding.agente_id === "facturacion") {
      console.log(`[first-run] skip dispatch — facturacion dispara desde save-fiscal-data, no desde auth-callback`);
    }
  }

  // 9. Redirect — el frontend detecta el step y muestra el step apropiado.
  const redirectFlag = nextStep === "completed" ? "completed=1" : "fiscal=1";
  return Response.redirect(`${adminUrl}/onboarding/${state}?oauth=ok&${redirectFlag}`, 302);
};

// === Helpers: idempotencia de Folder y Sheet ===
//
// Por qué existen: Google Drive permite múltiples archivos con el mismo nombre.
// Si este callback corre 2+ veces (doble-click, refresh, reintento), sin estos
// helpers crearía folders y sheets duplicados. Hemos visto este bug con
// carpetas de mes (5 carpetas "2026-01" en Freshco) y también es teóricamente
// posible con el Sheet de control inicial.
//
// Estrategia:
//   1. Si tenemos un ID guardado en client_credentials → validar que el archivo
//      todavía exista (no esté en trash) y reusarlo.
//   2. Si no, buscar archivos con ese nombre en el parent. Si hay alguno →
//      usar el más antiguo (canónico) y borrar el resto (consolidación).
//   3. Si no existe ninguno → crear nuevo.

async function resolveOrCreateFolder(
  accessToken: string,
  existingId: string | null,
  folderName: string,
): Promise<string> {
  // 1. Validar el ID guardado si lo hay
  if (existingId) {
    const existsResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${existingId}?fields=id,trashed`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (existsResp.ok) {
      const file = (await existsResp.json()) as { id: string; trashed: boolean };
      if (!file.trashed) {
        console.log(`[onboarding] reusing existing folder ${existingId}`);
        return existingId;
      }
    }
    console.warn(`[onboarding] saved folder ${existingId} not found or trashed — buscando por nombre`);
  }

  // 2. Buscar por nombre en root del cliente
  const q = encodeURIComponent(
    `name='${folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`,
  );
  const listResp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,createdTime)&orderBy=createdTime`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (listResp.ok) {
    const data = (await listResp.json()) as {
      files: Array<{ id: string; createdTime: string }>;
    };
    const files = data.files ?? [];
    if (files.length >= 1) {
      const canonico = files[0].id;
      console.log(`[onboarding] found ${files.length} folder(s) named "${folderName}", reusing oldest ${canonico}`);
      // Si hay duplicados, consolidar: mover archivos al canónico y borrar duplicados.
      for (let i = 1; i < files.length; i++) {
        await consolidateFolderInto(accessToken, files[i].id, canonico).catch((err) =>
          console.warn(`[onboarding] consolidate folder ${files[i].id} failed: ${err.message}`),
        );
      }
      return canonico;
    }
  }

  // 3. Crear nuevo
  const createResp = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: ["root"],
    }),
  });
  if (!createResp.ok) {
    throw new Error(`drive folder create: ${await createResp.text()}`);
  }
  const folder = (await createResp.json()) as { id: string };
  console.log(`[onboarding] created new folder ${folder.id} named "${folderName}"`);
  return folder.id;
}

async function resolveOrCreateSheet(
  accessToken: string,
  parentFolderId: string,
  existingId: string | null,
  sheetName: string,
): Promise<string> {
  // 1. Validar el ID guardado si lo hay
  if (existingId) {
    const existsResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${existingId}?fields=id,trashed,parents`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (existsResp.ok) {
      const file = (await existsResp.json()) as {
        id: string;
        trashed: boolean;
        parents?: string[];
      };
      if (!file.trashed) {
        console.log(`[onboarding] reusing existing sheet ${existingId}`);
        // Bonus: si el sheet existe pero NO está en el folder canónico,
        // moverlo. Cubre el caso donde el folder se recreó pero el sheet no.
        if (!file.parents?.includes(parentFolderId) && file.parents?.length) {
          try {
            await fetch(
              `https://www.googleapis.com/drive/v3/files/${existingId}?addParents=${parentFolderId}&removeParents=${file.parents.join(",")}`,
              { method: "PATCH", headers: { Authorization: `Bearer ${accessToken}` } },
            );
            console.log(`[onboarding] moved sheet ${existingId} into folder ${parentFolderId}`);
          } catch (err: any) {
            console.warn(`[onboarding] move sheet failed: ${err.message}`);
          }
        }
        return existingId;
      }
    }
    console.warn(`[onboarding] saved sheet ${existingId} not found or trashed — buscando por nombre`);
  }

  // 2. Buscar por nombre dentro del folder padre
  const q = encodeURIComponent(
    `name='${sheetName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.spreadsheet' and '${parentFolderId}' in parents and trashed=false`,
  );
  const listResp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,createdTime)&orderBy=createdTime`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (listResp.ok) {
    const data = (await listResp.json()) as {
      files: Array<{ id: string; createdTime: string }>;
    };
    const files = data.files ?? [];
    if (files.length >= 1) {
      const canonico = files[0].id;
      console.log(`[onboarding] found ${files.length} sheet(s) named "${sheetName}", reusing oldest ${canonico}`);
      // Borrar duplicados (no podemos consolidar pestañas entre spreadsheets fácilmente;
      // si hay un duplicado vacío de un reintento previo, simplemente lo trasheamos).
      for (let i = 1; i < files.length; i++) {
        await trashFile(accessToken, files[i].id).catch((err) =>
          console.warn(`[onboarding] trash duplicate sheet ${files[i].id} failed: ${err.message}`),
        );
      }
      return canonico;
    }
  }

  // 3. Crear nuevo
  const createResp = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: sheetName,
      mimeType: "application/vnd.google-apps.spreadsheet",
      parents: [parentFolderId],
    }),
  });
  if (!createResp.ok) {
    throw new Error(`sheet create: ${await createResp.text()}`);
  }
  const sheet = (await createResp.json()) as { id: string };
  console.log(`[onboarding] created new sheet ${sheet.id} named "${sheetName}"`);
  return sheet.id;
}

/**
 * Mueve todos los archivos de un folder duplicado al folder canónico, y luego
 * trashea el duplicado. Idempotente: si el duplicado ya está vacío, solo lo trashea.
 */
async function consolidateFolderInto(
  accessToken: string,
  duplicatedId: string,
  canonicoId: string,
): Promise<void> {
  // Listar archivos del duplicado
  const q = encodeURIComponent(`'${duplicatedId}' in parents and trashed=false`);
  const listResp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,parents)`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (listResp.ok) {
    const data = (await listResp.json()) as {
      files: Array<{ id: string; parents?: string[] }>;
    };
    for (const f of data.files ?? []) {
      // Mover al canónico
      await fetch(
        `https://www.googleapis.com/drive/v3/files/${f.id}?addParents=${canonicoId}&removeParents=${duplicatedId}`,
        { method: "PATCH", headers: { Authorization: `Bearer ${accessToken}` } },
      ).catch(() => {});
    }
  }
  // Trashear el duplicado
  await trashFile(accessToken, duplicatedId);
}

async function trashFile(accessToken: string, fileId: string): Promise<void> {
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ trashed: true }),
  });
}
