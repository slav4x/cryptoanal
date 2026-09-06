import type { ValidationRunDto } from "@cryptoanal/contracts";
import {
  Badge,
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
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiClientError, fetchValidations } from "../../shared/api";

export default function ValidationComparePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const validationsQuery = useQuery({
    queryKey: ["validations"],
    queryFn: fetchValidations,
  });

  if (validationsQuery.isPending) return <CompareSkeleton />;
  if (validationsQuery.isError) {
    return (
      <div className="space-y-[18px]">
        <BackToValidation />
        <ErrorState
          title="Не удалось загрузить запуски"
          description={validationsQuery.error.message}
          requestId={
            validationsQuery.error instanceof ApiClientError
              ? validationsQuery.error.requestId
              : undefined
          }
          onRetry={() => void validationsQuery.refetch()}
        />
      </div>
    );
  }

  const completed = validationsQuery.data.data.items.filter(
    (run): run is ValidationRunDto & { metrics: NonNullable<ValidationRunDto["metrics"]> } =>
      run.status === "completed" && run.metrics !== null,
  );
  const requestedIds = (searchParams.get("runs") ?? "").split(",").filter(Boolean);
  const selectedIds =
    requestedIds.length > 0
      ? requestedIds.filter((id) => completed.some((run) => run.id === id)).slice(0, 4)
      : completed.slice(0, 2).map((run) => run.id);
  const selectedRuns = selectedIds.flatMap((id) => {
    const run = completed.find((candidate) => candidate.id === id);
    return run ? [run] : [];
  });

  function toggleRun(runId: string) {
    const next = selectedIds.includes(runId)
      ? selectedIds.filter((id) => id !== runId)
      : selectedIds.length < 4
        ? [...selectedIds, runId]
        : selectedIds;
    setSearchParams(next.length > 0 ? { runs: next.join(",") } : {});
  }

  return (
    <div className="space-y-[18px]">
      <BackToValidation />
      <PageHeader
        eyebrow="Validation compare"
        title="Сравнение запусков"
        description="Сопоставление результатов immutable версий и датасетов без ручного копирования метрик."
        actions={<Badge variant="outline">до 4 запусков</Badge>}
      />

      {completed.length < 2 ? (
        <Card>
          <EmptyState
            title="Нужно минимум два завершённых запуска"
            description="Завершите ещё одну проверку, чтобы сравнить версии, периоды или execution settings."
          />
        </Card>
      ) : (
        <>
          <RunSelector runs={completed} selectedIds={selectedIds} onToggle={toggleRun} />
          {selectedRuns.length < 2 ? (
            <Card>
              <EmptyState
                title="Выберите второй запуск"
                description="Для сравнения отметьте от двух до четырёх результатов."
              />
            </Card>
          ) : (
            <ComparisonTable runs={selectedRuns} />
          )}
        </>
      )}
    </div>
  );
}

function RunSelector({
  runs,
  selectedIds,
  onToggle,
}: {
  runs: Array<ValidationRunDto & { metrics: NonNullable<ValidationRunDto["metrics"]> }>;
  selectedIds: string[];
  onToggle: (runId: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Запуски</CardTitle>
        <CardDescription>
          Выберите 2–4 результата. Порядок выбора задаёт порядок колонок.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 pt-4 xl:grid-cols-2">
        {runs.map((run) => {
          const selected = selectedIds.includes(run.id);
          const disabled = !selected && selectedIds.length >= 4;
          return (
            <label
              key={run.id}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-[10px] border px-3 py-3",
                selected ? "border-info/50 bg-info/5" : "border-row-border hover:bg-row-hover",
                disabled && "cursor-not-allowed opacity-45",
              )}
            >
              <input
                type="checkbox"
                checked={selected}
                disabled={disabled}
                onChange={() => onToggle(run.id)}
                className="size-4 accent-white"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">
                  {run.strategy.name} · v{run.strategyVersion.version}
                </span>
                <span className="mt-1 block text-[10px] text-stale">
                  {formatDate(run.completedAt)} · {kindLabels[run.kind]} ·{" "}
                  {run.input.dataset.timeframe}
                </span>
              </span>
              <Badge variant={verdictVariant[run.verdict]}>{verdictLabels[run.verdict]}</Badge>
            </label>
          );
        })}
      </CardContent>
    </Card>
  );
}

