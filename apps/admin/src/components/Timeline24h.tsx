import type { TimelineTick } from "../lib/timeline";

const COLOR: Record<TimelineTick["status"], string> = {
  ok:      "bg-ok",
  fail:    "bg-fail",
  warn:    "bg-warn",
  running: "bg-ink-4",
  empty:   "bg-paper-sunken",
};

export default function Timeline24h({ ticks }: { ticks: TimelineTick[] }) {
  return (
    <div className="space-y-2">
      <div className="flex gap-[2px] h-[26px] items-end">
        {ticks.map((t) => (
          <div
            key={t.hourOffset}
            className={`flex-1 h-full rounded-sm transition-transform duration-100 ease-out-expo hover:scale-y-110 ${COLOR[t.status]}`}
            title={`hace ${t.hourOffset}h · ${t.status}${t.count > 1 ? ` · ${t.count} runs` : ""}`}
            style={{ opacity: t.status === "empty" ? 0.5 : 1 }}
          />
        ))}
      </div>
      <div className="flex justify-between font-mono text-[9px] text-ink-4 tracking-[0.04em]">
        <span>−24h</span>
        <span>−18h</span>
        <span>−12h</span>
        <span>−6h</span>
        <span>ahora</span>
      </div>
    </div>
  );
}
