import type { AnalyticsDto } from "@cryptoanal/contracts";

type DrawdownChartProps = {
  points: AnalyticsDto["equitySeries"];
};

export function DrawdownChart({ points }: DrawdownChartProps) {
  if (points.length === 0) {
    return (
      <div className="grid h-36 place-items-center text-sm text-muted-foreground">Нет данных.</div>
    );
  }

  const width = 520;
  const height = 144;
  const bottom = 132;
  const maxDrawdown = Math.max(...points.map((point) => point.drawdownPercent), 0.01);
  const x = (index: number) =>
    points.length === 1 ? width : (index / (points.length - 1)) * width;
  const y = (value: number) => 8 + (value / maxDrawdown) * (bottom - 8);
  const line = points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"} ${x(index).toFixed(2)} ${y(point.drawdownPercent).toFixed(2)}`,
    )
    .join(" ");
  const area = `${line} L ${width} 8 L 0 8 Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-36 w-full"
      role="img"
      aria-label="Просадка капитала"
    >
      <line x1="0" x2={width} y1="8" y2="8" stroke="var(--chart-grid)" />
      <line x1="0" x2={width} y1={bottom} y2={bottom} stroke="var(--chart-grid)" />
      <path d={area} fill="var(--loss)" fillOpacity="0.08" />
      <path
        d={line}
        fill="none"
        stroke="var(--loss)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
      <text x={width} y={height - 1} fill="var(--chart-axis)" fontSize="10" textAnchor="end">
        −{maxDrawdown.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%
      </text>
    </svg>
  );
}
