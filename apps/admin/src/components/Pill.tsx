import type { RunStatus } from "../types";

export default function Pill({ status }: { status: RunStatus }) {
  const map: Record<RunStatus, { cls: string; label: string }> = {
    ok:      { cls: "pill-ok",   label: "OK" },
    fail:    { cls: "pill-fail", label: "FAIL" },
    warn:    { cls: "pill-warn", label: "WARN" },
    running: { cls: "pill-off",  label: "RUNNING" },
  };
  const { cls, label } = map[status];
  return <span className={`pill ${cls}`}>{label}</span>;
}
