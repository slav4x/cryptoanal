import type { MarketCandleDto, PositionDto, TradeDto } from "@cryptoanal/contracts";
import { Button, cn } from "@cryptoanal/ui";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatMoney, formatPrice } from "../../shared/format";

type CandlestickChartProps = {
  candles: MarketCandleDto[];
  symbol: string;
  positions: PositionDto[];
  trades: TradeDto[];
};

type ChartEvent = {
  id: string;
  time: UTCTimestamp;
  kind: "entry" | "exit" | "open";
  side: "buy" | "sell";
  strategy: string;
  price: string;
  stopPrice: string;
  takePrice: string;
  pnl: string | null;
};

type InspectorState = {
  candle: CandlestickData<UTCTimestamp>;
  events: ChartEvent[];
};

const colors = {
  background: "#141517",
  border: "#232529",
  grid: "#1b1d22",
  text: "#686d76",
  crosshair: "#888d97",
  profit: "#39d98a",
  loss: "#ff6577",
  warning: "#f5b94c",
  entry: "#6f8cff",
} as const;

const timeFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function CandlestickChart({ candles, symbol, positions, trades }: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const fittedSymbolRef = useRef<string | null>(null);
  const eventMapRef = useRef<Map<UTCTimestamp, ChartEvent[]>>(new Map());
  const [showPositions, setShowPositions] = useState(true);
  const [showTrades, setShowTrades] = useState(true);
  const [inspector, setInspector] = useState<InspectorState | null>(null);

  const chartData = useMemo<CandlestickData<UTCTimestamp>[]>(
    () =>
      candles.map((candle) => ({
        time: toTimestamp(candle.openTime),
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
      })),
    [candles],
  );
  const overlays = useMemo(
    () => buildOverlays(candles, positions, trades, showPositions, showTrades),
    [candles, positions, showPositions, showTrades, trades],
  );

  useEffect(() => {
    eventMapRef.current = overlays.events;
  }, [overlays.events]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

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
        scaleMargins: { top: 0.1, bottom: 0.12 },
      },
      timeScale: {
        borderColor: colors.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        barSpacing: 9,
        minBarSpacing: 3,
      },
      localization: {
        locale: "ru-RU",
        priceFormatter: (price: number) => formatAxisPrice(price),
        timeFormatter: (time: Time) => formatChartTime(time),
      },
      handleScroll: true,
      handleScale: true,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: colors.profit,
      downColor: colors.loss,
      borderUpColor: colors.profit,
      borderDownColor: colors.loss,
      wickUpColor: colors.profit,
      wickDownColor: colors.loss,
      priceLineVisible: true,
      lastValueVisible: true,
    });
    const markers = createSeriesMarkers(series, [], { autoScale: true, zOrder: "top" });

    chart.subscribeCrosshairMove((parameter) => {
      if (parameter.time === undefined) {
        setInspector(null);
        return;
      }
      const datum = parameter.seriesData.get(series);
      if (!datum || !("open" in datum) || typeof parameter.time !== "number") {
        setInspector(null);
        return;
      }
      const time = parameter.time as UTCTimestamp;
      setInspector({
        candle: datum as CandlestickData<UTCTimestamp>,
        events: eventMapRef.current.get(time) ?? [],
      });
    });

    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = markers;
    return () => {
      priceLinesRef.current = [];
      markersRef.current = null;
      seriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || chartData.length === 0) return;
    series.applyOptions({ priceFormat: priceFormatFor(chartData.at(-1)!.close) });
    series.setData(chartData);
    if (fittedSymbolRef.current !== symbol) {
      fittedSymbolRef.current = symbol;
      showLatestRange(chart, chartData.length);
    }
  }, [chartData, symbol]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    markersRef.current?.setMarkers(overlays.markers);
    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = overlays.priceLines.map((line) => series.createPriceLine(line));
  }, [overlays.markers, overlays.priceLines]);

  if (chartData.length < 2) {
    return (
      <div className="grid h-[460px] place-items-center text-sm text-muted-foreground">
        Недостаточно свечей для построения графика.
      </div>
    );
  }

  const inspectedCandle = inspector?.candle ?? chartData.at(-1)!;
  const inspectedEvents = inspector?.events ?? [];

  return (
    <div>
      <div className="flex min-h-[58px] flex-wrap items-center justify-between gap-3 border-b border-row-border px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          <span className="font-mono text-muted-foreground">
            {formatChartTime(inspectedCandle.time)}
          </span>
          <OhlcValue label="O" value={inspectedCandle.open} />
          <OhlcValue label="H" value={inspectedCandle.high} />
          <OhlcValue label="L" value={inspectedCandle.low} />
          <OhlcValue label="C" value={inspectedCandle.close} />
          {inspectedEvents.map((event) => (
            <EventSummary key={event.id} event={event} />
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <LayerButton active={showPositions} onClick={() => setShowPositions((value) => !value)}>
            Позиции {positions.length}
          </LayerButton>
          <LayerButton active={showTrades} onClick={() => setShowTrades((value) => !value)}>
            Сделки {trades.length}
          </LayerButton>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[11px] text-muted-foreground"
            onClick={() => chartRef.current && showLatestRange(chartRef.current, chartData.length)}
          >
            К последним
          </Button>
        </div>
      </div>
      <div
        ref={containerRef}
        className="h-[460px] w-full"
        role="img"
        aria-label={`Интерактивный свечной график ${symbol}`}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-row-border px-4 py-2 text-[10px] text-stale">
        <LegendDot color="bg-profit" label="Long / прибыль" />
        <LegendDot color="bg-loss" label="Short / убыток" />
        <LegendDot color="bg-info" label="Цена входа" />
        <LegendDot color="bg-loss" label="Stop Loss" />
        <LegendDot color="bg-profit" label="Take Profit" />
        <LegendDot color="bg-warning" label="Trailing stop" />
        <span className="ml-auto">Колесо — масштаб · перетаскивание — история</span>
      </div>
    </div>
  );
}

function buildOverlays(
  candles: MarketCandleDto[],
  positions: PositionDto[],
  trades: TradeDto[],
  showPositions: boolean,
  showTrades: boolean,
) {
  const availableTimes = new Set(candles.map((candle) => toTimestamp(candle.openTime)));
  const markers: SeriesMarker<Time>[] = [];
  const events = new Map<UTCTimestamp, ChartEvent[]>();
  const addEvent = (event: ChartEvent, marker: SeriesMarker<Time>) => {
    events.set(event.time, [...(events.get(event.time) ?? []), event]);
    markers.push(marker);
  };

  if (showTrades) {
    for (const trade of trades) {
      const entryTime = snapToCandle(trade.openedAt, availableTimes);
      const exitTime = snapToCandle(trade.closedAt, availableTimes);
      if (entryTime !== null) {
        addEvent(
          {
            id: `${trade.id}:entry`,
            time: entryTime,
            kind: "entry",
            side: trade.side,
            strategy: `${trade.strategy.name} · v${trade.strategy.version}`,
            price: trade.averageEntryPrice,
            stopPrice: trade.stopPrice,
            takePrice: trade.takePrice,
            pnl: null,
          },
          entryMarker(trade.id, entryTime, trade.side, false),
        );
      }
      if (exitTime !== null) {
        addEvent(
          {
            id: `${trade.id}:exit`,
            time: exitTime,
            kind: "exit",
            side: trade.side,
            strategy: `${trade.strategy.name} · v${trade.strategy.version}`,
            price: trade.averageExitPrice,
            stopPrice: trade.stopPrice,
            takePrice: trade.takePrice,
            pnl: trade.netPnl,
          },
          {
            id: `${trade.id}:exit`,
            time: exitTime,
            position: "atPriceMiddle",
            price: Number(trade.averageExitPrice),
            color: Number(trade.netPnl) >= 0 ? colors.profit : colors.loss,
            shape: "circle",
            text: `Выход ${formatSignedMoney(trade.netPnl)}`,
            size: 1.1,
          },
        );
      }
    }
  }

  const priceLines: Array<Parameters<ISeriesApi<"Candlestick">["createPriceLine"]>[0]> = [];
  if (showPositions) {
    for (const position of positions) {
      const entryTime = snapToCandle(position.openedAt, availableTimes);
      if (entryTime !== null) {
        addEvent(
          {
            id: `${position.id}:open`,
            time: entryTime,
            kind: "open",
            side: position.side,
            strategy: `${position.strategy.name} · v${position.strategy.version}`,
            price: position.entryPrice,
            stopPrice: position.stopPrice,
            takePrice: position.takePrice,
            pnl: position.unrealizedPnl,
          },
          entryMarker(position.id, entryTime, position.side, true),
        );
      }
      const shortName = shortenStrategyName(position.strategy.name);
      priceLines.push(
        {
          id: `${position.id}:entry`,
          price: Number(position.entryPrice),
          color: colors.entry,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${shortName} · вход`,
        },
        {
          id: `${position.id}:stop`,
          price: Number(position.stopPrice),
          color: colors.loss,
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `${shortName} · SL`,
        },
        {
          id: `${position.id}:take`,
          price: Number(position.takePrice),
          color: colors.profit,
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `${shortName} · TP`,
        },
      );
      if (position.trailingPrice !== null) {
        priceLines.push({
          id: `${position.id}:trailing`,
          price: Number(position.trailingPrice),
          color: colors.warning,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${shortName} · trailing`,
        });
      }
    }
  }

  markers.sort((left, right) => Number(left.time) - Number(right.time));
  return { markers, events, priceLines };
}

function entryMarker(
  id: string,
  time: UTCTimestamp,
  side: "buy" | "sell",
  open: boolean,
): SeriesMarker<Time> {
  const long = side === "buy";
  return {
    id: `${id}:entry-marker`,
    time,
    position: long ? "belowBar" : "aboveBar",
    color: long ? colors.profit : colors.loss,
    shape: long ? "arrowUp" : "arrowDown",
    text: `${long ? "Long" : "Short"} ${open ? "открыта" : "вход"}`,
    size: 1.1,
  };
}

function EventSummary({ event }: { event: ChartEvent }) {
  const label = event.kind === "exit" ? "Выход" : event.kind === "open" ? "Открыта" : "Вход";
  return (
    <span className="max-w-[360px] rounded-[6px] border border-input bg-secondary/70 px-2 py-1 text-secondary-foreground">
      <span className={event.side === "buy" ? "text-profit" : "text-loss"}>{label}</span>
      {` ${event.strategy} · ${formatPrice(event.price)} · SL ${formatPrice(event.stopPrice)} · TP ${formatPrice(event.takePrice)}`}
      {event.pnl !== null ? ` · PnL ${formatMoney(event.pnl)}` : ""}
    </span>
  );
}

function OhlcValue({ label, value }: { label: string; value: number }) {
  return (
    <span className="font-mono tabular-nums text-secondary-foreground">
      <span className="mr-1 text-stale">{label}</span>
      {formatAxisPrice(value)}
    </span>
  );
}

function LayerButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-7 rounded-full px-2.5 text-[11px] text-muted-foreground",
        active && "bg-avatar text-foreground",
      )}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-1.5 rounded-full", color)} />
      {label}
    </span>
  );
}

