import type { ReactNode } from "react";
import { Link } from "react-router-dom";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  cta?: { label: string; to: string } | null;
  className?: string;
}

export default function EmptyState({
  icon = "+",
  title,
  description,
  cta,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={`bg-paper-2 border border-dashed border-edge rounded-lg p-10 text-center ${className}`}
    >
      <div className="w-9 h-9 bg-paper-sunken rounded-full mx-auto mb-3.5 flex items-center justify-center font-display text-ink-3 text-xl">
        {icon}
      </div>
      <h3 className="font-display text-base font-medium tracking-tighter mb-1 m-0">
        {title}
      </h3>
      <p className="text-xs text-ink-3 mx-auto max-w-[320px] leading-relaxed mb-4">
        {description}
      </p>
      {cta && (
        <Link to={cta.to} className="btn-accent inline-flex">
          {cta.label}
        </Link>
      )}
    </div>
  );
}
