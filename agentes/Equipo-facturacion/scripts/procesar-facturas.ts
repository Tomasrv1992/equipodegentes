#!/usr/bin/env -S npx tsx
// Thin CLI wrapper: importa el pipeline core y lo corre con .env.local.
// La lógica vive en agentes/Equipo-facturacion/lib/pipeline.ts
// (compartida con la background fn de Netlify para evitar drift).
//
// Uso (desde la raíz del repo):
//   npx tsx --env-file=agentes/Equipo-facturacion/.env.local agentes/Equipo-facturacion/scripts/procesar-facturas.ts
//   ... --dry-run                 # solo lista
//   ... --window 365d --limit 5   # backfill histórico, primeras 5

import { run, type PipelineConfig } from "../lib/pipeline";

const argv = process.argv.slice(2);
function flag(name: string): string | null {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}
const dryRun = argv.includes("--dry-run");
const window = flag("--window") ?? "30d";
const limitStr = flag("--limit");
const limit = limitStr ? parseInt(limitStr, 10) : null;

const required = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
  "INVOICES_DRIVE_FOLDER_ID",
  "INVOICES_SHEET_ID",
] as const;
for (const k of required) {
  if (!process.env[k]) {
    console.error(JSON.stringify({ fatal: `Falta env ${k}` }));
    process.exit(1);
  }
}

const cfg: PipelineConfig = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN!,
    driveFolderId: process.env.INVOICES_DRIVE_FOLDER_ID!,
    sheetId: process.env.INVOICES_SHEET_ID!,
    sheetTab: process.env.INVOICES_SHEET_TAB || "Gastos 2026",
  },
  options: { dryRun, window, limit },
};

run(cfg)
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.error(JSON.stringify({ fatal: err.message, stack: err.stack }));
    process.exit(1);
  });