function showLatestRange(chart: IChartApi, candleCount: number) {
  chart.timeScale().setVisibleLogicalRange({
    from: Math.max(0, candleCount - 96),
    to: candleCount - 1 + 4,
  });
}

function snapToCandle(value: string, availableTimes: Set<UTCTimestamp>): UTCTimestamp | null {
  const timestamp = toTimestamp(value);
  const intervalSeconds = 15 * 60;
  const candleTime = Math.floor(Number(timestamp) / intervalSeconds) * intervalSeconds;
  const snapped = candleTime as UTCTimestamp;
  return availableTimes.has(snapped) ? snapped : null;
}

function toTimestamp(value: string): UTCTimestamp {
  return Math.floor(new Date(value).getTime() / 1_000) as UTCTimestamp;
}

function formatChartTime(time: unknown): string {
  return typeof time === "number" ? timeFormatter.format(new Date(time * 1_000)) : String(time);
}

function formatAxisPrice(value: number): string {
  return value.toLocaleString("ru-RU", {
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 8 : 2,
  });
}

function formatSignedMoney(value: string): string {
  const numericValue = Number(value);
  return `${numericValue >= 0 ? "+" : ""}${numericValue.toLocaleString("ru-RU", {
    maximumFractionDigits: 2,
  })}`;
}

function priceFormatFor(price: number) {
  if (price < 1) return { type: "price" as const, precision: 6, minMove: 0.000001 };
  if (price < 100) return { type: "price" as const, precision: 4, minMove: 0.0001 };
  return { type: "price" as const, precision: 2, minMove: 0.01 };
}

function shortenStrategyName(value: string): string {
  return value.length > 18 ? `${value.slice(0, 16)}…` : value;
}
