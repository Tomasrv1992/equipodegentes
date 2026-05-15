/**
 * ResumenSaludClientes — card en /operacion que destaca clientes con
 * discrepancias 5-fuentes (Gmail/Drive/Sheet/Events) del último run del
 * reparador. Permite a Tomás ver de un vistazo qué clientes requieren
 * atención sin tener que entrar a cada ficha.
 *
 * Solo muestra clientes con AL MENOS un mes desalineado. Si todos cuadran,
 * la card no se renderiza (no agregar ruido).
 */

import { Link } from "react-router-dom";
import { useReparadorLastRun } from "../lib/queries";

const MES_LABELS = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
];

export default function ResumenSaludClientes() {
  const { data: lastRun, isLoading } = useReparadorLastRun();

  if (isLoading || !lastRun) return null;

  const validaciones = lastRun.payload.validaciones ?? [];
  const pdfsHuerfanos = lastRun.payload.pdfs_huerfanos ?? [];
  const filasSinPdf = lastRun.payload.filas_sin_pdf ?? [];

  // Agrupar por cliente
  const byCliente = new Map<
    string,
    {
      mesesProblema: Array<{ mes: string; discrepancias: string[] }>;
      huerfanos: number;
      sinPdf: number;
    }
  >();

  for (const v of validaciones) {
    if (v.todo_cuadra) continue;
    const entry = byCliente.get(v.cliente_slug) ?? {
      mesesProblema: [],
      huerfanos: 0,
      sinPdf: 0,
    };
    entry.mesesProblema.push({ mes: v.mes, discrepancias: v.discrepancias });
    byCliente.set(v.cliente_slug, entry);
  }

  for (const h of pdfsHuerfanos) {
    const entry = byCliente.get(h.cliente_slug) ?? {
      mesesProblema: [],
      huerfanos: 0,
      sinPdf: 0,
    };
    entry.huerfanos++;
    byCliente.set(h.cliente_slug, entry);
  }

  for (const f of filasSinPdf) {
    const entry = byCliente.get(f.cliente_slug) ?? {
      mesesProblema: [],
      huerfanos: 0,
      sinPdf: 0,
    };
    entry.sinPdf++;
    byCliente.set(f.cliente_slug, entry);
  }

  if (byCliente.size === 0) return null;

  const filas = Array.from(byCliente.entries())
    .map(([slug, data]) => ({ slug, ...data }))
    // Ordenar: primero los que tienen más meses con problemas, después por huérfanos+sin_pdf
    .sort((a, b) => {
      const aTotal = a.mesesProblema.length * 10 + a.huerfanos + a.sinPdf;
      const bTotal = b.mesesProblema.length * 10 + b.huerfanos + b.sinPdf;
      return bTotal - aTotal;
    });

  const ultima = lastRun.finished_at ?? lastRun.started_at;
  const ultimaLabel = formatRelative(ultima);

  return (
    <section className="mb-9">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h2 className="section-title">Salud del archivo · clientes con discrepancias</h2>
          <p className="font-mono text-[10px] text-ink-3 tracking-[0.04em] uppercase mt-0.5">
            Última validación 5-fuentes: {ultimaLabel} · {filas.length} cliente{filas.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Link
          to="/diagnostico"
          className="font-mono text-[11px] text-accent hover:underline tracking-[0.04em]"
        >
          ver diagnóstico completo →
        </Link>
      </div>
      <div className="card overflow-hidden p-0">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-edge bg-paper-sunken">
              <th className="text-left py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
                Cliente
              </th>
              <th className="text-left py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
                Meses con discrepancia
              </th>
              <th className="text-right py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
                PDFs huérfanos
              </th>
              <th className="text-right py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">
                Sin PDF
              </th>
              <th className="text-left py-2.5 px-3 font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]"></th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.slug} className="border-b border-edge-2 hover:bg-paper-sunken/30">
                <td className="py-2 px-3">
                  <Link
                    to={`/cliente/${f.slug}`}
                    className="text-ink hover:text-accent font-medium"
                  >
                    {f.slug}
                  </Link>
                </td>
                <td className="py-2 px-3">
                  <div className="flex flex-wrap gap-1">
                    {f.mesesProblema.map((mp, i) => {
                      const [, mm] = mp.mes.split("-");
                      const label = MES_LABELS[parseInt(mm, 10) - 1] ?? mp.mes;
                      return (
                        <span
                          key={i}
                          title={mp.discrepancias.join(" · ")}
                          className="font-mono text-[10px] tracking-[0.04em] px-1.5 py-0.5 rounded bg-fail-soft text-fail"
                        >
                          {label}
                        </span>
                      );
                    })}
                    {f.mesesProblema.length === 0 && (
                      <span className="font-mono text-[10px] text-ink-3">—</span>
                    )}
                  </div>
                </td>
                <td className="py-2 px-3 text-right font-mono tabular-nums">
                  {f.huerfanos > 0 ? (
                    <span className="text-fail font-medium">{f.huerfanos}</span>
                  ) : (
                    <span className="text-ink-4">0</span>
                  )}
                </td>
                <td className="py-2 px-3 text-right font-mono tabular-nums">
                  {f.sinPdf > 0 ? (
                    <span className="text-fail font-medium">{f.sinPdf}</span>
                  ) : (
                    <span className="text-ink-4">0</span>
                  )}
                </td>
                <td className="py-2 px-3">
                  <Link
                    to={`/cliente/${f.slug}`}
                    className="font-mono text-[10px] text-accent hover:underline tracking-[0.04em]"
                  >
                    ver detalle →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMin = Math.round((now.getTime() - d.getTime()) / 60_000);
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `hace ${diffH}h`;
  const diffD = Math.round(diffH / 24);
  return `hace ${diffD}d`;
}
