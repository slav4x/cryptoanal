import type { AnalyticsDto, AnalyticsPeriod } from "@cryptoanal/contracts";
import { Button } from "@cryptoanal/ui";
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

type DrawdownChartProps = {
  points: AnalyticsDto["equitySeries"];
  period: AnalyticsPeriod;
};

type AnalyticsEquityPoint = AnalyticsDto["equitySeries"][number];
type DrawdownChartPoint = AreaData<UTCTimestamp> & { source: AnalyticsEquityPoint };

const colors = {
  background: "#141517",
  border: "#232529",
  grid: "#1b1d22",
  text: "#686d76",
  crosshair: "#888d97",
  loss: "#ff6577",
} as const;

const dateTimeFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function DrawdownChart({ points, period }: DrawdownChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const fittedPeriodRef = useRef<AnalyticsPeriod | null>(null);
  const pointMapRef = useRef<Map<UTCTimestamp, AnalyticsEquityPoint>>(new Map());
  const [inspectedPoint, setInspectedPoint] = useState<AnalyticsEquityPoint | null>(null);
  const chartData = useMemo(() => normalizePoints(points), [points]);
  const hasData = chartData.length > 0;
  const latestPoint = chartData.at(-1)?.source ?? null;
  const displayedPoint = isPointInSeries(inspectedPoint, chartData) ? inspectedPoint : latestPoint;
  const maximumDrawdown = Math.max(...chartData.map((point) => point.source.drawdownPercent), 0);

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
        minBarSpacing: 3,
      },
      localization: { locale: "ru-RU", priceFormatter: formatDrawdownAxis },
      handleScroll: true,
      handleScale: true,
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: colors.loss,
      topColor: "rgba(255, 101, 119, 0.02)",
      bottomColor: "rgba(255, 101, 119, 0.24)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      baseLineVisible: true,
      baseLineColor: colors.border,
      priceFormat: { type: "custom", formatter: formatDrawdownAxis, minMove: 0.01 },
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
    series.setData(chartData.map(({ time, value }) => ({ time, value })));
    if (fittedPeriodRef.current !== period) {
      fittedPeriodRef.current = period;
      setPeriodViewport(chart, period);
    }
  }, [chartData, period]);

  if (!hasData) {
    return (
      <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">
        Нет данных.
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
          <span className="font-mono tabular-nums text-loss">
            Просадка −{formatPercent(displayedPoint?.drawdownPercent ?? 0)}
          </span>
          <span className="font-mono tabular-nums text-stale">
            Максимум −{formatPercent(maximumDrawdown)}
          </span>
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
        className="h-[260px] w-full"
        role="img"
        aria-label="Интерактивный график просадки капитала"
      />
      <div className="flex items-center border-t border-row-border px-4 py-2 text-[10px] text-stale">
        <span className="ml-auto">Колесо — масштаб · перетаскивание — история</span>
      </div>
    </div>
  );
}

function normalizePoints(points: AnalyticsDto["equitySeries"]): DrawdownChartPoint[] {
  const byTimestamp = new Map<number, AnalyticsEquityPoint>();
  for (const point of points) {
    const timestamp = Math.floor(new Date(point.observedAt).getTime() / 1_000);
    if (Number.isFinite(timestamp) && Number.isFinite(point.drawdownPercent)) {
      byTimestamp.set(timestamp, point);
    }
  }
  return [...byTimestamp.entries()]
    .sort(([left], [right]) => left - right)
    .map(([timestamp, source]) => ({
      time: timestamp as UTCTimestamp,
      value: -source.drawdownPercent,
      source,
    }));
}

function isPointInSeries(
  point: AnalyticsEquityPoint | null,
  series: DrawdownChartPoint[],
): point is AnalyticsEquityPoint {
  return Boolean(
    point && series.some((candidate) => candidate.source.observedAt === point.observedAt),
  );
}

function formatDrawdownAxis(value: number): string {
  return `${value.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%`;
}

function formatPercent(value: number): string {
  return `${value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function setPeriodViewport(chart: IChartApi, period: AnalyticsPeriod) {
  if (period === "all") {
    chart.timeScale().fitContent();
    return;
  }

  const to = Math.floor(Date.now() / 1_000) as UTCTimestamp;
  chart.timeScale().setVisibleRange({
    from: (to - periodDurationSeconds[period]) as UTCTimestamp,
    to,
  });
}

const periodDurationSeconds: Record<Exclude<AnalyticsPeriod, "all">, number> = {
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
  "90d": 90 * 24 * 60 * 60,
};
