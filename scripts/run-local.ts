/**
 * scripts/run-local.ts
 *
 * Invoca un endpoint de Netlify Functions LOCALMENTE, sin `netlify dev`.
 * Pensado para sesiones overnight desatendidas: cero comandos interactivos,
 * cero dependencias externas (solo Node nativo + Request/Response globales de Node 20+).
 *
 * USO:
 *   npx -y tsx scripts/run-local.ts <ruta-al-handler> '<json-body>'
 *
 *   (el `-y` evita el prompt "Need to install tsx? (y/N)" — crítico para overnight)
 *
 * EJEMPLOS (los 3 dry-runs de la noche, todos solo-lectura):
 *
 *   # A) Diagnóstico Tarea 0
 *   npx -y tsx scripts/run-local.ts netlify/functions/inspect-perdidas-background.mts \
 *     '{"clienteSlug":"dentilandia","facturas":[{"proveedor_contains":"protokimicas","numero":""}]}' \
 *     | tee diagnostico-tarea0.json
 *
 *   # B) Backfill dryRun (valida normalización)
 *   npx -y tsx scripts/run-local.ts netlify/functions/backfill-messageid-background.mts \
 *     '{"clienteSlug":"dentilandia","year":2026,"dryRun":true}' \
 *     | tee backfill-dryrun.json
 *
 *   # C) Reconcile dryRun (pre-backfill, informativo)
 *   npx -y tsx scripts/run-local.ts netlify/functions/reconcile-labels-background.mts \
 *     '{"clienteSlug":"dentilandia","year":2026,"dryRun":true}' \
 *     | tee reconcile-dryrun-PREbackfill.json
 *
 * SEGURIDAD: este script NO fuerza dryRun. La protección vive en que SIEMPRE
 * pasás dryRun:true en el body. Nunca pongas dryRun:false desde aquí en la noche.
 *
 * El status y los logs van a stderr; SOLO el JSON de respuesta va a stdout,
 * para que `| tee archivo.json` capture limpio.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Carga .env.local a process.env sin dependencias (dotenv-free). */
function loadEnvLocal(path: string): void {
  if (!existsSync(path)) {
    console.error(`[run-local] AVISO: no existe ${path} — el handler puede fallar por env faltante.`);
    return;
  }
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim(); // también limpia el \r de Windows
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    let val = withoutExport.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
  // NOTA: parser de una línea por valor. Si CREDENTIALS_VAULT_KEY fuera multilínea
  // (PEM con saltos), usá dotenv en su lugar. Para JWT/strings normales, esto basta.
}

async function main(): Promise<void> {
  const [, , handlerArg, bodyArg] = process.argv;

  if (!handlerArg) {
    console.error("Uso: npx -y tsx scripts/run-local.ts <ruta-handler.mts> '<json-body>'");
    process.exit(1);
  }

  loadEnvLocal(resolve(process.cwd(), ".env.local"));

  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  if (!secret) {
    console.error("[run-local] FALTA FACTURACION_INTERNAL_SECRET en .env.local — abortando.");
    process.exit(1);
  }

  const body = bodyArg ?? "{}";
  // Validar que el body sea JSON antes de invocar (falla rápido, no a medio handler)
  try {
    JSON.parse(body);
  } catch {
    console.error("[run-local] El body no es JSON válido:", body);
    process.exit(1);
  }

  const handlerFullPath = resolve(process.cwd(), handlerArg);
  if (!existsSync(handlerFullPath)) {
    console.error(`[run-local] No existe el handler: ${handlerFullPath}`);
    process.exit(1);
  }

  const mod = await import(pathToFileURL(handlerFullPath).href);

  const headers = {
    "content-type": "application/json",
    "x-internal-secret": secret,
  };
  const context = {} as any; // la mayoría de estos endpoints no usan el context de Netlify

  let printed = false;

  if (typeof mod.default === "function") {
    // Netlify Functions v2: (Request, context) => Response
    const req = new Request("http://localhost/.netlify/functions/local", {
      method: "POST",
      headers,
      body,
    });
    const res = await mod.default(req, context);
    if (res instanceof Response) {
      console.error(`[run-local] status ${res.status} (v2)`);
      const text = await res.text();
      printJson(text);
      printed = true;
    } else {
      console.error("[run-local] handler v2 no devolvió Response; imprimo crudo:");
      console.log(JSON.stringify(res, null, 2));
      printed = true;
    }
  } else if (typeof mod.handler === "function") {
    // Netlify Functions v1: (event, context) => { statusCode, body }
    const event = {
      httpMethod: "POST",
      headers,
      body,
      queryStringParameters: {},
      isBase64Encoded: false,
    };
    const res = await mod.handler(event, context);
    console.error(`[run-local] statusCode ${res?.statusCode ?? "?"} (v1)`);
    printJson(typeof res?.body === "string" ? res.body : JSON.stringify(res?.body ?? res));
    printed = true;
  }

  if (!printed) {
    console.error(
      `[run-local] ${handlerArg} no exporta ni 'default' (v2) ni 'handler' (v1). Nada que invocar.`,
    );
    process.exit(1);
  }
}

/** Imprime a stdout como JSON formateado si parsea; si no, crudo. */
function printJson(text: string): void {
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

main().catch((err) => {
  console.error("[run-local] ERROR invocando handler:", err);
  process.exit(1);
});
