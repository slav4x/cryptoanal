import type {
  ValidationRunDetailDto,
  ValidationRunDto,
  ValidationTradeResultDto,
} from "@cryptoanal/contracts";
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
  MetricCard,
  PageHeader,
  Skeleton,
  cn,
} from "@cryptoanal/ui";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, GitCompareArrows } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiClientError, fetchValidationRun } from "../../shared/api";
import { ValidationPerformanceChart } from "./ValidationPerformanceChart";

export default function ValidationRunPage() {
  const { validationRunId = "" } = useParams();
  const [tradePage, setTradePage] = useState(1);
  const runQuery = useQuery({
    queryKey: ["validation", validationRunId, tradePage],
    queryFn: () => fetchValidationRun(validationRunId, tradePage),
    enabled: validationRunId.length > 0,
    refetchInterval: (query) => {
      const status = query.state.data?.data.run.status;
      return status === "queued" || status === "running" ? 3_000 : false;
    },
  });

  if (runQuery.isPending) return <ValidationRunSkeleton />;
  if (runQuery.isError) {
    return (
      <div className="space-y-[18px]">
        <BackToValidation />
        <ErrorState
          title="Не удалось открыть validation run"
          description={runQuery.error.message}
          requestId={
            runQuery.error instanceof ApiClientError ? runQuery.error.requestId : undefined
          }
          onRetry={() => void runQuery.refetch()}
        />
      </div>
    );
  }

  const detail = runQuery.data.data;
  const { run } = detail;

  return (
    <div className="space-y-[18px]">
      <BackToValidation />
      <PageHeader
        eyebrow="Validation run"
        title={`${run.strategy.name} · v${run.strategyVersion.version}`}
        description={`${kindLabels[run.kind]} · ${formatDate(run.input.dataset.startDate)} — ${formatDate(run.input.dataset.endDate)}`}
        actions={
          <div className="flex items-center gap-2">
            <RunBadge run={run} />
            {run.status === "completed" ? (
              <Button asChild variant="outline" size="sm">
                <Link to={`/validation/compare?runs=${run.id}`}>
                  <GitCompareArrows aria-hidden="true" />
                  Сравнить
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />

      {run.metrics ? (
        <CompletedRun detail={detail} onTradePageChange={setTradePage} />
      ) : (
        <IncompleteRun run={run} />
      )}

      <RunProvenance run={run} />
    </div>
  );
}

function CompletedRun({
  detail,
  onTradePageChange,
}: {
  detail: ValidationRunDetailDto;
  onTradePageChange: (page: number) => void;
}) {
  const { run, trades, tradesTotal, tradePage, tradeLimit } = detail;
  const metrics = run.metrics!;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <MetricCard
          compact
          label="Net PnL"
          value={formatSignedMoney(metrics.netPnl)}
          hint={`${formatSignedPercent(metrics.returnPercent)} к капиталу`}
          tone={metrics.netPnl >= 0 ? "profit" : "loss"}
        />
        <MetricCard
          compact
          label="Max drawdown"
          value={`${metrics.maxDrawdownPercent.toFixed(2)}%`}
          hint="От локального пика"
          tone={metrics.maxDrawdownPercent > 20 ? "loss" : "neutral"}
        />
        <MetricCard
          compact
          label="Profit factor"
          value={formatProfitFactor(metrics.profitFactor)}
          hint="Gross profit / loss"
          tone={(metrics.profitFactor ?? Infinity) >= 1.1 ? "profit" : "loss"}
        />
        <MetricCard
          compact
          label="Win rate"
          value={`${metrics.winRatePercent.toFixed(1)}%`}
          hint={`${metrics.wins} / ${metrics.losses}`}
        />
        <MetricCard
          compact
          label="Expectancy"
          value={formatSignedMoney(metrics.expectancy)}
          hint="На одну сделку"
          tone={metrics.expectancy > 0 ? "profit" : "loss"}
        />
        <MetricCard
          compact
          label="Сделки"
          value={String(metrics.trades)}
          hint={`Комиссии ${formatMoney(metrics.totalFees)}`}
        />
      </div>

      <div className="grid items-start gap-[18px] xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader className="border-b">
            <CardTitle>Капитал и просадка</CardTitle>
            <CardDescription>
              Daily sampling · {metrics.candleCount.toLocaleString("ru-RU")} свечей
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            <ValidationPerformanceChart points={metrics.equitySeries} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <CardTitle>Validation gates</CardTitle>
            <CardDescription>Формальные условия допуска результата.</CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            {metrics.gateReasons.length === 0 ? (
              <p className="rounded-[10px] border border-profit/20 bg-profit/5 px-3 py-3 text-sm text-profit">
                Все обязательные gates пройдены.
              </p>
            ) : (
              <ul className="space-y-2">
                {metrics.gateReasons.map((reason) => (
                  <li
                    key={reason}
                    className="rounded-[10px] border border-warning/20 bg-warning/5 px-3 py-2.5 text-xs leading-5 text-warning"
                  >
                    {reason}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 space-y-2 border-t border-row-border pt-4 text-xs">
              <DetailRow label="Окон" value={String(metrics.windows)} />
              <DetailRow label="Доходность" value={formatSignedPercent(metrics.returnPercent)} />
              <DetailRow label="Verdict" value={verdictLabels[run.verdict]} />
            </div>
          </CardContent>
        </Card>
      </div>

      <SymbolBreakdown perSymbol={metrics.perSymbol} />
      <ValidationTrades
        trades={trades}
        total={tradesTotal}
        page={tradePage}
        limit={tradeLimit}
        onPageChange={onTradePageChange}
      />
    </>
  );
}

function IncompleteRun({ run }: { run: ValidationRunDto }) {
  if (run.status === "failed") {
    return (
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Проверка завершилась с ошибкой</CardTitle>
          <CardDescription>{run.failureCode ?? "VALIDATION_FAILED"}</CardDescription>
        </CardHeader>
        <CardContent className="pt-4 text-sm text-loss">
          {run.failureMessage ?? "Worker не сохранил описание ошибки."}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <EmptyState
        title={run.status === "running" ? "Проверка выполняется" : "Проверка ожидает worker"}
        description="Страница обновится автоматически после завершения расчёта. Искусственные метрики не показываются."
      />
    </Card>
  );
}

function SymbolBreakdown({
  perSymbol,
}: {
  perSymbol: NonNullable<ValidationRunDetailDto["run"]["metrics"]>["perSymbol"];
}) {
  const rows = Object.entries(perSymbol).sort(([left], [right]) => left.localeCompare(right));
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between border-b">
        <div>
          <CardTitle>Разрез по парам</CardTitle>
          <CardDescription>Количество сделок и net PnL для каждого инструмента.</CardDescription>
        </div>
        <Badge variant="outline">{rows.length} пар</Badge>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <EmptyState title="Сделок нет" description="Ни одна пара не сформировала сделку." />
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                <th className="px-[18px] py-3 font-medium">Пара</th>
                <th className="px-3 py-3 text-right font-medium">Сделки</th>
                <th className="px-[18px] py-3 text-right font-medium">Net PnL</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([symbol, result]) => (
                <tr key={symbol} className="border-t border-row-border">
                  <td className="px-[18px] py-3 font-mono font-medium">{symbol}</td>
                  <td className="px-3 py-3 text-right font-mono">{result.trades}</td>
                  <td
                    className={cn(
                      "px-[18px] py-3 text-right font-mono",
                      result.netPnl >= 0 ? "text-profit" : "text-loss",
                    )}
                  >
                    {formatSignedMoney(result.netPnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function ValidationTrades({
  trades,
  total,
  page,
  limit,
  onPageChange,
}: {
  trades: ValidationTradeResultDto[];
  total: number;
  page: number;
  limit: number;
  onPageChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between border-b">
        <div>
          <CardTitle>Сделки run</CardTitle>
          <CardDescription>{total.toLocaleString("ru-RU")} сохранённых сделок</CardDescription>
        </div>
        <Badge variant="outline">{total}</Badge>
      </CardHeader>
      <CardContent className="p-0">
        {trades.length === 0 ? (
          <EmptyState title="Сделок нет" description="Стратегия не сформировала входов." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] border-collapse text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                  <th className="px-[18px] py-3 font-medium">Пара</th>
                  <th className="px-3 py-3 font-medium">Сторона</th>
                  <th className="px-3 py-3 font-medium">Открыта</th>
                  <th className="px-3 py-3 text-right font-medium">Вход</th>
                  <th className="px-3 py-3 text-right font-medium">Выход</th>
                  <th className="px-3 py-3 font-medium">Причина</th>
                  <th className="px-[18px] py-3 text-right font-medium">Net PnL</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((trade, index) => (
                  <TradeRow key={`${trade.symbol}:${trade.openedAt}:${index}`} trade={trade} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      {total > limit ? (
        <div className="flex items-center justify-between border-t border-row-border px-4 py-3">
          <span className="text-xs text-stale">
            Страница {page} из {pages}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
            >
              Назад
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= pages}
              onClick={() => onPageChange(page + 1)}
            >
              Далее
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function TradeRow({ trade }: { trade: ValidationTradeResultDto }) {
  return (
    <tr className="border-t border-row-border hover:bg-row-hover">
      <td className="px-[18px] py-3 font-mono font-medium">{trade.symbol}</td>
      <td className="px-3 py-3">
        <Badge variant={trade.side === "long" ? "profit" : "loss"}>
          {trade.side === "long" ? "Лонг" : "Шорт"}
        </Badge>
      </td>
      <td className="px-3 py-3 text-muted-foreground">{formatDateTime(trade.openedAt)}</td>
      <td className="px-3 py-3 text-right font-mono">{formatPrice(trade.entryPrice)}</td>
      <td className="px-3 py-3 text-right font-mono">{formatPrice(trade.exitPrice)}</td>
      <td className="px-3 py-3 text-muted-foreground">{exitReasonLabels[trade.exitReason]}</td>
      <td
        className={cn(
          "px-[18px] py-3 text-right font-mono",
          trade.netPnl >= 0 ? "text-profit" : "text-loss",
        )}
      >
        {formatSignedMoney(trade.netPnl)}
      </td>
    </tr>
  );
}

function RunProvenance({ run }: { run: ValidationRunDetailDto["run"] }) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Provenance</CardTitle>
        <CardDescription>Данные, версия конфигурации и движок этого результата.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-x-8 py-1 xl:grid-cols-2">
        <div>
          <DetailRow label="Run ID" value={run.id} mono />
          <DetailRow label="Engine" value={run.engineVersion} mono />
          <DetailRow label="Config hash" value={run.configHash} mono />
          <DetailRow label="Dataset ID" value={run.datasetId} mono />
          {run.datasetSnapshot ? (
            <DetailRow label="Dataset hash" value={run.datasetSnapshot.contentHash} mono />
          ) : null}
        </div>
        <div>
          <DetailRow
            label="Источник"
            value={run.datasetSnapshot?.source ?? "Ожидает материализации"}
            mono
          />
          <DetailRow
            label="Пары"
            value={(run.datasetSnapshot?.symbols ?? run.input.dataset.symbols).join(", ")}
            mono
          />
          <DetailRow
            label="Таймфрейм"
            value={run.datasetSnapshot?.timeframe ?? run.input.dataset.timeframe}
          />
          {run.datasetSnapshot ? (
            <>
              <DetailRow
                label="Фактический период"
                value={`${formatDateTime(run.datasetSnapshot.startsAt)} — ${formatDateTime(run.datasetSnapshot.endsAt)}`}
              />
              <DetailRow
                label="Свечей"
                value={run.datasetSnapshot.candleCount.toLocaleString("ru-RU")}
                mono
              />
            </>
          ) : null}
          <DetailRow label="Капитал" value={`${run.input.initialCapital} USDT`} mono />
          <DetailRow label="Завершён" value={formatDateTime(run.completedAt)} />
        </div>
      </CardContent>
    </Card>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 border-b border-row-border last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 break-all text-right text-xs", mono && "font-mono text-[10px]")}>
        {value}
      </span>
    </div>
  );
}

function RunBadge({ run }: { run: ValidationRunDto }) {
  const content =
    run.status === "completed" ? verdictContent[run.verdict] : statusContent[run.status];
  return <Badge variant={content.variant}>{content.label}</Badge>;
}

function BackToValidation() {
  return (
    <Link
      to="/validation"
      className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      Validation Center
    </Link>
  );
}

function ValidationRunSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-5 w-36" />
      <Skeleton className="h-24" />
      <div className="grid grid-cols-6 gap-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-[360px]" />
    </div>
  );
}

type BadgeVariant = "secondary" | "profit" | "loss" | "warning" | "outline";

const statusContent: Record<ValidationRunDto["status"], { label: string; variant: BadgeVariant }> =
  {
    queued: { label: "В очереди", variant: "outline" },
    running: { label: "Выполняется", variant: "warning" },
    completed: { label: "Завершена", variant: "profit" },
    failed: { label: "Ошибка", variant: "loss" },
    cancelled: { label: "Отменена", variant: "secondary" },
  };

const verdictContent: Record<
  ValidationRunDto["verdict"],
  { label: string; variant: BadgeVariant }
> = {
  pending: { label: "Ожидает", variant: "outline" },
  passed: { label: "Пройдена", variant: "profit" },
  failed: { label: "Не пройдена", variant: "loss" },
  warning: { label: "Есть замечания", variant: "warning" },
};

const verdictLabels: Record<ValidationRunDto["verdict"], string> = {
  pending: "Ожидает",
  passed: "Пройдена",
  failed: "Не пройдена",
  warning: "Есть замечания",
};

const kindLabels: Record<ValidationRunDto["kind"], string> = {
  backtest: "Backtest",
  "walk-forward": "Walk-forward",
  holdout: "Holdout",
};

const exitReasonLabels: Record<ValidationTradeResultDto["exitReason"], string> = {
  "stop-loss": "Stop-loss",
  "take-profit": "Take-profit",
  "trailing-stop": "Trailing stop",
  "end-of-data": "Конец данных",
};

function formatMoney(value: number): string {
  return `${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} USDT`;
}

function formatSignedMoney(value: number): string {
  return `${value >= 0 ? "+" : "−"}${formatMoney(Math.abs(value))}`;
}

function formatSignedPercent(value: number): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;
}

function formatProfitFactor(value: number | null): string {
  return value === null ? "∞" : value.toFixed(2);
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 8 }).format(value);
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("ru-RU");
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
