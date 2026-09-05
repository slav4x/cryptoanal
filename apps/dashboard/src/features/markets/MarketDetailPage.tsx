import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorState,
  MetricCard,
  Skeleton,
} from "@cryptoanal/ui";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Database, Star } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiClientError, fetchMarketDetail, fetchTradingLedger } from "../../shared/api";
import { formatPercent, formatPrice } from "../../shared/format";
import { CandlestickChart } from "./CandlestickChart";
import { PairTradingContext } from "./PairTradingContext";
import { useWatchlistMutation } from "./useWatchlistMutation";

export default function MarketDetailPage() {
  const { symbol = "" } = useParams();
  const normalizedSymbol = symbol.toUpperCase();
  const watchlistMutation = useWatchlistMutation();
  const marketQuery = useQuery({
    queryKey: ["market", normalizedSymbol],
    queryFn: () => fetchMarketDetail(normalizedSymbol),
    enabled: normalizedSymbol.length > 0,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const ledgerQuery = useQuery({
    queryKey: ["trading-ledger"],
    queryFn: fetchTradingLedger,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  if (marketQuery.isPending) return <MarketDetailSkeleton />;

  if (marketQuery.isError) {
    return (
      <div className="space-y-[18px]">
        <BackToMarkets />
        <ErrorState
          title="Не удалось загрузить торговую пару"
          description={marketQuery.error.message}
          requestId={
            marketQuery.error instanceof ApiClientError ? marketQuery.error.requestId : undefined
          }
          onRetry={() => void marketQuery.refetch()}
        />
      </div>
    );
  }

  const { data, meta } = marketQuery.data;
  const marketChange = Number(data.market.change24hPercent ?? 0);
  const periodChange = Number(data.analysis.periodChangePercent ?? 0);
  const regime = regimeContent[data.analysis.regime];

  return (
    <div className="space-y-[18px]">
      <div>
        <BackToMarkets />
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-2xl font-medium tracking-tight">{data.market.symbol}</h1>
            <span className="font-mono text-lg text-secondary-foreground">
              {formatPrice(data.market.price)} {data.market.quoteAsset}
            </span>
            <Badge variant={marketChange >= 0 ? "profit" : "loss"}>
              {formatPercent(data.market.change24hPercent)} за 24ч
            </Badge>
            <Badge variant={regime.variant}>{regime.label}</Badge>
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={data.market.watchlisted}
              disabled={watchlistMutation.isPending}
              onClick={() =>
                watchlistMutation.mutate({
                  symbol: data.market.symbol,
                  watchlisted: !data.market.watchlisted,
                })
              }
            >
              <Star
                className={data.market.watchlisted ? "fill-warning text-warning" : ""}
                aria-hidden="true"
              />
              {data.market.watchlisted ? "В watchlist" : "Добавить"}
            </Button>
            <span className="flex items-center gap-2 text-xs text-stale">
              <Database className="size-3.5" aria-hidden="true" />
              обновлено {new Date(meta.generatedAt).toLocaleTimeString("ru-RU")}
            </span>
          </div>
        </div>
      </div>

      {watchlistMutation.isError ? (
        <p className="rounded-[10px] border border-loss/20 bg-loss/5 px-4 py-2.5 text-xs text-loss">
          Не удалось изменить watchlist: {watchlistMutation.error.message}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Цена"
          value={formatPrice(data.market.price)}
          hint={`${data.market.exchange} · ${data.market.instrumentType}`}
        />
        <MetricCard
          label="Изменение за период"
          value={formatPercent(data.analysis.periodChangePercent)}
          hint={`${data.candles.length} свечей · ${data.interval} минут`}
        />
        <MetricCard
          label="RSI 14"
          value={formatIndicator(data.analysis.rsi14)}
          hint={describeRsi(data.analysis.rsi14)}
        />
        <MetricCard
          label="ATR 14"
          value={formatPrice(data.analysis.atr14)}
          hint="Средний истинный диапазон"
        />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between border-b">
          <div>
            <CardTitle>График · {data.market.symbol}</CardTitle>
            <CardDescription>Реальные свечи Bybit, последние 18 часов.</CardDescription>
          </div>
          <Badge variant="secondary">15m</Badge>
        </CardHeader>
        <CardContent className="px-2 pb-1 pt-3 sm:px-4">
          <CandlestickChart candles={data.candles} symbol={data.market.symbol} />
        </CardContent>
      </Card>

      <PairTradingContext
        positions={
          ledgerQuery.data?.data.positions.filter(
            (position) => position.symbol === data.market.symbol,
          ) ?? []
        }
        trades={
          ledgerQuery.data?.data.trades
            .filter((trade) => trade.symbol === data.market.symbol)
            .slice(0, 5) ?? []
        }
        loading={ledgerQuery.isPending}
        unavailable={ledgerQuery.isError}
      />

      <div className="grid gap-3 xl:grid-cols-[1.2fr_0.8fr]">
        <Card>
          <CardHeader className="border-b">
            <CardTitle>Техническая сводка</CardTitle>
            <CardDescription>
              Режим рассчитывается по EMA 20/50 и RSI 14 на интервале 15 минут.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-x-8 gap-y-0 sm:grid-cols-2">
            <AnalysisRow label="Режим" value={regime.label} badge={regime.variant} />
            <AnalysisRow label="EMA 20" value={formatPrice(data.analysis.ema20)} monospace />
            <AnalysisRow label="EMA 50" value={formatPrice(data.analysis.ema50)} monospace />
            <AnalysisRow label="RSI 14" value={formatIndicator(data.analysis.rsi14)} monospace />
            <AnalysisRow
              label="Изменение"
              value={formatPercent(data.analysis.periodChangePercent)}
              tone={periodChange >= 0 ? "profit" : "loss"}
            />
            <AnalysisRow label="Объём 24ч" value={formatPrice(data.market.volume24h)} monospace />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <CardTitle>Контекст данных</CardTitle>
            <CardDescription>Источник и актуальность расчёта.</CardDescription>
          </CardHeader>
          <CardContent>
            <AnalysisRow label="Биржа" value="Bybit" />
            <AnalysisRow label="Рынок" value="Linear perpetual" />
            <AnalysisRow label="Интервал" value="15 минут" />
            <AnalysisRow label="Свечей" value={String(data.candles.length)} monospace />
            <AnalysisRow
              label="Watchlist"
              value={data.market.watchlisted ? "Добавлена" : "Не добавлена"}
              icon={
                data.market.watchlisted ? (
                  <Star className="size-3.5 fill-warning text-warning" />
                ) : undefined
              }
            />
            <p className="pt-3 text-xs leading-5 text-stale">
              Сводка описывает состояние рынка и не является торговой рекомендацией.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function BackToMarkets() {
  return (
    <Link
      to="/markets"
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      Рынки
    </Link>
  );
}

type BadgeVariant = "profit" | "loss" | "secondary";

const regimeContent: Record<
  "bull" | "bear" | "neutral" | "unknown",
  { label: string; variant: BadgeVariant }
> = {
  bull: { label: "Бычий режим", variant: "profit" },
  bear: { label: "Медвежий режим", variant: "loss" },
  neutral: { label: "Нейтральный режим", variant: "secondary" },
  unknown: { label: "Недостаточно данных", variant: "secondary" },
};

function AnalysisRow({
  label,
  value,
  monospace = false,
  badge,
  tone,
  icon,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  badge?: BadgeVariant;
  tone?: "profit" | "loss";
  icon?: ReactNode;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 border-b border-row-border last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5">
        {icon}
        {badge ? (
          <Badge variant={badge}>{value}</Badge>
        ) : (
          <span
            className={`${monospace ? "font-mono tabular-nums" : ""} ${
              tone === "profit" ? "text-profit" : tone === "loss" ? "text-loss" : ""
            } text-sm`}
          >
            {value}
          </span>
        )}
      </span>
    </div>
  );
}

function formatIndicator(value: string | null): string {
  if (value === null) return "—";
  return Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
}

function describeRsi(value: string | null): string {
  if (value === null) return "Недостаточно данных";
  const rsi = Number(value);
  if (rsi >= 70) return "Зона перекупленности";
  if (rsi <= 30) return "Зона перепроданности";
  return "Нейтральный диапазон";
}

function MarketDetailSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-16" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-[350px]" />
      <div className="grid gap-3 xl:grid-cols-2">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}
