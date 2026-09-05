import type { AccountSnapshotPointDto, OverviewPeriod } from "@cryptoanal/contracts";

type AccountEquityChartProps = {
  points: AccountSnapshotPointDto[];
  period: OverviewPeriod;
};

const chartWidth = 900;
const chartHeight = 190;
const chartPadding = { top: 12, right: 68, bottom: 24, left: 8 };

export function AccountEquityChart({ points, period }: AccountEquityChartProps) {
  if (points.length === 0) {
    return (
      <div className="grid h-[190px] place-items-center text-sm text-muted-foreground">
        История капитала за выбранный период пока не накоплена.
      </div>
    );
  }

  const values = points.map((point) => Number(point.equity));
  const rawMinimum = Math.min(...values);
  const rawMaximum = Math.max(...values);
  const valuePadding = Math.max((rawMaximum - rawMinimum) * 0.12, rawMaximum * 0.0025, 1);
  const minimum = rawMinimum - valuePadding;
  const maximum = rawMaximum + valuePadding;
  const innerWidth = chartWidth - chartPadding.left - chartPadding.right;
  const innerHeight = chartHeight - chartPadding.top - chartPadding.bottom;
  const xForIndex = (index: number) =>
    chartPadding.left +
    (points.length === 1 ? innerWidth : (index / (points.length - 1)) * innerWidth);
  const yForValue = (value: number) =>
    chartPadding.top + ((maximum - value) / (maximum - minimum)) * innerHeight;
  const coordinates = values.map((value, index) => [xForIndex(index), yForValue(value)] as const);
  const linePath = coordinates
    .map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(" ");
  const firstCoordinate = coordinates[0]!;
  const lastCoordinate = coordinates.at(-1)!;
  const areaPath = `${linePath} L ${lastCoordinate[0].toFixed(2)} ${(chartPadding.top + innerHeight).toFixed(2)} L ${firstCoordinate[0].toFixed(2)} ${(chartPadding.top + innerHeight).toFixed(2)} Z`;
  const gridValues = Array.from(
    { length: 4 },
    (_, index) => maximum - ((maximum - minimum) * index) / 3,
  );

  return (
    <div>
      <svg
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        className="h-[190px] w-full overflow-visible"
        role="img"
        aria-label={`Изменение капитала за ${periodLabels[period]}`}
      >
        <defs>
          <linearGradient id="equity-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-series-1)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--chart-series-1)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridValues.map((value) => {
          const y = yForValue(value);
          return (
            <g key={value}>
              <line
                x1={chartPadding.left}
                x2={chartPadding.left + innerWidth}
                y1={y}
                y2={y}
                stroke="var(--chart-grid)"
                strokeWidth="1"
              />
              <text
                x={chartPadding.left + innerWidth + 10}
                y={y + 4}
                fill="var(--chart-axis)"
                fontFamily="var(--font-mono)"
                fontSize="10"
              >
                {formatAxisMoney(value)}
              </text>
            </g>
          );
        })}

        <path d={areaPath} fill="url(#equity-area)" />
        <path
          d={linePath}
          fill="none"
          stroke="var(--chart-series-1)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
        <circle cx={lastCoordinate[0]} cy={lastCoordinate[1]} r="3" fill="var(--chart-series-1)" />

        <text
          x={chartPadding.left}
          y={chartHeight - 3}
          fill="var(--chart-axis)"
          fontFamily="var(--font-sans)"
          fontSize="10"
        >
          {formatAxisDate(points[0]!.observedAt, period)}
        </text>
        <text
          x={chartPadding.left + innerWidth}
          y={chartHeight - 3}
          fill="var(--chart-axis)"
          fontFamily="var(--font-sans)"
          fontSize="10"
          textAnchor="end"
        >
          {formatAxisDate(points.at(-1)!.observedAt, period)}
        </text>
      </svg>
    </div>
  );
}

const periodLabels: Record<OverviewPeriod, string> = {
  "24h": "24 часа",
  "7d": "7 дней",
  "30d": "30 дней",
};

function formatAxisMoney(value: number): string {
  return new Intl.NumberFormat("ru-RU", {
    notation: Math.abs(value) >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatAxisDate(value: string, period: OverviewPeriod): string {
  return new Date(value).toLocaleString("ru-RU", {
    ...(period === "24h"
      ? { hour: "2-digit", minute: "2-digit" }
      : { day: "2-digit", month: "short" }),
  });
}
