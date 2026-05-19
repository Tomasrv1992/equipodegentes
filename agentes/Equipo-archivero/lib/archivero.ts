/**
 * Equipo-archivero — agente coordinador que unifica el trabajo de reparador
 * y limpiador en una sola pasada.
 *
 * Por qué existe: reparador y limpiador hacían trabajo solapado sobre los
 * mismos archivos (huérfanos, duplicados, validación 5-fuentes). Mantener 2
 * agentes = 2 crons + 2 invocaciones Netlify + 2 lecturas Gmail/Drive/Sheet
 * por cliente + race conditions silenciosas + 2 fuentes de verdad en panel.
 *
 * El archivero corre los dos en secuencia, consolida el reporte, y graba
 * UN solo agent_run con agente_id='archivero'. Eso le da al panel admin
 * una sola fuente de verdad ("¿cómo está el archivo del cliente?") sin
 * tener que combinar 2 runs distintos en 2 timestamps distintos.
 *
 * Diseño: NO se reescribe la lógica probada de reparador/limpiador — solo
 * se coordinan. Si futuro refactor amerita, las 4 etapas conceptuales
 * (Completar / Filename-match / LLM recovery / Cleanup duplicados/basura /
 * Validar 5-fuentes) se mueven adentro como sub-modulos. Por ahora, el
 * archivero es un wrapper estructural.
 *
 * Cron: 8:15 AM Bogotá (1 solo, en vez de reparador 8:15 + limpiador 8:30).
 */

import { runReparador, type ReparadorReport, type RunReparadorOptions } from "../../Equipo-reparador/lib/reparador";
import { runLimpiador, type LimpiadorReport } from "../../Equipo-limpiador/lib/limpiador";

export interface RunArchiveroOptions {
  /**
   * Si está set, ambos sub-agentes filtran por ese cliente.
   * Reparador soporta nativamente. Limpiador todavía no — TODO próximo refactor.
   */
  clienteSlugFilter?: string;
  /**
   * Si true, skipea el limpiador (solo corre reparador).
   * Útil cuando el limpiador está saturando Anthropic y queremos solo cross-check.
   */
  skipLimpiador?: boolean;
  /**
   * Si true, skipea el reparador. Raramente útil — solo para tests del limpiador.
   */
  skipReparador?: boolean;
}

export interface ArchiveroReport {
  fecha: string;
  ts_generated: string;
  duration_ms_reparador: number;
  duration_ms_limpiador: number;
  /** Sub-reporte del reparador (etapas 1-4: completar, filename-match, validar 5-fuentes). */
  reparador: ReparadorReport;
  /** Sub-reporte del limpiador (etapas 5-6: LLM recovery + cleanup duplicados/basura). Null si skipeado. */
  limpiador: LimpiadorReport | null;
  /** Agregados consolidados para vista rápida en panel. */
  resumen: {
    clientes_total: number;
    clientes_procesados: number;
    filas_reparadas: number;
    pdfs_huerfanos_residuales: number;
    filas_sin_pdf: number;
    huerfanos_recuperados: number;
    duplicados_movidos: number;
    no_identificables: number;
    filas_sheet_duplicadas_grupos: number;
    filas_basura: number;
    clientes_inconsistentes: string[];
    costo_llm_usd_total: number;
  };
  errores: Array<{ etapa: "reparador" | "limpiador"; cliente_slug?: string; error: string }>;
}

/**
 * Coordina reparador + limpiador, consolida reportes.
 *
 * Orden importante:
 *   1. Reparador primero — su Bloque B inserta filas desde events, lo que
 *      reduce los "huérfanos en Drive sin fila en Sheet" que el limpiador
 *      verá después. Sin esto el limpiador procesaría con LLM huérfanos
 *      que el reparador habría resuelto con regex (gasto innecesario).
 *   2. Limpiador después — actúa sobre los huérfanos residuales (los que
 *      el reparador no pudo matchear por filename) y hace cleanup de
 *      duplicados/basura en Sheet.
 *
 * Si reparador crashea, limpiador igual corre (independientes — el limpiador
 * lee Drive y Sheet directamente, no depende del reparador).
 */
