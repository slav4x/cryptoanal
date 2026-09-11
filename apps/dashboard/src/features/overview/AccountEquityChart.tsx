import type { AccountSnapshotPointDto, OverviewPeriod } from "@cryptoanal/contracts";
import { Button, cn } from "@cryptoanal/ui";
import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type AreaData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatMetricMoney, formatPercent } from "../../shared/format";

type AccountEquityChartProps = {
  points: AccountSnapshotPointDto[];
  period: OverviewPeriod;
};

type EquityPoint = AreaData<UTCTimestamp> & {
  source: AccountSnapshotPointDto;
};

const colors = {
  background: "#141517",
  border: "#232529",
  grid: "#1b1d22",
  text: "#686d76",
  crosshair: "#888d97",
  profit: "#39d98a",
  loss: "#ff6577",
} as const;

const dateTimeFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function AccountEquityChart({ points, period }: AccountEquityChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const fittedPeriodRef = useRef<OverviewPeriod | null>(null);
  const pointMapRef = useRef<Map<UTCTimestamp, AccountSnapshotPointDto>>(new Map());
  const [inspectedPoint, setInspectedPoint] = useState<AccountSnapshotPointDto | null>(null);

  const chartData = useMemo<EquityPoint[]>(() => normalizePoints(points), [points]);
  const hasData = chartData.length > 0;
  const firstEquity = chartData[0]?.value ?? 0;
  const latestPoint = chartData.at(-1)?.source ?? null;
  const displayedPoint =
    inspectedPoint &&
    chartData.some((point) => point.source.observedAt === inspectedPoint.observedAt)
      ? inspectedPoint
      : latestPoint;
  const displayedEquity = displayedPoint ? Number(displayedPoint.equity) : null;
  const displayedDelta = displayedEquity === null ? null : displayedEquity - firstEquity;
  const displayedPercent =
    firstEquity === 0 || displayedDelta === null ? null : (displayedDelta / firstEquity) * 100;
  const positivePeriod = chartData.length < 2 || chartData.at(-1)!.value >= chartData[0]!.value;

  useEffect(() => {
    pointMapRef.current = new Map(chartData.map((point) => [point.time, point.source] as const));
  }, [chartData]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !hasData) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor: colors.text,
        fontFamily: '"SFMono-Regular", "SF Mono", ui-monospace, Menlo, Consolas, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colors.crosshair, labelBackgroundColor: "#262931" },
        horzLine: { color: colors.crosshair, labelBackgroundColor: "#262931" },
      },
      rightPriceScale: {
        borderColor: colors.border,
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderColor: colors.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        minBarSpacing: 2,
      },
      localization: {
        locale: "ru-RU",
        priceFormatter: formatAxisMoney,
      },
      handleScroll: true,
      handleScale: true,
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: colors.profit,
      topColor: "rgba(57, 217, 138, 0.22)",
      bottomColor: "rgba(57, 217, 138, 0)",
      lineWidth: 2,
      priceLineVisible: true,
      lastValueVisible: true,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });

    chart.subscribeCrosshairMove((parameter) => {
      if (typeof parameter.time !== "number") {
        setInspectedPoint(null);
        return;
      }
      setInspectedPoint(pointMapRef.current.get(parameter.time as UTCTimestamp) ?? null);
    });

    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      fittedPeriodRef.current = null;
      seriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, [hasData]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || chartData.length === 0) return;

    const lineColor = positivePeriod ? colors.profit : colors.loss;
    series.applyOptions({
      lineColor,
      topColor: positivePeriod ? "rgba(57, 217, 138, 0.22)" : "rgba(255, 101, 119, 0.2)",
      bottomColor: positivePeriod ? "rgba(57, 217, 138, 0)" : "rgba(255, 101, 119, 0)",
    });
    series.setData(chartData.map(({ time, value }) => ({ time, value })));
    if (fittedPeriodRef.current !== period) {
      fittedPeriodRef.current = period;
      setPeriodViewport(chart, period);
    }
  }, [chartData, period, positivePeriod]);

  if (chartData.length === 0) {
    return (
      <div className="grid h-[320px] place-items-center text-sm text-muted-foreground">
        История капитала за выбранный период пока не накоплена.
      </div>
    );
  }

  return (
    <div>
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-row-border px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          <span className="font-mono text-muted-foreground">
            {displayedPoint ? dateTimeFormatter.format(new Date(displayedPoint.observedAt)) : "—"}
          </span>
          <span className="font-mono tabular-nums text-secondary-foreground">
            {formatMetricMoney(displayedPoint?.equity ?? null)}
          </span>
          {displayedDelta !== null ? (
            <span
              className={cn(
                "font-mono tabular-nums",
                displayedDelta >= 0 ? "text-profit" : "text-loss",
              )}
            >
              {formatSignedMoney(displayedDelta)}
              {displayedPercent === null ? "" : ` · ${formatPercent(String(displayedPercent))}`}
            </span>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2.5 text-[11px] text-muted-foreground"
          onClick={() => {
            const chart = chartRef.current;
            if (chart) setPeriodViewport(chart, period);
          }}
        >
          Период
        </Button>
      </div>
      <div
        ref={containerRef}
        className="h-[320px] w-full"
        role="img"
        aria-label={`Интерактивный график капитала за ${periodLabels[period]}`}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-row-border px-4 py-2 text-[10px] text-stale">
        <span>Период: {periodLabels[period]}</span>
        <span className="ml-auto">Колесо — масштаб · перетаскивание — история</span>
      </div>
    </div>
  );
}

function normalizePoints(points: AccountSnapshotPointDto[]): EquityPoint[] {
  const byTimestamp = new Map<number, AccountSnapshotPointDto>();
  for (const point of points) {
    const timestamp = Math.floor(new Date(point.observedAt).getTime() / 1_000);
    if (Number.isFinite(timestamp)) byTimestamp.set(timestamp, point);
  }

  return [...byTimestamp.entries()]
    .sort(([left], [right]) => left - right)
    .map(([timestamp, source]) => ({
      time: timestamp as UTCTimestamp,
      value: Number(source.equity),
      source,
    }))
    .filter((point) => Number.isFinite(point.value));
}

const periodLabels: Record<OverviewPeriod, string> = {
  "24h": "24 часа",
  "7d": "7 дней",
  "30d": "30 дней",
};

function formatAxisMoney(value: number): string {
  return value.toLocaleString("ru-RU", {
    notation: Math.abs(value) >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: 2,
  });
}

function formatSignedMoney(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USDT`;
}

function setPeriodViewport(chart: IChartApi, period: OverviewPeriod) {
  const to = Math.floor(Date.now() / 1_000) as UTCTimestamp;
  chart.timeScale().setVisibleRange({
    from: (to - periodDurationSeconds[period]) as UTCTimestamp,
    to,
  });
}

const periodDurationSeconds: Record<OverviewPeriod, number> = {
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};
