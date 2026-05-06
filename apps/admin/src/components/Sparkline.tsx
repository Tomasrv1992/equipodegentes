import type { SparkPoint } from "../lib/timeline";
import { sparkPolylinePoints } from "../lib/timeline";

interface SparklineProps {
  points: SparkPoint[];
  color?: string;       // OKLCH color for stroke
  fillOpacity?: number;
  className?: string;
}

export default function Sparkline({
  points,
  color = "oklch(0.58 0.13 145)",
  fillOpacity = 0.08,
  className = "",
}: SparklineProps) {
  if (points.length === 0) return null;
  const polyline = sparkPolylinePoints(points);
  // Closed path for fill (start → points → bottom right → bottom left)
  const closedPolyline = `${polyline} 100,32 0,32`;

  return (
    <svg
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      className={`w-full h-8 ${className}`}
    >
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={polyline}
      />
      <polyline
        fill={color}
        fillOpacity={fillOpacity}
        stroke="none"
        points={closedPolyline}
      />
    </svg>
  );
}
