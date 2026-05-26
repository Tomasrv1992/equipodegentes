// netlify/functions/trigger-backfill.mts
//
// Dispara el backfill MANUAL de un cliente desde mes 1 al mes actual,
// SECUENCIAL (encadenado mes a mes con chainNextMonths). Usado después
// del onboarding cuando first_run no procesó todo.
//
// Body: { clienteSlug, fromMonth?, toMonth?, concurrency? }
//
// Solo dispara UN dispatch (mes más viejo). El background dispara el siguiente
// al terminar este (via chainNextMonths).

import type { Config } from "@netlify/functions";

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const fromMonth = Math.max(1, Math.min(12, Number(body.fromMonth) || 1));
  const toMonth = Math.max(fromMonth, Math.min(12, Number(body.toMonth) || (new Date().getMonth() + 1)));
  const concurrency = Math.max(1, Math.min(10, Number(body.concurrency) || 1));

  if (!clienteSlug) return new Response("missing clienteSlug", { status: 400 });

  const baseUrl = process.env.URL;
  if (!baseUrl) return new Response("missing URL env", { status: 500 });

  const meses: number[] = [];
  for (let m = fromMonth; m <= toMonth; m++) meses.push(m);
  const firstMes = meses[0];
  const chainNextMonths = meses.slice(1);

  console.log(
    `[trigger-backfill] cliente=${clienteSlug} fromMonth=${fromMonth} toMonth=${toMonth} ` +
    `concurrency=${concurrency} chain=[${chainNextMonths.join(",")}]`,
  );

  const res = await fetch(`${baseUrl}/.netlify/functions/facturacion-background`, {
    method: "POST",
    headers: {
      "x-internal-secret": secret,
      "x-trigger": "manual-backfill-sequential",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      customerId: clienteSlug,
      force: true,
      silent: true,
      monthFilter: firstMes,
      skipSheetSetup: false, // primer mes hace setup
      notifyMonthComplete: false,
      skipPreflight: false,
      concurrency,
      chainNextMonths,
    }),
  });

  return new Response(
    JSON.stringify({
      ok: true,
      cliente: clienteSlug,
      meses_a_procesar: meses,
      primer_mes: firstMes,
      chain_next: chainNextMonths,
      dispatch_status: res.status,
      estrategia: "secuencial — primer mes dispara, al terminar dispara el siguiente",
    }),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
