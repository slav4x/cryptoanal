import type { OverviewPeriod } from "@cryptoanal/contracts";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  cn,
} from "@cryptoanal/ui";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiClientError, fetchMarkets, fetchOverview, fetchTradingLedger } from "../../shared/api";
import { formatMetricMoney, formatMoney, formatPercent, formatPrice } from "../../shared/format";
import { AccountEquityChart } from "./AccountEquityChart";

export default function OverviewPage() {
  const [period, setPeriod] = useState<OverviewPeriod>("24h");
  const overviewQuery = useQuery({
    queryKey: ["overview"],
    queryFn: fetchOverview,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
  const marketsQuery = useQuery({
    queryKey: ["markets"],
    queryFn: fetchMarkets,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const tradingQuery = useQuery({
    queryKey: ["trading-ledger"],
    queryFn: fetchTradingLedger,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  if (overviewQuery.isPending) return <OverviewSkeleton />;

  if (overviewQuery.isError) {
    const error = overviewQuery.error;
    return (
      <div className="space-y-[18px]">
        <PageHeader
          title="Обзор"
          description="Оперативное состояние торгового контура и ключевые показатели."
        />
        <ErrorState
          description={error.message}
          requestId={error instanceof ApiClientError ? error.requestId : undefined}
          onRetry={() => void overviewQuery.refetch()}
        />
      </div>
    );
  }

  const { data, meta } = overviewQuery.data;
  const openPositions = tradingQuery.data?.data.positions ?? [];
  const openPositionCounts = new Map<string, number>();
  for (const position of openPositions) {
    openPositionCounts.set(position.symbol, (openPositionCounts.get(position.symbol) ?? 0) + 1);
  }
  const workingMarkets =
    marketsQuery.data?.data.items.filter((market) => openPositionCounts.has(market.symbol)) ?? [];
  const workingMarketsReady = marketsQuery.isSuccess && tradingQuery.isSuccess;

  return (
    <div className="space-y-[18px]">
      <PageHeader
        title="Обзор"
        description="Оперативное состояние торгового контура и ключевые показатели."
        actions={
          <span className="text-xs text-stale">
            обновлено {new Date(meta.generatedAt).toLocaleTimeString("ru-RU")}
          </span>
        }
      />

      <Card>
        <CardContent className="p-0">
          <div className="grid grid-cols-2 xl:grid-cols-[minmax(270px,1.35fr)_repeat(4,minmax(0,1fr))]">
            <div className="col-span-2 min-w-0 bg-muted/20 px-5 py-4 xl:col-span-1">
              <p className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                Капитал
              </p>
              <p className="mt-2 truncate whitespace-nowrap font-mono text-[26px] font-medium leading-none tabular-nums text-foreground">
                {formatMetricMoney(data.account?.equity ?? null)}
              </p>
              <p className="mt-2 truncate text-xs text-stale">
                {data.account
                  ? `Snapshot ${new Date(data.account.observedAt).toLocaleTimeString("ru-RU")}`
                  : "Ожидается account snapshot"}
              </p>
            </div>
            <OverviewMetric
              label="PnL сегодня"
              value={formatMetricMoney(data.dayPnl)}
              hint="UTC, закрытые сделки"
              tone={metricTone(data.dayPnl)}
            />
            <OverviewMetric
              label="Total PnL"
              value={formatMetricMoney(data.totalPnl)}
              hint="Все закрытые сделки"
              tone={metricTone(data.totalPnl)}
              className="border-l"
            />
            <OverviewMetric
              label="Экспозиция"
              value={formatMetricMoney(data.openExposure)}
              hint={`${data.openPositions} открытых позиций`}
            />
            <OverviewMetric
              label="Активные стратегии"
              value={String(data.activeStrategies)}
              hint="Running и paused"
              className="border-l"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between border-b">
          <div>
            <CardTitle>Пары в работе</CardTitle>
            <CardDescription>Только пары с открытыми позициями.</CardDescription>
          </div>
          <Badge variant="outline">{workingMarketsReady ? workingMarkets.length : "—"}</Badge>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {marketsQuery.isPending || tradingQuery.isPending ? (
            <div className="space-y-1 p-4">
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="h-10" />
              ))}
            </div>
          ) : null}
          {marketsQuery.isError || tradingQuery.isError ? <CompactUnavailable /> : null}
          {workingMarketsReady && workingMarkets.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="Открытых позиций нет"
                description="Пары появятся здесь после открытия позиции торговой стратегией. Полный список инструментов остаётся в разделе «Рынок»."
                action={
                  <Button asChild variant="outline" size="sm">
                    <Link to="/markets">Открыть рынок</Link>
                  </Button>
                }
              />
            </div>
          ) : null}
          {workingMarketsReady && workingMarkets.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] border-collapse text-[13px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Пара
                    </th>
                    <th scope="col" className="px-3 py-2.5 font-medium">
                      Режим
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">
                      Цена
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">
                      24ч
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">
                      Позиции
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">
                      Данные
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {workingMarkets.map((market) => {
                    const change = Number(market.change24hPercent ?? 0);
                    return (
                      <tr
                        key={market.symbol}
                        className="border-t border-row-border hover:bg-row-hover"
                      >
                        <td className="px-4 py-2.5 font-mono font-medium text-foreground">
                          <Link to={`/markets/${market.symbol}`} className="hover:text-white">
                            {market.symbol}
                          </Link>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground">
                          {market.regime === "unknown" ? "Не определён" : market.regime}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-secondary-foreground">
                          {formatPrice(market.price)}
                        </td>
                        <td
                          className={`px-3 py-2.5 text-right font-mono ${
                            market.change24hPercent === null
                              ? "text-stale"
                              : change >= 0
                                ? "text-profit"
                                : "text-loss"
                          }`}
                        >
                          {formatPercent(market.change24hPercent)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-secondary-foreground">
                          {openPositionCounts.get(market.symbol)}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <span
                            className={
                              market.freshness === "fresh" ? "text-profit" : "text-warning"
                            }
                          >
                            {market.freshness === "fresh" ? "свежие" : "нет данных"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between border-b">
          <div>
            <CardTitle>Капитал</CardTitle>
            <CardDescription>
              Account snapshots · {environmentLabels[data.tradingEnvironment]}
            </CardDescription>
          </div>
          <div className="flex rounded-full border border-input bg-background p-0.5">
            {overviewPeriods.map((item) => (
              <Button
                key={item.value}
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 rounded-full px-3 text-[11px] text-muted-foreground",
                  period === item.value && "bg-avatar text-foreground",
                )}
                aria-pressed={period === item.value}
                onClick={() => setPeriod(item.value)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0 pt-4">
          <div className="mb-3 flex items-end justify-between gap-4 px-4">
            <div>
              <p className="text-[13px] text-muted-foreground">Текущий капитал</p>
              <p className="mt-1 font-mono text-[26px] font-medium tabular-nums">
                {formatMetricMoney(data.account?.equity ?? null)}
              </p>
            </div>
            <EquityDelta points={data.equitySeries} period={period} />
          </div>
          <AccountEquityChart points={data.equitySeries} period={period} />
        </CardContent>
      </Card>

      <div className="grid gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between border-b">
            <div>
              <CardTitle>Открытые позиции</CardTitle>
              <CardDescription>Активная экспозиция торгового контура.</CardDescription>
            </div>
            <Badge variant="outline">{tradingQuery.data?.data.positions.length ?? 0}</Badge>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {tradingQuery.isPending ? <CompactRowsSkeleton /> : null}
            {tradingQuery.isError ? <CompactUnavailable /> : null}
            {tradingQuery.isSuccess && tradingQuery.data.data.positions.length === 0 ? (
              <CompactEmpty>Открытых позиций нет.</CompactEmpty>
            ) : null}
            {tradingQuery.data?.data.positions.slice(0, 4).map((position) => (
              <div
                key={position.id}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-t border-row-border px-4 py-3 text-[13px] first:border-t-0"
              >
                <div>
                  <Link
                    to={`/markets/${position.symbol}`}
                    className="font-mono font-medium hover:text-white"
                  >
                    {position.symbol}
                  </Link>
                  <p className="mt-0.5 text-xs text-stale">{position.strategy.name}</p>
                </div>
                <Badge variant={position.side === "buy" ? "profit" : "loss"}>
                  {position.side === "buy" ? "Лонг" : "Шорт"}
                </Badge>
                <span
                  className={cn(
                    "min-w-24 text-right font-mono",
                    Number(position.unrealizedPnl) >= 0 ? "text-profit" : "text-loss",
                  )}
                >
                  {formatMoney(position.unrealizedPnl)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between border-b">
            <div>
              <CardTitle>Последние сделки</CardTitle>
              <CardDescription>Недавние завершённые исполнения.</CardDescription>
            </div>
            <Link to="/trades?view=history" className="text-xs text-accent hover:text-accent/80">
              Вся история
            </Link>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {tradingQuery.isPending ? <CompactRowsSkeleton /> : null}
            {tradingQuery.isError ? <CompactUnavailable /> : null}
            {tradingQuery.isSuccess && tradingQuery.data.data.trades.length === 0 ? (
              <CompactEmpty>Завершённых сделок пока нет.</CompactEmpty>
            ) : null}
            {tradingQuery.data?.data.trades.slice(0, 4).map((trade) => (
              <div
                key={trade.id}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-t border-row-border px-4 py-3 text-[13px] first:border-t-0"
              >
                <div>
                  <Link
                    to={`/markets/${trade.symbol}`}
                    className="font-mono font-medium hover:text-white"
                  >
                    {trade.symbol}
                  </Link>
                  <p className="mt-0.5 text-xs text-stale">{formatCompactDate(trade.closedAt)}</p>
                </div>
                <Badge variant={trade.side === "buy" ? "profit" : "loss"}>
                  {trade.side === "buy" ? "Лонг" : "Шорт"}
                </Badge>
                <span
                  className={cn(
                    "min-w-24 text-right font-mono",
                    Number(trade.netPnl) >= 0 ? "text-profit" : "text-loss",
                  )}
                >
                  {formatMoney(trade.netPnl)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Состояние системы</CardTitle>
            <CardDescription>
              Критичные отклонения показываются раньше графиков и вторичных метрик.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.alerts.length ? (
              <div className="space-y-3">
                {data.alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={cn(
                      "flex gap-3 rounded-[11px] border p-3.5",
                      alert.severity === "critical"
                        ? "border-loss/25 bg-loss/5"
                        : "border-warning/25 bg-warning/5",
                    )}
                  >
                    <ShieldAlert
                      className={cn(
                        "mt-0.5 size-4 shrink-0",
                        alert.severity === "critical" ? "text-loss" : "text-warning",
                      )}
                    />
                    <div>
                      <p className="text-sm font-medium">{alert.title}</p>
                      <p className="mt-1 text-sm text-muted-foreground">{alert.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="Активных предупреждений нет"
                description="API, worker и market data работают в ожидаемом режиме."
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Контекст данных</CardTitle>
            <CardDescription>Источник и актуальность текущего представления.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <ContextRow label="Режим" value={environmentLabels[data.tradingEnvironment]} />
            <ContextRow label="Данные счёта" value={freshnessLabels[meta.freshness]} />
            <ContextRow
              label="Account ID"
              value={data.account?.exchangeAccountId ?? "—"}
              monospace
            />
            <ContextRow
              label="Доступный баланс"
              value={formatMoney(data.account?.availableBalance ?? null)}
              monospace
            />
            <ContextRow
              label="Сформировано"
              value={new Date(meta.generatedAt).toLocaleTimeString("ru-RU")}
            />
            <ContextRow
              label="Нереализованный PnL"
              value={formatMoney(data.unrealizedPnl)}
              monospace
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function EquityDelta({
  points,
  period,
}: {
  points: Array<{ equity: string; observedAt: string }>;
  period: OverviewPeriod;
}) {
  if (points.length < 2) return <span className="text-xs text-stale">накапливаем историю</span>;

  const startsAt = new Date(points.at(-1)!.observedAt).getTime() - overviewPeriodDurationMs[period];
  const firstPoint = findPointAtOrBefore(points, startsAt) ?? points[0]!;
  const first = Number(firstPoint.equity);
  const last = Number(points.at(-1)!.equity);
  const delta = last - first;
  const percent = first === 0 ? null : (delta / first) * 100;
  const tone = metricTone(delta);

  return (
    <div className="text-right">
      <p
        className={cn(
          "font-mono text-sm",
          tone === "profit" && "text-profit",
          tone === "loss" && "text-loss",
        )}
      >
        {formatMetricMoney(String(delta))}
      </p>
      <p className="mt-1 text-xs text-stale">
        {percent === null ? "—" : formatPercent(String(percent))} за период
      </p>
    </div>
  );
}

function OverviewMetric({
  label,
  value,
  hint,
  tone = "neutral",
  className,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "neutral" | "profit" | "loss";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 border-t border-row-border px-4 py-4 xl:border-l xl:border-t-0",
        className,
      )}
    >
      <p className="truncate text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-2 truncate whitespace-nowrap font-mono text-[17px] font-medium leading-none tabular-nums 2xl:text-[19px]",
          tone === "profit" && "text-profit",
          tone === "loss" && "text-loss",
          tone === "neutral" && "text-foreground",
        )}
        title={value}
      >
        {value}
      </p>
      <p className="mt-2 truncate text-[11px] text-stale" title={hint}>
        {hint}
      </p>
    </div>
  );
}

function findPointAtOrBefore<T extends { observedAt: string }>(points: T[], timestamp: number) {
  let match: T | undefined;
  for (const point of points) {
    if (new Date(point.observedAt).getTime() > timestamp) break;
    match = point;
  }
  return match;
}

const overviewPeriods: Array<{ value: OverviewPeriod; label: string }> = [
  { value: "24h", label: "24 часа" },
  { value: "7d", label: "7 дней" },
  { value: "30d", label: "30 дней" },
];

const overviewPeriodDurationMs: Record<OverviewPeriod, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
};

const environmentLabels = {
  "dry-run": "Dry-run",
  demo: "Demo",
  live: "Live",
} as const;

const freshnessLabels = {
  fresh: "Свежие",
  stale: "Устарели",
  unavailable: "Недоступны",
} as const;

function metricTone(value: string | number): "neutral" | "profit" | "loss" {
  const numericValue = Number(value);
  return numericValue > 0 ? "profit" : numericValue < 0 ? "loss" : "neutral";
}

function CompactRowsSkeleton() {
  return (
    <div className="space-y-1 p-4">
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-11" />
      ))}
    </div>
  );
}

function CompactEmpty({ children }: { children: string }) {
  return <p className="py-12 text-center text-sm text-muted-foreground">{children}</p>;
}

function CompactUnavailable() {
  return <p className="py-12 text-center text-sm text-loss">Торговые данные недоступны.</p>;
}

function formatCompactDate(value: string): string {
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ContextRow({
  label,
  value,
  monospace = false,
}: {
  label: string;
  value: string;
  monospace?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b pb-3 last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={monospace ? "font-mono tabular-nums" : "capitalize"}>{value}</span>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-16" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-32" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}
