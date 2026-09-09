import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  FieldLabel,
  Input,
  MetricCard,
  PageHeader,
  Skeleton,
  cn,
} from "@cryptoanal/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiClientError, closePosition, fetchTradingLedger } from "../../shared/api";
import { formatMoney, formatPrice } from "../../shared/format";

export default function TradesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get("view") === "history" ? "history" : "open";
  const ledgerQuery = useQuery({
    queryKey: ["trading-ledger"],
    queryFn: fetchTradingLedger,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  if (ledgerQuery.isPending) return <TradesSkeleton />;

  if (ledgerQuery.isError) {
    return (
      <div className="space-y-[18px]">
        <PageHeader eyebrow="Позиции и сделки" title="История и открытые позиции" />
        <ErrorState
          description={ledgerQuery.error.message}
          requestId={
            ledgerQuery.error instanceof ApiClientError ? ledgerQuery.error.requestId : undefined
          }
          onRetry={() => void ledgerQuery.refetch()}
        />
      </div>
    );
  }

  const { data, meta } = ledgerQuery.data;

  function selectView(nextView: "open" | "history") {
    setSearchParams(nextView === "history" ? { view: "history" } : {}, { replace: true });
  }

  return (
    <div className="space-y-[18px]">
      <PageHeader
        eyebrow="Позиции и сделки"
        title="История и открытые позиции"
        actions={
          <span className="text-xs text-stale">
            обновлено {new Date(meta.generatedAt).toLocaleTimeString("ru-RU")}
          </span>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Открытые позиции"
          value={String(data.summary.openPositions)}
          hint="Текущий торговый контур"
        />
        <MetricCard
          label="Экспозиция"
          value={formatMoney(data.summary.openExposure)}
          hint="По mark price или цене входа"
        />
        <MetricCard
          label="Нереализованный PnL"
          value={formatMoney(data.summary.unrealizedPnl)}
          hint="Только открытые позиции"
          tone={metricTone(data.summary.unrealizedPnl)}
        />
        <MetricCard
          label="Закрытый PnL"
          value={formatMoney(data.summary.netPnl)}
          hint={`${data.summary.closedTrades} завершённых сделок`}
          tone={metricTone(data.summary.netPnl)}
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-medium">Позиции и история</h2>
        <div
          className="flex rounded-full border border-input bg-card p-0.5"
          role="group"
          aria-label="Раздел сделок"
        >
          <ViewButton active={view === "open"} onClick={() => selectView("open")}>
            Открытые {data.positions.length}
          </ViewButton>
          <ViewButton active={view === "history"} onClick={() => selectView("history")}>
            История {data.summary.closedTrades}
          </ViewButton>
        </div>
      </div>

      {view === "open" ? <PositionsTable positions={data.positions} /> : null}
      {view === "history" ? <TradesTable trades={data.trades} /> : null}
    </div>
  );
}

function metricTone(value: string | number): "neutral" | "profit" | "loss" {
  const numericValue = Number(value);
  return numericValue > 0 ? "profit" : numericValue < 0 ? "loss" : "neutral";
}

function ViewButton({
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
        "h-7 rounded-full px-3 text-[11px] text-muted-foreground",
        active && "bg-avatar text-foreground",
      )}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function PositionsTable({
  positions,
}: {
  positions: Awaited<ReturnType<typeof fetchTradingLedger>>["data"]["positions"];
}) {
  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const selectedPosition = positions.find((position) => position.id === selectedPositionId) ?? null;
  const closeMutation = useMutation({
    mutationFn: (input: { positionId: string; reason: string; idempotencyKey: string }) =>
      closePosition(input.positionId, {
        expectedStatus: "open",
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      }),
    onSuccess: () => {
      setSelectedPositionId(null);
      setReason("");
      setLocalError(null);
      void queryClient.invalidateQueries({ queryKey: ["trading-ledger"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
    },
  });

  if (positions.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            title="Открытых позиций нет"
            description="Позиции появятся после запуска стратегии и получения подтверждённого исполнения от торгового контура."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Открытые позиции</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {selectedPosition ? (
          <div className="grid gap-3 border-b border-row-border bg-secondary/30 px-[18px] py-4 lg:grid-cols-[1fr_320px_auto] lg:items-end">
            <div>
              <p className="text-sm font-medium">
                Закрыть {selectedPosition.symbol} по актуальной dry-run цене?
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Будут созданы fill, trade, decision и audit event. Команда необратима.
              </p>
            </div>
            <label className="space-y-2">
              <FieldLabel>Причина закрытия</FieldLabel>
              <Input
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  setLocalError(null);
                }}
                placeholder="Например: ручная фиксация"
                autoFocus
              />
            </label>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={closeMutation.isPending}
                onClick={() => setSelectedPositionId(null)}
              >
                Отмена
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={closeMutation.isPending}
                onClick={() => {
                  if (reason.trim().length < 3) {
                    setLocalError("Укажите причину закрытия");
                    return;
                  }
                  setLocalError(null);
                  closeMutation.mutate({
                    positionId: selectedPosition.id,
                    reason: reason.trim(),
                    idempotencyKey: crypto.randomUUID(),
                  });
                }}
              >
                {closeMutation.isPending ? "Закрывается…" : "Подтвердить"}
              </Button>
            </div>
            {localError || closeMutation.isError ? (
              <p className="text-xs text-loss lg:col-span-3">
                {localError ?? closeMutation.error?.message}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                <th scope="col" className="px-4 py-3 font-medium">
                  Открыта
                </th>
                <th scope="col" className="px-3 py-3 font-medium">
                  Пара
                </th>
                <th scope="col" className="px-3 py-3 font-medium">
                  Сторона
                </th>
                <th scope="col" className="px-3 py-3 text-right font-medium">
                  Количество
                </th>
                <th scope="col" className="px-3 py-3 text-right font-medium">
                  Вход
                </th>
                <th scope="col" className="px-3 py-3 text-right font-medium">
                  Mark
                </th>
                <th scope="col" className="px-3 py-3 text-right font-medium">
                  PnL
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Стратегия
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Действие
                </th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => (
                <tr key={position.id} className="border-t border-row-border hover:bg-row-hover">
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatDateTime(position.openedAt)}
                  </td>
                  <td className="px-3 py-3">
                    <Link
                      to={`/markets/${position.symbol}`}
                      className="font-mono font-medium hover:text-white"
                    >
                      {position.symbol}
                    </Link>
                  </td>
                  <td className="px-3 py-3">
                    <SideBadge side={position.side} />
                  </td>
                  <td className="px-3 py-3 text-right font-mono">
                    {formatPrice(position.quantity)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono">
                    {formatPrice(position.entryPrice)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono">
                    {formatPrice(position.markPrice)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-3 text-right font-mono",
                      Number(position.unrealizedPnl) >= 0 ? "text-profit" : "text-loss",
                    )}
                  >
                    {formatMoney(position.unrealizedPnl)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {position.strategy.name} · v{position.strategy.version}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={position.environment !== "dry-run"}
                      title={
                        position.environment !== "dry-run"
                          ? "Ручное закрытие сейчас доступно только в dry-run"
                          : undefined
                      }
                      onClick={() => {
                        closeMutation.reset();
                        setReason("");
                        setLocalError(null);
                        setSelectedPositionId(position.id);
                      }}
                    >
                      Закрыть
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function TradesTable({
  trades,
}: {
  trades: Awaited<ReturnType<typeof fetchTradingLedger>>["data"]["trades"];
}) {
  if (trades.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            title="История сделок пуста"
            description="Завершённые сделки появятся после закрытия реальных dry-run, demo или live позиций."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>История сделок</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                <th scope="col" className="px-4 py-3 font-medium">
                  Закрыта
                </th>
                <th scope="col" className="px-3 py-3 font-medium">
                  Пара
                </th>
                <th scope="col" className="px-3 py-3 font-medium">
                  Сторона
                </th>
                <th scope="col" className="px-3 py-3 text-right font-medium">
                  Вход
                </th>
                <th scope="col" className="px-3 py-3 text-right font-medium">
                  Выход
                </th>
                <th scope="col" className="px-3 py-3 text-right font-medium">
                  Net PnL
                </th>
                <th scope="col" className="px-3 py-3 font-medium">
                  Причина
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Стратегия
                </th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => (
                <tr key={trade.id} className="border-t border-row-border hover:bg-row-hover">
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatDateTime(trade.closedAt)}
                  </td>
                  <td className="px-3 py-3">
                    <Link
                      to={`/markets/${trade.symbol}`}
                      className="font-mono font-medium hover:text-white"
                    >
                      {trade.symbol}
                    </Link>
                  </td>
                  <td className="px-3 py-3">
                    <SideBadge side={trade.side} />
                  </td>
                  <td className="px-3 py-3 text-right font-mono">
                    {formatPrice(trade.averageEntryPrice)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono">
                    {formatPrice(trade.averageExitPrice)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-3 text-right font-mono",
                      Number(trade.netPnl) >= 0 ? "text-profit" : "text-loss",
                    )}
                  >
                    {formatMoney(trade.netPnl)}
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{trade.exitReason}</td>
                  <td className="px-4 py-3">
                    <Link
                      to={`/trades/${trade.id}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {trade.strategy.name} · v{trade.strategy.version}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function SideBadge({ side }: { side: "buy" | "sell" }) {
  return (
    <Badge variant={side === "buy" ? "profit" : "loss"}>{side === "buy" ? "Лонг" : "Шорт"}</Badge>
  );
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TradesSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-16" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}
