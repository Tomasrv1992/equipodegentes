/**
 * SaludArchivo — sección del detalle de cliente que muestra la validación
 * cross-source del último run del reparador (Bloque B — 5 fuentes).
 *
 * Fuente única de verdad: `agent_runs.payload` del último run del agente
 * `reparador` (corre 8:15 Bogotá cada día + on-demand). El reparador ya
 * compara Gmail/Drive/Sheet/Events y guarda discrepancias por cliente y mes.
 *
 * Esto solo PRESENTA esos datos filtrados al cliente actual + permite
 * re-disparar el reparador para 1 cliente sin esperar al próximo cron.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import {
  useReparadorLastRun,
  type ReparadorValidacion,
} from "../lib/queries";

const MES_LABELS = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
];

interface Props {
  clienteSlug: string;
  driveFolderId?: string | null;
  sheetId?: string | null;
}

export default function SaludArchivo({ clienteSlug, driveFolderId, sheetId }: Props) {
  const { data: lastRun, isLoading, error } = useReparadorLastRun();
  const [showAll, setShowAll] = useState(false);

  if (isLoading) {
    return (
      <section className="mb-9">
        <h2 className="section-title mb-3">Salud del archivo</h2>
        <p className="font-mono text-[11px] text-ink-3 tracking-[0.04em] uppercase">
          Cargando última validación…
        </p>
      </section>
    );
  }

  if (error || !lastRun) {
    return (
      <section className="mb-9">
        <h2 className="section-title mb-3">Salud del archivo</h2>
        <div className="card text-ink-3 text-sm">
          No hay datos del reparador todavía. Corré una validación manual con el
          botón abajo (próximo cron diario: 8:15am Bogotá).
        </div>
        <div className="mt-3">
          <RevalidarPanel clienteSlug={clienteSlug} />
        </div>
      </section>
    );
  }

  // GUARDIA DEFENSIVA: aunque el hook filtra status=running, blindamos contra
  // payloads malformados que pueden venir de runs viejos o crash parcial.
  // Sin esto, una factura/auto_repairs siendo null crasheaba TODO el componente
  // y por lo tanto toda la ficha del cliente (bug detectado 2026-05-15).
  const p = (lastRun.payload ?? {}) as Partial<typeof lastRun.payload>;
  const safeArray = <T,>(maybe: unknown): T[] => (Array.isArray(maybe) ? (maybe as T[]) : []);
  const validaciones = safeArray<ReparadorValidacion>(p.validaciones).filter(
    (v) => v && v.cliente_slug === clienteSlug,
  );
  const pdfsHuerfanos = safeArray<{ cliente_slug: string; mes: number; drive_file_id: string; drive_file_name: string }>(
    p.pdfs_huerfanos,
  ).filter((x) => x && x.cliente_slug === clienteSlug);
  const filasSinPdf = safeArray<{ cliente_slug: string; mes: number; proveedor: string; num_factura: string }>(
    p.filas_sin_pdf,
  ).filter((x) => x && x.cliente_slug === clienteSlug);
  const autoRepairs = safeArray<{ cliente_slug: string }>(p.auto_repairs).filter(
    (x) => x && x.cliente_slug === clienteSlug,
  );

  // Orden ascendente por mes (Ene, Feb, ...)
  const validacionesOrdenadas = validaciones.slice().sort((a, b) => a.mes.localeCompare(b.mes));

  const todoCuadra = validacionesOrdenadas.length > 0 && validacionesOrdenadas.every((v) => v.todo_cuadra);
  const totalDiscrepancias = validacionesOrdenadas.filter((v) => !v.todo_cuadra).length;

  const ultimaValidacion = lastRun.finished_at ?? lastRun.started_at;

  return (
    <section className="mb-9">
      <div className="flex items-baseline justify-between mb-3 gap-3">
        <div>
          <h2 className="section-title">Salud del archivo</h2>
          <p className="font-mono text-[10px] text-ink-3 tracking-[0.04em] uppercase mt-0.5">
            Última validación: {formatTimestamp(ultimaValidacion)} ·{" "}
            {todoCuadra ? (
              <span className="text-ok">✓ todo cuadra</span>
            ) : (
              <span className="text-fail">
                {totalDiscrepancias} mes{totalDiscrepancias !== 1 ? "es" : ""} con discrepancias
              </span>
            )}
          </p>
        </div>
        <RevalidarPanel clienteSlug={clienteSlug} />
      </div>

      {validacionesOrdenadas.length === 0 ? (
        <div className="card text-ink-3 text-sm">
          El reparador no encontró datos del cliente {clienteSlug} en el último run.
        </div>
      ) : (
        <>
          {/* Tabla por mes: Gmail | Drive | Sheet | Events + Discrepancias */}
          <div className="card overflow-hidden p-0 mb-3">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-edge bg-paper-sunken">
                  <th className="text-left py-2 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
                    Mes
                  </th>
                  <th className="text-right py-2 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
                    Gmail
                  </th>
                  <th className="text-right py-2 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
                    Drive
                  </th>
                  <th className="text-right py-2 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
                    Sheet
                  </th>
                  <th className="text-right py-2 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
                    Events
                  </th>
                  <th className="text-left py-2 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
                    Estado
                  </th>
                </tr>
              </thead>
              <tbody>
                {validacionesOrdenadas.map((v) => (
                  <ValidacionRow key={v.mes} v={v} />
                ))}
              </tbody>
            </table>
          </div>

          {/* Auto-reparaciones del cliente (informativo) */}
          {autoRepairs.length > 0 && (
            <div className="font-mono text-[10px] text-ink-3 tracking-[0.04em] mb-3">
              ↻ El reparador hizo {autoRepairs.length} auto-reparación{autoRepairs.length !== 1 ? "es" : ""} en este run
            </div>
          )}

          {/* PDFs huérfanos del cliente */}
          {pdfsHuerfanos.length > 0 && (
            <details className="card mb-3" open={pdfsHuerfanos.length <= 5}>
              <summary className="cursor-pointer font-mono text-[11px] tracking-[0.04em] text-fail">
                ⚠ {pdfsHuerfanos.length} PDF{pdfsHuerfanos.length !== 1 ? "s" : ""} huérfano{pdfsHuerfanos.length !== 1 ? "s" : ""} (en Drive sin fila en Sheet)
              </summary>
              <ul className="mt-3 space-y-1.5">
                {pdfsHuerfanos.slice(0, showAll ? undefined : 10).map((h) => (
                  <li key={h.drive_file_id} className="text-[12px] flex items-baseline gap-2">
                    <span className="font-mono text-[10px] text-ink-3 tabular-nums">
                      {MES_LABELS[h.mes - 1] ?? `Mes${h.mes}`}
                    </span>
                    <a
                      href={`https://drive.google.com/file/d/${h.drive_file_id}/view`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline"
                    >
                      {h.drive_file_name}
                    </a>
                  </li>
                ))}
              </ul>
              {pdfsHuerfanos.length > 10 && !showAll && (
                <button
                  onClick={() => setShowAll(true)}
                  className="mt-2 font-mono text-[10px] text-accent hover:underline"
                >
                  ver {pdfsHuerfanos.length - 10} más
                </button>
              )}
            </details>
          )}

          {/* Filas sin PDF del cliente */}
          {filasSinPdf.length > 0 && (
            <details className="card mb-3" open={filasSinPdf.length <= 5}>
              <summary className="cursor-pointer font-mono text-[11px] tracking-[0.04em] text-fail">
                ⚠ {filasSinPdf.length} fila{filasSinPdf.length !== 1 ? "s" : ""} en Sheet sin PDF en Drive
              </summary>
              <ul className="mt-3 space-y-1.5">
                {filasSinPdf.slice(0, showAll ? undefined : 10).map((f, i) => (
                  <li key={i} className="text-[12px] flex items-baseline gap-2">
                    <span className="font-mono text-[10px] text-ink-3 tabular-nums">
                      {MES_LABELS[f.mes - 1] ?? `Mes${f.mes}`}
                    </span>
                    <span className="text-ink">{f.proveedor}</span>
                    <span className="font-mono text-[11px] text-ink-3">#{f.num_factura}</span>
                  </li>
                ))}
              </ul>
              {filasSinPdf.length > 10 && !showAll && (
                <button
                  onClick={() => setShowAll(true)}
                  className="mt-2 font-mono text-[10px] text-accent hover:underline"
                >
                  ver {filasSinPdf.length - 10} más
                </button>
              )}
            </details>
          )}

          {/* Links rápidos a Drive y Sheet */}
          {(driveFolderId || sheetId) && (
            <div className="flex gap-3 mt-3 pt-3 border-t border-edge-2">
              {sheetId && (
                <a
                  href={`https://docs.google.com/spreadsheets/d/${sheetId}/edit`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[10px] text-accent hover:underline tracking-[0.04em]"
                >
                  📊 Abrir Sheet ↗
                </a>
              )}
              {driveFolderId && (
                <a
                  href={`https://drive.google.com/drive/folders/${driveFolderId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[10px] text-accent hover:underline tracking-[0.04em]"
                >
                  📁 Abrir Drive ↗
                </a>
              )}
            </div>
          )}

          {/* Reconstruir Sheet desde events — solo si hay duplicación detectada */}
          <RebuildSheetPanel clienteSlug={clienteSlug} validaciones={validaciones} />
        </>
      )}
    </section>
  );
}

/**
 * Botón "Reconstruir Sheet desde events" — solo visible si hay duplicación
 * sospechosa (sheet/events > 1.5×). Operación destructiva sobre el Sheet,
 * pide confirmación + permite dryRun primero.
 */
function RebuildSheetPanel({
  clienteSlug,
  validaciones,
}: {
  clienteSlug: string;
  validaciones: ReparadorValidacion[];
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [lastDryRun, setLastDryRun] = useState<any>(null);
  const queryClient = useQueryClient();

  // Detectar si hay algún mes con ratio sospechoso (sheet > events × 1.5)
  const tieneDuplicacion = validaciones.some(
    (v) => v.events > 0 && v.sheet > v.events * 1.5,
  );

  if (!tieneDuplicacion) return null;

  const peoresMeses = validaciones
    .filter((v) => v.events > 0 && v.sheet > v.events * 1.5)
    .map((v) => {
      const [, mm] = v.mes.split("-");
      return { mes: MES_LABELS[parseInt(mm, 10) - 1] ?? v.mes, ratio: v.sheet / v.events, sheet: v.sheet, events: v.events };
    })
    .sort((a, b) => b.ratio - a.ratio);

  const mut = useMutation({
    mutationFn: async (opts: { dryRun: boolean }) => {
      const { data: sess } = await supabase.auth.getSession();
      const accessToken = sess.session?.access_token;
      const resp = await fetch("/api/admin/rebuild-sheet-cliente", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ clienteSlug, dryRun: opts.dryRun }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      return resp.json();
    },
    onSuccess: (data, vars) => {
      if (vars.dryRun) setLastDryRun(data);
      else {
        setLastDryRun(null);
        setConfirmed(false);
        // Refresh datos en ~90s (rebuild puede tardar varios min según volumen)
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["reparador-last-run"] });
        }, 90_000);
      }
    },
  });

  return (
    <div className="mt-4 p-3 border border-fail/30 bg-fail-soft/30 rounded-md">
      <div className="font-mono text-[11px] text-fail tracking-[0.04em] uppercase mb-2">
        ⚠️ Duplicación detectada — reconstruir Sheet desde events
      </div>
      <p className="font-sans text-[12px] text-ink-2 mb-2">
        {peoresMeses.length} mes{peoresMeses.length !== 1 ? "es" : ""} con Sheet inflado.
        Esta acción <strong>borra todas las filas</strong> de los meses con datos en events
        y las reescribe limpio (1 fila por event). Es <strong>destructiva pero idempotente</strong>:
        si después corrés el cron, NO duplica.
      </p>
      <div className="font-mono text-[10px] text-ink-3 mb-2">
        Peores:{" "}
        {peoresMeses.slice(0, 3).map((m, i) => (
          <span key={i}>
            {m.mes} {m.sheet}→{m.events} ({m.ratio.toFixed(1)}×){i < peoresMeses.length - 1 ? " · " : ""}
          </span>
        ))}
      </div>

      {lastDryRun && (
        <div className="bg-paper p-2 rounded mb-2 font-mono text-[10px]">
          <div className="text-ok mb-1">✓ Dry-run completo. Borraría:</div>
          <ul className="space-y-0.5">
            {(lastDryRun.report ?? [])
              .filter((r: any) => r.events_encontrados > 0 || r.filas_borradas > 0)
              .map((r: any) => (
                <li key={r.mes}>
                  {r.tab}: {r.filas_borradas} filas → {r.events_encontrados} reales
                </li>
              ))}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => mut.mutate({ dryRun: true })}
          disabled={mut.isPending}
          className="font-mono text-[10px] tracking-[0.04em] px-3 py-1.5 rounded border border-edge bg-paper hover:bg-paper-sunken disabled:opacity-50"
        >
          {mut.isPending && !confirmed ? "Calculando…" : "Ver qué borraría (dry-run)"}
        </button>
        {lastDryRun && !confirmed && (
          <button
            onClick={() => setConfirmed(true)}
            className="font-mono text-[10px] tracking-[0.04em] px-3 py-1.5 rounded bg-fail/10 text-fail border border-fail/40 hover:bg-fail/20"
          >
            Confirmar rebuild
          </button>
        )}
        {confirmed && (
          <button
            onClick={() => mut.mutate({ dryRun: false })}
            disabled={mut.isPending}
            className="font-mono text-[10px] tracking-[0.04em] px-3 py-1.5 rounded bg-fail text-paper hover:bg-fail/90 disabled:opacity-50"
          >
            {mut.isPending ? "Reconstruyendo…" : "🔥 EJECUTAR REBUILD"}
          </button>
        )}
        {mut.isError && (
          <span className="font-mono text-[10px] text-fail">
            ⚠ {(mut.error as Error).message.slice(0, 80)}
          </span>
        )}
        {mut.isSuccess && !lastDryRun && (
          <span className="font-mono text-[10px] text-ok">
            ✓ rebuild disparado · refresh en ~90s
          </span>
        )}
      </div>
    </div>
  );
}

function ValidacionRow({ v }: { v: ReparadorValidacion }) {
  const [, mm] = v.mes.split("-");
  const mesLabel = MES_LABELS[parseInt(mm, 10) - 1] ?? v.mes;

  const cellClass = (count: number, ref: number) => {
    if (count === ref) return "text-ok";
    return "text-fail font-semibold";
  };

  return (
    <tr className={v.todo_cuadra ? "border-b border-edge-2" : "border-b border-edge-2 bg-fail-soft/30"}>
      <td className="py-2 px-3 font-mono text-[11px] uppercase tracking-[0.04em]">
        {mesLabel}
      </td>
      <td className={`py-2 px-3 text-right font-mono tabular-nums ${cellClass(v.gmail, v.events)}`}>
        {v.gmail}
      </td>
      <td className={`py-2 px-3 text-right font-mono tabular-nums ${cellClass(v.drive, v.events)}`}>
        {v.drive}
      </td>
      <td className={`py-2 px-3 text-right font-mono tabular-nums ${cellClass(v.sheet, v.events)}`}>
        {v.sheet}
      </td>
      <td className="py-2 px-3 text-right font-mono tabular-nums text-ink">
        {v.events}
      </td>
      <td className="py-2 px-3">
        {v.todo_cuadra ? (
          <span className="font-mono text-[10px] tracking-[0.04em] text-ok">✓ cuadra</span>
        ) : (
          <span className="font-mono text-[10px] tracking-[0.04em] text-fail">
            {v.discrepancias.join(" · ")}
          </span>
        )}
      </td>
    </tr>
  );
}

function RevalidarPanel({ clienteSlug }: { clienteSlug: string }) {
  const queryClient = useQueryClient();

  const mut = useMutation({
    mutationFn: async () => {
      const { data: sess } = await supabase.auth.getSession();
      const accessToken = sess.session?.access_token;
      const resp = await fetch("/api/admin/reparador-trigger-cliente", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ clienteSlug }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      return resp.json();
    },
    onSuccess: () => {
      // Refresh los datos del reparador (el run nuevo va a tardar ~30-60s)
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["reparador-last-run"] });
        queryClient.invalidateQueries({ queryKey: ["reparador-validations"] });
      }, 60_000);
    },
  });

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => mut.mutate()}
        disabled={mut.isPending}
        className="font-mono text-[10px] tracking-[0.04em] px-3 py-1.5 rounded bg-ink text-paper hover:bg-ink-2 disabled:opacity-50"
      >
        {mut.isPending ? "Re-validando…" : "Re-validar ahora"}
      </button>
      {mut.isSuccess && (
        <span className="font-mono text-[10px] text-ok tracking-[0.04em]">
          ✓ disparado · datos en ~1 min
        </span>
      )}
      {mut.isError && (
        <span
          className="font-mono text-[10px] text-fail tracking-[0.04em]"
          title={(mut.error as Error).message}
        >
          ⚠ falló
        </span>
      )}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMin = Math.round((now.getTime() - d.getTime()) / 60_000);
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `hace ${diffH}h`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) return `hace ${diffD}d`;
  return d.toLocaleDateString("es-CO", { day: "numeric", month: "short" });
}
