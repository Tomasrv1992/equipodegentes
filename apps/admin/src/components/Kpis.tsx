import type { ReactNode } from "react";

export interface KpiData {
  label: string;
  value: ReactNode;
  unit?: string;
  meta?: ReactNode;
  alert?: boolean;
}

export default function Kpis({ items }: { items: KpiData[] }) {
  return (
    <section className="grid grid-cols-4 border border-edge rounded-lg bg-paper-2 mb-9 overflow-hidden">
      {items.map((kpi, i) => (
        <div
          key={i}
          className="p-5 border-r border-edge last:border-r-0 flex flex-col gap-0.5"
        >
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3 font-medium mb-1.5">
            {kpi.label}
          </div>
          <div className="flex items-baseline gap-1.5">
            <span
              className={`font-display font-medium leading-none tracking-[-0.03em] ${
                kpi.alert ? "text-accent" : "text-ink"
              }`}
              style={{ fontSize: "32px" }}
            >
              {kpi.value}
            </span>
            {kpi.unit && (
              <span className="font-sans text-sm text-ink-3 font-medium">
                {kpi.unit}
              </span>
            )}
          </div>
          {kpi.meta && (
            <div className="font-mono text-[10px] text-ink-3 mt-1 tracking-[0.04em]">
              {kpi.meta}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
