import type { ValidationMetricsDto } from "@cryptoanal/contracts";

type ValidationPerformanceChartProps = {
  points: ValidationMetricsDto["equitySeries"];
};

const width = 960;
const height = 270;
const padding = { top: 14, right: 70, bottom: 24, left: 8 };
const equityHeight = 158;
const drawdownTop = 196;
const drawdownHeight = 42;

export function ValidationPerformanceChart({ points }: ValidationPerformanceChartProps) {
  if (points.length < 2) {
    return (
      <div className="grid h-[270px] place-items-center text-sm text-muted-foreground">
        Для графика недостаточно точек капитала.
      </div>
    );
  }

  const values = points.map((point) => point.equity);
  const drawdowns = calculateDrawdowns(values);
  const rawMinimum = Math.min(...values);
  const rawMaximum = Math.max(...values);
  const rangePadding = Math.max((rawMaximum - rawMinimum) * 0.1, Math.abs(rawMaximum) * 0.002, 1);
  const minimum = rawMinimum - rangePadding;
  const maximum = rawMaximum + rangePadding;
  const maximumDrawdown = Math.max(...drawdowns, 1);
  const innerWidth = width - padding.left - padding.right;
  const x = (index: number) => padding.left + (index / (points.length - 1)) * innerWidth;
  const equityY = (value: number) =>
    padding.top + ((maximum - value) / (maximum - minimum)) * equityHeight;
  const drawdownY = (value: number) => drawdownTop + (value / maximumDrawdown) * drawdownHeight;
  const equityCoordinates = values.map((value, index) => [x(index), equityY(value)] as const);
  const drawdownCoordinates = drawdowns.map(
    (value, index) => [x(index), drawdownY(value)] as const,
  );
  const equityPath = linePath(equityCoordinates);
  const drawdownPath = `${linePath(drawdownCoordinates)} L ${x(points.length - 1).toFixed(2)} ${drawdownTop.toFixed(2)} L ${padding.left.toFixed(2)} ${drawdownTop.toFixed(2)} Z`;
  const equityGrid = Array.from(
    { length: 4 },
    (_, index) => maximum - ((maximum - minimum) * index) / 3,
  );

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-[270px] w-full overflow-visible"
      role="img"
      aria-label="Кривая капитала и просадка validation run"
    >
      <defs>
        <linearGradient id="validation-equity-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--chart-series-1)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--chart-series-1)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="validation-drawdown-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--loss)" stopOpacity="0.08" />
          <stop offset="100%" stopColor="var(--loss)" stopOpacity="0.35" />
        </linearGradient>
      </defs>

      {equityGrid.map((value) => {
        const y = equityY(value);
        return (
          <g key={value}>
            <line
              x1={padding.left}
              x2={padding.left + innerWidth}
              y1={y}
              y2={y}
              stroke="var(--chart-grid)"
            />
            <text
              x={padding.left + innerWidth + 10}
              y={y + 4}
              fill="var(--chart-axis)"
              fontFamily="var(--font-mono)"
              fontSize="10"
            >
              {formatAxisNumber(value)}
            </text>
          </g>
        );
      })}

      <path
        d={`${equityPath} L ${x(points.length - 1).toFixed(2)} ${(padding.top + equityHeight).toFixed(2)} L ${padding.left.toFixed(2)} ${(padding.top + equityHeight).toFixed(2)} Z`}
        fill="url(#validation-equity-area)"
      />
      <path
        d={equityPath}
        fill="none"
        stroke="var(--chart-series-1)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />

      <text x={padding.left} y={drawdownTop - 9} fill="var(--chart-axis)" fontSize="10">
        ПРОСАДКА
      </text>
      <line
        x1={padding.left}
        x2={padding.left + innerWidth}
        y1={drawdownTop}
        y2={drawdownTop}
        stroke="var(--chart-grid)"
      />
      <path d={drawdownPath} fill="url(#validation-drawdown-area)" />
      <path d={linePath(drawdownCoordinates)} fill="none" stroke="var(--loss)" strokeWidth="1.5" />
      <text
        x={padding.left + innerWidth + 10}
        y={drawdownTop + drawdownHeight}
        fill="var(--chart-axis)"
        fontFamily="var(--font-mono)"
        fontSize="10"
      >
        −{maximumDrawdown.toFixed(1)}%
      </text>

      <text x={padding.left} y={height - 2} fill="var(--chart-axis)" fontSize="10">
        {formatDate(points[0]!.observedAt)}
      </text>
      <text
        x={padding.left + innerWidth}
        y={height - 2}
        fill="var(--chart-axis)"
        fontSize="10"
        textAnchor="end"
      >
        {formatDate(points.at(-1)!.observedAt)}
      </text>
    </svg>
  );
}

function calculateDrawdowns(values: number[]): number[] {
  let peak = values[0] ?? 0;
  return values.map((value) => {
    peak = Math.max(peak, value);
    return peak > 0 ? ((peak - value) / peak) * 100 : 0;
  });
}

function linePath(coordinates: ReadonlyArray<readonly [number, number]>): string {
  return coordinates
    .map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(" ");
}

function formatAxisNumber(value: number): string {
  return new Intl.NumberFormat("ru-RU", {
    notation: Math.abs(value) >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}
