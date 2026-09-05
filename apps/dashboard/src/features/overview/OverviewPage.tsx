import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  MetricCard,
  PageHeader,
  Skeleton,
} from "@cryptoanal/ui";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { ApiClientError, fetchMarkets, fetchOverview } from "../../shared/api";
import { formatMoney, formatPercent, formatPrice } from "../../shared/format";

export default function OverviewPage() {
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

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Капитал"
          value={formatMoney(data.equity)}
          hint={data.equity ? "Последний account snapshot" : "Ожидается exchange adapter"}
        />
        <MetricCard
          label="PnL сегодня"
          value={formatMoney(data.dayPnl)}
          hint="UTC, закрытые сделки"
        />
        <MetricCard
          label="Открытые позиции"
          value={String(data.openPositions)}
          hint={data.openExposure ? formatMoney(data.openExposure) : "Экспозиция недоступна"}
        />
        <MetricCard
          label="Активные стратегии"
          value={String(data.activeStrategies)}
          hint="Deployments и paused"
        />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between border-b">
          <CardTitle>Пары в работе</CardTitle>
          <Badge variant="outline">{marketsQuery.data?.data.total ?? 0} пар</Badge>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {marketsQuery.isPending ? (
            <div className="space-y-1 p-4">
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="h-10" />
              ))}
            </div>
          ) : null}
          {marketsQuery.isSuccess ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] border-collapse text-[13px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                    <th className="px-4 py-2.5 font-medium">Пара</th>
                    <th className="px-3 py-2.5 font-medium">Режим</th>
                    <th className="px-3 py-2.5 text-right font-medium">Цена</th>
                    <th className="px-3 py-2.5 text-right font-medium">24ч</th>
                    <th className="px-3 py-2.5 text-right font-medium">Позиции</th>
                    <th className="px-4 py-2.5 text-right font-medium">Данные</th>
                  </tr>
                </thead>
                <tbody>
                  {marketsQuery.data.data.items.map((market) => {
                    const change = Number(market.change24hPercent ?? 0);
                    return (
                      <tr
                        key={market.symbol}
                        className="border-t border-row-border hover:bg-row-hover"
                      >
                        <td className="px-4 py-2.5 font-mono font-medium text-foreground">
                          {market.symbol}
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
                        <td className="px-3 py-2.5 text-right font-mono text-stale">0</td>
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
                    className="flex gap-3 rounded-[11px] border border-warning/25 bg-warning/5 p-3.5"
                  >
                    <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
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
            <ContextRow label="Режим" value="Dry-run" />
            <ContextRow label="Freshness" value={meta.freshness} />
            <ContextRow
              label="Сформировано"
              value={new Date(meta.generatedAt).toLocaleTimeString("ru-RU")}
            />
            <ContextRow label="Total PnL" value={formatMoney(data.totalPnl)} monospace />
          </CardContent>
        </Card>
      </div>
    </div>
  );
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
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
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
