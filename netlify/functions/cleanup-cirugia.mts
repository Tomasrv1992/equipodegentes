// netlify/functions/cleanup-cirugia.mts
//
// Cirugia post-procesamiento: limpia datos basura del cliente sin reset.
// Operaciones (idempotentes, dryRun por defecto):
//   1. Borra de BD events de planillas SS de terceros (titular != nitCliente)
//   2. Borra de BD events de bitácoras (concepto/proveedor matching "bitacora")
//   3. Borra filas correspondientes del Sheet (NO toca Drive PDFs - reversible)
//   4. Devuelve resumen de qué se hizo
//
// Body: { clienteSlug, dryRun?: boolean, year?: number }
// Si dryRun=true (default), solo cuenta sin borrar.

import type { Config } from "@netlify/functions";
import { google } from "googleapis";
import { getServerClient } from "../../shared/agents-runtime/src/supabase-server";
import { loadCredentials } from "../../shared/agents-runtime/src/credentials";

const MES_TABS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  if (req.headers.get("x-internal-secret") !== secret) return new Response("unauthorized", { status: 401 });

  const body = await req.json();
  const clienteSlug = body.clienteSlug?.trim();
  const dryRun = body.dryRun !== false; // default true
  const year = Number(body.year) || new Date().getFullYear();

  if (!clienteSlug) return new Response("missing clienteSlug", { status: 400 });

  const supa = getServerClient();
  const { data: cli } = await supa.from("clientes").select("id, nombre").eq("slug", clienteSlug).single();
  if (!cli) return new Response("cliente not found", { status: 404 });
  const clienteId = (cli as any).id as string;

  const { data: cred } = await supa
    .from("client_credentials")
    .select("nit_cliente")
    .eq("cliente_id", clienteId)
    .eq("agente_id", "facturacion")
    .single();
  const nitCliente = ((cred as any)?.nit_cliente ?? "").replace(/\D+/g, "");

  // === 1. Identificar planillas SS de terceros ===
  // payload.tipo === "planilla_ss" (campo guardado por processPlanilla)
  // O proveedor === "Planilla Seguridad Social"
  // Y numero != nitCliente
  const planillasTerceros: any[] = [];
  let from = 0;
  while (from < 100_000) {
    const { data, error } = await supa
      .from("agent_events")
      .select("id, payload, run_id")
      .eq("cliente_id", clienteId)
      .eq("agente_id", "facturacion")
      .eq("tipo", "factura_procesada")
      .range(from, from + 999);
    if (error) break;
    const batch = (data ?? []) as any[];
    for (const ev of batch) {
      const p = ev.payload ?? {};
      const numero = String(p.numero ?? "").replace(/\D+/g, "");
      const proveedor = String(p.proveedor ?? "").toLowerCase();
      const tipo = String(p.tipo ?? "").toLowerCase();

      const isPlanilla =
        tipo === "planilla_ss" ||
        proveedor.includes("planilla seguridad social") ||
        proveedor.includes("planilla ss");

      if (isPlanilla && numero && nitCliente && numero !== nitCliente) {
        planillasTerceros.push({
          event_id: ev.id,
          numero,
          proveedor: p.proveedor,
          fecha: p.fecha,
          concepto: p.concepto,
        });
      }
    }
    if (batch.length < 1000) break;
    from += 1000;
  }

  // === 2. Identificar bitácoras (por concepto o proveedor matching) ===
  const bitacoras: any[] = [];
  from = 0;
  while (from < 100_000) {
    const { data, error } = await supa
      .from("agent_events")
      .select("id, payload, run_id")
      .eq("cliente_id", clienteId)
      .eq("agente_id", "facturacion")
      .eq("tipo", "factura_procesada")
      .range(from, from + 999);
    if (error) break;
    const batch = (data ?? []) as any[];
    for (const ev of batch) {
      const p = ev.payload ?? {};
      const proveedor = String(p.proveedor ?? "").toLowerCase();
      const concepto = String(p.concepto ?? "").toLowerCase();
      const numero = String(p.numero ?? "");

      if (
        proveedor.includes("bitácora") || proveedor.includes("bitacora") ||
        concepto.includes("bitácora") || concepto.includes("bitacora")
      ) {
        bitacoras.push({
          event_id: ev.id,
          numero,
          proveedor: p.proveedor,
          fecha: p.fecha,
          concepto: p.concepto,
        });
      }
    }
    if (batch.length < 1000) break;
    from += 1000;
  }

  // === Si dryRun, solo reportar ===
  if (dryRun) {
    return new Response(
      JSON.stringify({
        ok: true,
        mode: "dry_run",
        cliente: clienteSlug,
        nitCliente,
        planillas_terceros_a_borrar: planillasTerceros.length,
        muestra_planillas: planillasTerceros.slice(0, 10),
        bitacoras_a_borrar: bitacoras.length,
        muestra_bitacoras: bitacoras.slice(0, 10),
        proximo_paso: "llamar de nuevo con dryRun=false para ejecutar borrado real",
      }, null, 2),
      { headers: { "content-type": "application/json" } },
    );
  }

  // === MODO REAL: borrar events ===
  const idsToDelete = [
    ...planillasTerceros.map((p) => p.event_id),
    ...bitacoras.map((b) => b.event_id),
  ];
  let deletedFromBd = 0;
  if (idsToDelete.length > 0) {
    const { error: delErr, count } = await supa
      .from("agent_events")
      .delete({ count: "exact" })
      .in("id", idsToDelete);
    if (delErr) {
      return new Response(JSON.stringify({ error: delErr.message }), { status: 500 });
    }
    deletedFromBd = count ?? 0;
  }

  // === Borrar filas correspondientes del Sheet (por NIT + numero matching) ===
  // Estrategia: cargar Sheet, identificar filas que correspondan a los events borrados,
  // y borrarlas con clearValues + recompactar.
  // Por ahora: solo BD. Sheet/Drive lo hace el usuario manualmente con base en el reporte.
  // (Para limpiar Sheet desde código, necesitaria Google Sheets API delete row by row).

  return new Response(
    JSON.stringify({
      ok: true,
      mode: "real_delete",
      cliente: clienteSlug,
      nitCliente,
      eventos_planillas_terceros_borrados: planillasTerceros.length,
      eventos_bitacoras_borrados: bitacoras.length,
      total_bd_borrado: deletedFromBd,
      muestra_planillas_borradas: planillasTerceros.slice(0, 5),
      muestra_bitacoras_borradas: bitacoras.slice(0, 5),
      nota: "Eventos borrados de BD. Sheet/Drive NO se tocaron - revisar manualmente o usar siguiente endpoint.",
    }, null, 2),
    { headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {};
