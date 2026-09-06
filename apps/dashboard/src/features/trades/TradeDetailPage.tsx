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
  cn,
} from "@cryptoanal/ui";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Clock3 } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { ApiClientError, fetchTradeDetail } from "../../shared/api";
import { formatMoney, formatPrice } from "../../shared/format";

export default function TradeDetailPage() {
  const { tradeId = "" } = useParams();
  const tradeQuery = useQuery({
    queryKey: ["trade", tradeId],
    queryFn: () => fetchTradeDetail(tradeId),
    enabled: tradeId.length > 0,
    staleTime: 60_000,
  });

  if (tradeQuery.isPending) return <TradeDetailSkeleton />;

  if (tradeQuery.isError) {
    return (
      <div className="space-y-[18px]">
        <BackToTrades />
        <ErrorState
          title="Не удалось открыть сделку"
          description={tradeQuery.error.message}
          requestId={
            tradeQuery.error instanceof ApiClientError ? tradeQuery.error.requestId : undefined
          }
          onRetry={() => void tradeQuery.refetch()}
        />
      </div>
    );
  }

  const { trade, execution, orders } = tradeQuery.data.data;
  const pnlIsPositive = Number(trade.netPnl) >= 0;

  return (
    <div className="space-y-[18px]">
      <BackToTrades />
      <PageHeader
        title={`${trade.symbol} · сделка`}
        description={`${formatDateTime(trade.openedAt)} — ${formatDateTime(trade.closedAt)}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={trade.side === "buy" ? "profit" : "loss"}>
              {trade.side === "buy" ? "Лонг" : "Шорт"}
            </Badge>
            <Badge variant="outline">{environmentLabel[trade.environment]}</Badge>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Количество"
          value={formatPrice(trade.quantity)}
          hint={trade.symbol}
          compact
        />
        <MetricCard
          label="Средний вход"
          value={formatPrice(trade.averageEntryPrice)}
          hint="Средневзвешенная цена"
          compact
        />
        <MetricCard
          label="Средний выход"
          value={formatPrice(trade.averageExitPrice)}
          hint={trade.exitReason}
          compact
        />
        <MetricCard
          label="Net PnL"
          value={formatMoney(trade.netPnl)}
          hint={pnlIsPositive ? "Положительный результат" : "Отрицательный результат"}
          compact
          tone={pnlIsPositive ? "profit" : "loss"}
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader className="border-b">
            <CardTitle>Финансовый результат</CardTitle>
            <CardDescription>Разложение результата без скрытых корректировок.</CardDescription>
          </CardHeader>
          <CardContent>
            <DetailRow label="Gross PnL" value={formatMoney(trade.grossPnl)} />
            <DetailRow label="Комиссии" value={formatMoney(trade.fees)} />
            <DetailRow label="Funding" value={formatMoney(trade.funding)} />
            <DetailRow label="Slippage" value={formatMoney(trade.slippage)} />
            <DetailRow
              label="Net PnL"
              value={formatMoney(trade.netPnl)}
              tone={pnlIsPositive ? "profit" : "loss"}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <CardTitle>Контекст исполнения</CardTitle>
            <CardDescription>Версия стратегии и runtime, создавшие результат.</CardDescription>
          </CardHeader>
          <CardContent>
            <DetailRow
              label="Стратегия"
              value={`${trade.strategy.name} · v${trade.strategy.version}`}
            />
            <DetailRow label="Режим на входе" value={marketRegimeLabel[trade.entryRegime]} />
            <DetailRow label="UTC-сессия входа" value={tradingSessionLabel[trade.entrySession]} />
            <DetailRow label="Статус run" value={runStatusLabel[execution.status]} />
            <DetailRow label="Engine" value={execution.engineVersion} monospace />
            <DetailRow label="Run ID" value={execution.runId} monospace />
            <DetailRow label="Config hash" value={execution.configHash} monospace wrap />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between border-b">
          <div>
            <CardTitle>Ордера и исполнения</CardTitle>
            <CardDescription>Последовательность заявок и подтверждённых fills.</CardDescription>
          </div>
          <Badge variant="outline">{orders.length} ордеров</Badge>
        </CardHeader>
        <CardContent className={orders.length > 0 ? "px-0 pb-0" : undefined}>
          {orders.length === 0 ? (
            <EmptyState
              title="Связанных ордеров нет"
              description="Сделка сохранена, но order/fill provenance отсутствует. Для импортированных данных это требует отдельной сверки."
            />
          ) : (
            <div className="divide-y divide-row-border">
              {orders.map((order, index) => (
                <article key={order.id} className="p-4">
                  <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                    <div className="flex items-start gap-3">
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-avatar font-mono text-xs text-muted-foreground">
                        {index + 1}
                      </span>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-mono text-sm font-medium">{order.clientOrderId}</p>
                          <Badge variant={order.side === "buy" ? "profit" : "loss"}>
                            {order.side === "buy" ? "Покупка" : "Продажа"}
                          </Badge>
                          <Badge variant={order.status === "rejected" ? "loss" : "outline"}>
                            {orderStatusLabel[order.status]}
                          </Badge>
                        </div>
                        <p className="mt-1 flex items-center gap-1.5 text-xs text-stale">
                          <Clock3 className="size-3" aria-hidden="true" />
                          {formatDateTime(order.createdAt)} · {orderTypeLabel[order.type]}
                        </p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 text-right text-xs">
                      <span className="text-stale">Количество</span>
                      <span className="text-stale">Цена</span>
                      <span className="font-mono">{formatPrice(order.quantity)}</span>
                      <span className="font-mono">{formatPrice(order.price)}</span>
                    </div>
                  </div>

                  {order.fills.length > 0 ? (
                    <div className="mt-4 overflow-x-auto rounded-[10px] border border-row-border">
                      <table className="w-full min-w-[620px] border-collapse text-xs">
                        <thead>
                          <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                            <th className="px-3 py-2 font-medium">Исполнено</th>
                            <th className="px-3 py-2 text-right font-medium">Количество</th>
                            <th className="px-3 py-2 text-right font-medium">Цена</th>
                            <th className="px-3 py-2 text-right font-medium">Комиссия</th>
                          </tr>
                        </thead>
                        <tbody>
                          {order.fills.map((fill) => (
                            <tr key={fill.id} className="border-t border-row-border">
                              <td className="px-3 py-2 text-muted-foreground">
                                {formatDateTime(fill.filledAt)}
                              </td>
                              <td className="px-3 py-2 text-right font-mono">
                                {formatPrice(fill.quantity)}
                              </td>
                              <td className="px-3 py-2 text-right font-mono">
                                {formatPrice(fill.price)}
                              </td>
                              <td className="px-3 py-2 text-right font-mono">
                                {formatPrice(fill.fee)} {fill.feeAsset ?? ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="mt-4 rounded-[10px] border border-row-border px-3 py-2 text-xs text-stale">
                      Подтверждённых исполнений для ордера нет.
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BackToTrades() {
  return (
    <Link
      to="/trades?view=history"
      className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      История сделок
    </Link>
  );
}

function DetailRow({
  label,
  value,
  monospace = false,
  wrap = false,
  tone,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  wrap?: boolean;
  tone?: "profit" | "loss";
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-5 border-b border-row-border last:border-0">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-right text-sm",
          monospace && "font-mono text-xs",
          wrap && "min-w-0 break-all",
          tone === "profit" && "text-profit",
          tone === "loss" && "text-loss",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const environmentLabel = {
  "dry-run": "Dry-run",
  demo: "Demo",
  live: "Live",
} as const;

const runStatusLabel = {
  queued: "В очереди",
  running: "Выполняется",
  completed: "Завершён",
  failed: "Ошибка",
  cancelled: "Отменён",
} as const;

const marketRegimeLabel = {
  bull: "Бычий",
  bear: "Медвежий",
  neutral: "Нейтральный",
  unknown: "Нет данных",
} as const;

const tradingSessionLabel = {
  asia: "Азия · 00:00–08:00 UTC",
  europe: "Европа · 08:00–13:00 UTC",
  us: "США · 13:00–21:00 UTC",
  "off-hours": "Вне основных сессий · 21:00–00:00 UTC",
  unknown: "Нет данных",
} as const;

const orderStatusLabel = {
  pending: "Ожидает",
  open: "Открыт",
  "partially-filled": "Частично исполнен",
  filled: "Исполнен",
  cancelled: "Отменён",
  rejected: "Отклонён",
} as const;

const orderTypeLabel = {
  market: "Market",
  limit: "Limit",
  stop: "Stop",
} as const;

function TradeDetailSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-16" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}
