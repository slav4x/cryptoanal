import type { AnalyticsDto } from "@cryptoanal/contracts";

type PerformanceChartProps = {
  points: AnalyticsDto["equitySeries"];
};

const width = 980;
const height = 280;
const padding = { top: 16, right: 72, bottom: 26, left: 8 };

export function PerformanceChart({ points }: PerformanceChartProps) {
  if (points.length === 0) {
    return (
      <div className="grid h-[280px] place-items-center text-sm text-muted-foreground">
        Сделок для построения кривой пока нет.
      </div>
    );
  }

  const equities = points.map((point) => Number(point.equity));
  const minimum = Math.min(...equities);
  const maximum = Math.max(...equities);
  const spread = Math.max(maximum - minimum, maximum * 0.005, 1);
  const chartMinimum = minimum - spread * 0.12;
  const chartMaximum = maximum + spread * 0.12;
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const x = (index: number) =>
    padding.left + (points.length === 1 ? innerWidth : (index / (points.length - 1)) * innerWidth);
  const y = (value: number) =>
    padding.top + ((chartMaximum - value) / (chartMaximum - chartMinimum)) * innerHeight;
  const coordinates = equities.map((value, index) => [x(index), y(value)] as const);
  const line = coordinates
    .map(
      ([pointX, pointY], index) =>
        `${index === 0 ? "M" : "L"} ${pointX.toFixed(2)} ${pointY.toFixed(2)}`,
    )
    .join(" ");
  const first = coordinates[0]!;
  const last = coordinates.at(-1)!;
  const floor = padding.top + innerHeight;
  const area = `${line} L ${last[0].toFixed(2)} ${floor.toFixed(2)} L ${first[0].toFixed(2)} ${floor.toFixed(2)} Z`;
  const gridValues = Array.from(
    { length: 4 },
    (_, index) => chartMaximum - ((chartMaximum - chartMinimum) * index) / 3,
  );

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-[280px] w-full overflow-visible"
      role="img"
      aria-label="Кривая капитала по закрытым сделкам"
    >
      <defs>
        <linearGradient id="analytics-equity-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--chart-series-1)" stopOpacity="0.2" />
          <stop offset="100%" stopColor="var(--chart-series-1)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {gridValues.map((value) => {
        const pointY = y(value);
        return (
          <g key={value}>
            <line
              x1={padding.left}
              x2={padding.left + innerWidth}
              y1={pointY}
              y2={pointY}
              stroke="var(--chart-grid)"
            />
            <text
              x={padding.left + innerWidth + 10}
              y={pointY + 4}
              fill="var(--chart-axis)"
              fontFamily="var(--font-mono)"
              fontSize="10"
            >
              {formatAxisMoney(value)}
            </text>
          </g>
        );
      })}

      <path d={area} fill="url(#analytics-equity-area)" />
      <path
        d={line}
        fill="none"
        stroke="var(--chart-series-1)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <circle cx={last[0]} cy={last[1]} r="3" fill="var(--chart-series-1)" />

      <text x={padding.left} y={height - 3} fill="var(--chart-axis)" fontSize="10">
        {formatDate(points[0]!.observedAt)}
      </text>
      <text
        x={padding.left + innerWidth}
        y={height - 3}
        fill="var(--chart-axis)"
        fontSize="10"
        textAnchor="end"
      >
        {formatDate(points.at(-1)!.observedAt)}
      </text>
    </svg>
  );
}

function formatAxisMoney(value: number): string {
  return new Intl.NumberFormat("ru-RU", {
    notation: Math.abs(value) >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}
