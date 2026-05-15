import type { ReactNode } from "react";

interface HeroProps {
  eyebrow: ReactNode;
  /** Título principal. Acepta JSX para resaltar parte en italic. */
  title: ReactNode;
  deck?: ReactNode;
  /** Stat grande a la derecha. */
  statValue?: ReactNode;
  statLabel?: ReactNode;
  /** Color del dot del eyebrow (status global). */
  eyebrowDot?: "ok" | "warn" | "fail";
}

export default function Hero({
  eyebrow,
  title,
  deck,
  statValue,
  statLabel,
  eyebrowDot = "ok",
}: HeroProps) {
  const dotColor = {
    ok:   "bg-ok",
    warn: "bg-warn",
    fail: "bg-fail",
  }[eyebrowDot];

  return (
    <section className="grid grid-cols-[1fr_auto] gap-12 items-end border-b border-edge pb-8 mb-9">
      <div>
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-3 font-medium mb-3 flex items-center gap-2">
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor}`}
            style={{
              boxShadow: `0 0 0 3px color-mix(in oklch, var(--tw-ring-color, transparent) 0%, ${getOklch(eyebrowDot)} 22%, transparent)`,
            }}
          />
          {eyebrow}
        </div>
        <h1
          className="font-display font-medium leading-[0.95] tracking-tightest text-ink m-0"
          style={{ fontSize: "clamp(40px, 6vw, 72px)" }}
        >
          {title}
        </h1>
        {deck && (
          <p className="font-sans text-sm text-ink-3 mt-2 max-w-[540px] leading-relaxed">
            {deck}
          </p>
        )}
      </div>

      {statValue !== undefined && (
        <div className="text-right">
          <div
            className="font-display font-normal leading-none tracking-tightest text-ink mb-2"
            style={{ fontSize: "56px" }}
          >
            {statValue}
          </div>
          {statLabel && (
            <div className="font-mono text-[10px] tracking-[0.06em] uppercase text-ink-3">
              {statLabel}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function getOklch(status: "ok" | "warn" | "fail"): string {
  return {
    ok:   "oklch(0.58 0.13 145)",
    warn: "oklch(0.70 0.16 75)",
    fail: "oklch(0.58 0.21 25)",
  }[status];
}
