import type { MarketCandleDto } from "@cryptoanal/contracts";

type CandlestickChartProps = {
  candles: MarketCandleDto[];
  symbol: string;
};

const width = 900;
const height = 280;
const plot = { top: 18, right: 76, bottom: 32, left: 16 };

export function CandlestickChart({ candles, symbol }: CandlestickChartProps) {
  const visibleCandles = candles.slice(-72);
  if (visibleCandles.length < 2) {
    return (
      <div className="grid h-[280px] place-items-center text-sm text-muted-foreground">
        Недостаточно свечей для построения графика.
      </div>
    );
  }

  const lows = visibleCandles.map(({ low }) => Number(low));
  const highs = visibleCandles.map(({ high }) => Number(high));
  const rawMinimum = Math.min(...lows);
  const rawMaximum = Math.max(...highs);
  const range = rawMaximum - rawMinimum || rawMaximum * 0.01 || 1;
  const minimum = rawMinimum - range * 0.06;
  const maximum = rawMaximum + range * 0.06;
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const slot = plotWidth / visibleCandles.length;
  const bodyWidth = Math.max(2, Math.min(8, slot * 0.58));
  const toY = (value: number) => plot.top + ((maximum - value) / (maximum - minimum)) * plotHeight;
  const gridValues = Array.from({ length: 5 }, (_, index) => maximum - (range * index) / 4);
  const labelIndexes = [0, Math.floor((visibleCandles.length - 1) / 2), visibleCandles.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="block h-[280px] w-full"
      role="img"
      aria-labelledby="market-chart-title market-chart-description"
    >
      <title id="market-chart-title">Свечной график {symbol}</title>
      <desc id="market-chart-description">
        Последние {visibleCandles.length} пятнадцатиминутных свечей.
      </desc>

      {gridValues.map((value) => {
        const y = toY(value);
        return (
          <g key={value}>
            <line
              x1={plot.left}
              x2={width - plot.right}
              y1={y}
              y2={y}
              className="stroke-chart-grid"
              vectorEffect="non-scaling-stroke"
            />
            <text x={width - plot.right + 9} y={y + 4} className="fill-stale font-mono text-[10px]">
              {formatAxisPrice(value)}
            </text>
          </g>
        );
      })}

      {visibleCandles.map((candle, index) => {
        const open = Number(candle.open);
        const high = Number(candle.high);
        const low = Number(candle.low);
        const close = Number(candle.close);
        const x = plot.left + slot * index + slot / 2;
        const bodyTop = toY(Math.max(open, close));
        const bodyBottom = toY(Math.min(open, close));
        const positive = close >= open;

        return (
          <g key={candle.openTime} className={positive ? "text-profit" : "text-loss"}>
            <line
              x1={x}
              x2={x}
              y1={toY(high)}
              y2={toY(low)}
              stroke="currentColor"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <rect
              x={x - bodyWidth / 2}
              y={bodyTop}
              width={bodyWidth}
              height={Math.max(1.5, bodyBottom - bodyTop)}
              rx="0.7"
              fill="currentColor"
            />
          </g>
        );
      })}

      {labelIndexes.map((index) => {
        const candle = visibleCandles[index]!;
        const x = plot.left + slot * index + slot / 2;
        return (
          <text
            key={candle.openTime}
            x={x}
            y={height - 7}
            textAnchor={
              index === 0 ? "start" : index === visibleCandles.length - 1 ? "end" : "middle"
            }
            className="fill-stale font-mono text-[10px]"
          >
            {new Date(candle.openTime).toLocaleTimeString("ru-RU", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </text>
        );
      })}
    </svg>
  );
}

function formatAxisPrice(value: number): string {
  return value.toLocaleString("ru-RU", {
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 6 : 2,
  });
}
