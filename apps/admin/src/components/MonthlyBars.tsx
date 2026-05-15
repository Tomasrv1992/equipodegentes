import { tiempoAhorradoHoras, formatHoras, type MesAgg } from "../lib/metrics";

interface MonthlyBarsProps {
  data: MesAgg[];
  /** Mostrar columna de tiempo ahorrado a la derecha. Default: true. */
  showAhorrado?: boolean;
}

/**
 * Bar chart horizontal de runs procesados por mes.
 * Cada fila: [mes label] [bar] [count] [ahorrado]
 */
export default function MonthlyBars({ data, showAhorrado = true }: MonthlyBarsProps) {
  const max = Math.max(1, ...data.map((d) => d.procesadas));

  return (
    <div className="space-y-2.5">
      {data.map((m) => (
        <div key={m.key} className="flex items-center gap-3">
          <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.08em] w-10 tabular-nums">
            {m.label}
          </div>
          <div className="flex-1 h-5 bg-paper-sunken rounded-sm overflow-hidden relative">
            <div
              className="h-full bg-ok transition-all duration-500 ease-out-expo"
              style={{ width: `${(m.procesadas / max) * 100}%` }}
            />
          </div>
          <div className="font-mono text-[11px] text-ink tabular-nums w-12 text-right tracking-[0.02em]">
            {m.procesadas}
          </div>
          {showAhorrado && (
            <div className="font-mono text-[10px] text-ink-3 tabular-nums w-16 text-right tracking-[0.04em]">
              {formatHoras(tiempoAhorradoHoras(m.procesadas))}
            </div>
          )}
        </div>
      ))}
      <div className="flex items-center gap-3 pt-2 mt-1 border-t border-edge-2">
        <div className="w-10" />
        <div className="flex-1" />
        <div className="font-mono text-[9px] text-ink-4 uppercase tracking-[0.08em] w-12 text-right">
          facturas
        </div>
        {showAhorrado && (
          <div className="font-mono text-[9px] text-ink-4 uppercase tracking-[0.08em] w-16 text-right">
            ahorrado
          </div>
        )}
      </div>
    </div>
  );
}