export async function runArchivero(opts: RunArchiveroOptions = {}): Promise<ArchiveroReport> {
  const ts = new Date();
  const fecha = bogotaDate(ts);

  let reparadorReport: ReparadorReport;
  let durRep = 0;
  const errores: ArchiveroReport["errores"] = [];

  // === Etapa 1-4: REPARADOR ===
  const t0 = Date.now();
  if (opts.skipReparador) {
    reparadorReport = emptyReparadorReport(fecha, ts);
  } else {
    try {
      const repOpts: RunReparadorOptions = {};
      if (opts.clienteSlugFilter) repOpts.clienteSlugFilter = opts.clienteSlugFilter;
      reparadorReport = await runReparador(repOpts);
    } catch (e: any) {
      console.error(`[archivero] reparador failed: ${e.message}`);
      errores.push({ etapa: "reparador", error: e.message });
      reparadorReport = emptyReparadorReport(fecha, ts);
    }
  }
  durRep = Date.now() - t0;

  // Guard: si el reparador reportó errores graves, no correr el limpiador.
  // El limpiador con LLM puede insertar filas duplicadas si el Sheet está
  // en estado inconsistente. Más seguro abortar y dejar que el próximo cron
  // corra con el Sheet estabilizado.
  const erroresGravesReparador = errores.filter(
    (e) => e.etapa === "reparador"
  ).length;
  const hayInconsistencias = reparadorReport.clientes_inconsistentes?.length > 0;

  if (erroresGravesReparador > 0 || hayInconsistencias) {
    console.error(
      `[archivero] ABORTANDO limpiador: reparador tuvo ${erroresGravesReparador} errores y ${reparadorReport.clientes_inconsistentes?.length ?? 0} clientes inconsistentes. Limpiador no corre para proteger integridad del Sheet.`
    );
    // Construir resumen parcial sin limpiador
    const resumenParcial: ArchiveroReport["resumen"] = {
      clientes_total: reparadorReport.clientes_total,
      clientes_procesados: reparadorReport.clientes_procesados,
      filas_reparadas: reparadorReport.filas_reparadas.length,
      pdfs_huerfanos_residuales: reparadorReport.pdfs_huerfanos.length,
      filas_sin_pdf: reparadorReport.filas_sin_pdf.length,
      huerfanos_recuperados: 0,
      duplicados_movidos: 0,
      no_identificables: 0,
      filas_sheet_duplicadas_grupos: 0,
      filas_basura: 0,
      clientes_inconsistentes: reparadorReport.clientes_inconsistentes,
      costo_llm_usd_total: 0,
    };
    return {
      fecha,
      ts_generated: ts.toISOString(),
      duration_ms_reparador: durRep,
      duration_ms_limpiador: 0,
      reparador: reparadorReport,
      limpiador: null,
      resumen: resumenParcial,
      errores: [...errores, {
        etapa: "limpiador",
        error: "Limpiador abortado por errores en reparador — Sheet posiblemente inconsistente",
      }],
    };
  }

  // === Etapa 5-6: LIMPIADOR ===
  let limpiadorReport: LimpiadorReport | null = null;
  let durLimp = 0;
  if (!opts.skipLimpiador) {
    const t1 = Date.now();
    try {
      // NOTA: limpiador todavía no acepta clienteSlugFilter. Corre global.
      // TODO próximo refactor: extender limpiador para soportar el filtro.
      limpiadorReport = await runLimpiador();
    } catch (e: any) {
      console.error(`[archivero] limpiador failed: ${e.message}`);
      errores.push({ etapa: "limpiador", error: e.message });
    }
    durLimp = Date.now() - t1;
  }

  // Errores agregados de cada sub-agente
  for (const e of reparadorReport.errores ?? []) {
    errores.push({ etapa: "reparador", cliente_slug: e.cliente_slug, error: e.error });
  }
  if (limpiadorReport) {
    for (const e of limpiadorReport.errores ?? []) {
      errores.push({ etapa: "limpiador", cliente_slug: e.cliente_slug, error: e.error });
    }
  }

  // Agregados consolidados
  const resumen: ArchiveroReport["resumen"] = {
    clientes_total: reparadorReport.clientes_total,
    clientes_procesados: reparadorReport.clientes_procesados,
    filas_reparadas: reparadorReport.filas_reparadas.length,
    pdfs_huerfanos_residuales: reparadorReport.pdfs_huerfanos.length,
    filas_sin_pdf: reparadorReport.filas_sin_pdf.length,
    huerfanos_recuperados: limpiadorReport?.facturas_recuperadas ?? 0,
    duplicados_movidos: limpiadorReport?.duplicados_movidos ?? 0,
    no_identificables: limpiadorReport?.no_identificables ?? 0,
    filas_sheet_duplicadas_grupos: limpiadorReport?.filas_sheet_duplicadas.length ?? 0,
    filas_basura: limpiadorReport?.filas_basura.length ?? 0,
    clientes_inconsistentes: reparadorReport.clientes_inconsistentes,
    costo_llm_usd_total: limpiadorReport?.costo_llm_usd ?? 0,
  };

  return {
    fecha,
    ts_generated: ts.toISOString(),
    duration_ms_reparador: durRep,
    duration_ms_limpiador: durLimp,
    reparador: reparadorReport,
    limpiador: limpiadorReport,
    resumen,
    errores,
  };
}

function emptyReparadorReport(fecha: string, ts: Date): ReparadorReport {
  return {
    fecha,
    ts_generated: ts.toISOString(),
    clientes_total: 0,
    clientes_procesados: 0,
    clientes_skipped: 0,
    filas_reparadas: [],
    pdfs_huerfanos: [],
    filas_sin_pdf: [],
    auto_repairs: [],
    validaciones: [],
    clientes_inconsistentes: [],
    errores: [],
  };
}

function bogotaDate(now: Date): string {
  const ms = now.getTime() - 5 * 60 * 60 * 1000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