function ComparisonTable({
  runs,
}: {
  runs: Array<ValidationRunDto & { metrics: NonNullable<ValidationRunDto["metrics"]> }>;
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Метрики</CardTitle>
        <CardDescription>
          Все значения рассчитаны сохранённой версией validation engine.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full min-w-[820px] border-collapse text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
              <th className="w-44 px-[18px] py-3 font-medium">Показатель</th>
              {runs.map((run) => (
                <th key={run.id} className="min-w-44 px-3 py-3 font-medium">
                  <Link to={`/validation/${run.id}`} className="text-foreground hover:underline">
                    {run.strategy.name} · v{run.strategyVersion.version}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {comparisonRows.map((row) => (
              <tr key={row.label} className="border-t border-row-border">
                <td className="px-[18px] py-3 text-muted-foreground">{row.label}</td>
                {runs.map((run) => (
                  <td key={run.id} className="px-3 py-3 font-mono tabular-nums">
                    {row.render(run)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

const comparisonRows: Array<{
  label: string;
  render: (
    run: ValidationRunDto & { metrics: NonNullable<ValidationRunDto["metrics"]> },
  ) => ReactNode;
}> = [
  {
    label: "Период",
    render: (run) =>
      `${formatDay(run.input.dataset.startDate)} — ${formatDay(run.input.dataset.endDate)}`,
  },
  { label: "Пары", render: (run) => run.input.dataset.symbols.join(", ") },
  { label: "Тип", render: (run) => kindLabels[run.kind] },
  {
    label: "Net PnL",
    render: (run) => <ToneValue value={run.metrics.netPnl} suffix=" USDT" />,
  },
  {
    label: "Доходность",
    render: (run) => <ToneValue value={run.metrics.returnPercent} suffix="%" />,
  },
  { label: "Max drawdown", render: (run) => `${run.metrics.maxDrawdownPercent.toFixed(2)}%` },
  {
    label: "Profit factor",
    render: (run) =>
      run.metrics.profitFactor === null ? "∞" : run.metrics.profitFactor.toFixed(2),
  },
  { label: "Win rate", render: (run) => `${run.metrics.winRatePercent.toFixed(1)}%` },
  { label: "Сделки", render: (run) => run.metrics.trades.toLocaleString("ru-RU") },
  {
    label: "Expectancy",
    render: (run) => <ToneValue value={run.metrics.expectancy} suffix=" USDT" />,
  },
  { label: "Комиссии", render: (run) => `${run.metrics.totalFees.toFixed(2)} USDT` },
  { label: "Свечи", render: (run) => run.metrics.candleCount.toLocaleString("ru-RU") },
  { label: "Окна", render: (run) => run.metrics.windows.toLocaleString("ru-RU") },
  { label: "Не пройдено gates", render: (run) => run.metrics.gateReasons.length },
];

function ToneValue({ value, suffix }: { value: number; suffix: string }) {
  return (
    <span className={value >= 0 ? "text-profit" : "text-loss"}>
      {value >= 0 ? "+" : "−"}
      {Math.abs(value).toFixed(2)}
      {suffix}
    </span>
  );
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

function CompareSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-5 w-36" />
      <Skeleton className="h-24" />
      <Skeleton className="h-44" />
      <Skeleton className="h-[480px]" />
    </div>
  );
}

const kindLabels: Record<ValidationRunDto["kind"], string> = {
  backtest: "Backtest",
  "walk-forward": "Walk-forward",
  holdout: "Holdout",
};

const verdictLabels: Record<ValidationRunDto["verdict"], string> = {
  pending: "Ожидает",
  passed: "Пройдена",
  failed: "Не пройдена",
  warning: "Замечания",
};

const verdictVariant: Record<
  ValidationRunDto["verdict"],
  "outline" | "profit" | "loss" | "warning"
> = {
  pending: "outline",
  passed: "profit",
  failed: "loss",
  warning: "warning",
};

function formatDate(value: string | null): string {
  return value
    ? new Date(value).toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";
}

function formatDay(value: string): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "short",
  });
}
