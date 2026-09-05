import {
  validationRunInputSchema,
  type StrategyDetailDto,
  type ValidationKindDto,
  type ValidationRunDto,
} from "@cryptoanal/contracts";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Skeleton,
  cn,
} from "@cryptoanal/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, LoaderCircle, Plus } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ApiClientError,
  fetchStrategies,
  fetchStrategyDetail,
  fetchValidations,
  queueValidationRun,
} from "../../shared/api";

export default function ValidationPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const strategiesQuery = useQuery({ queryKey: ["strategies"], queryFn: fetchStrategies });
  const validationsQuery = useQuery({
    queryKey: ["validations"],
    queryFn: fetchValidations,
    refetchInterval: 10_000,
  });

  if (strategiesQuery.isPending || validationsQuery.isPending) return <ValidationSkeleton />;
  if (strategiesQuery.isError || validationsQuery.isError) {
    const error = strategiesQuery.error ?? validationsQuery.error;
    return (
      <div className="space-y-[18px]">
        <PageHeader
          eyebrow="Validation"
          title="Validation Center"
          description="Проверки стратегий и состояние очереди."
        />
        <ErrorState
          description={error?.message ?? "Не удалось загрузить Validation Center"}
          requestId={error instanceof ApiClientError ? error.requestId : undefined}
          onRetry={() => {
            void strategiesQuery.refetch();
            void validationsQuery.refetch();
          }}
        />
      </div>
    );
  }

  const strategies = strategiesQuery.data.data.items;
  const requestedStrategyId = searchParams.get("strategy");
  const selectedStrategyId = strategies.some((strategy) => strategy.id === requestedStrategyId)
    ? requestedStrategyId!
    : (strategies[0]?.id ?? "");

  return (
    <div className="space-y-[18px]">
      <PageHeader
        eyebrow="Validation"
        title="Validation Center"
        description="Durable очередь backtest и walk-forward запусков с привязкой к immutable версии."
        actions={
          <Badge variant="outline">
            {validationsQuery.data.data.counts.queued + validationsQuery.data.data.counts.running} в
            работе
          </Badge>
        }
      />

      {strategies.length === 0 ? (
        <Card>
          <EmptyState
            title="Сначала создайте стратегию"
            description="Validation run всегда привязан к конкретной immutable версии стратегии."
          />
          <CardContent className="flex justify-center pb-8">
            <Button asChild>
              <Link to="/strategies/new">
                <Plus aria-hidden="true" />
                Создать стратегию
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid items-start gap-[18px] xl:grid-cols-[360px_minmax(0,1fr)]">
          <Card>
            <CardHeader className="border-b">
              <h2 className="text-sm font-medium">Новая проверка</h2>
              <p className="text-xs text-muted-foreground">Создаёт ValidationRun и durable job.</p>
            </CardHeader>
            <CardContent className="space-y-4 p-[18px]">
              <label className="block space-y-2 text-xs font-medium text-secondary-foreground">
                Стратегия
                <select
                  value={selectedStrategyId}
                  onChange={(event) => setSearchParams({ strategy: event.target.value })}
                  className={selectClassName}
                >
                  {strategies.map((strategy) => (
                    <option key={strategy.id} value={strategy.id}>
                      {strategy.name} ·{" "}
                      {strategy.latestVersion ? `v${strategy.latestVersion.version}` : "—"}
                    </option>
                  ))}
                </select>
              </label>
              <ValidationComposer key={selectedStrategyId} strategyId={selectedStrategyId} />
            </CardContent>
          </Card>

          <RunsTable runs={validationsQuery.data.data.items} />
        </div>
      )}
    </div>
  );
}

function ValidationComposer({ strategyId }: { strategyId: string }) {
  const strategyQuery = useQuery({
    queryKey: ["strategy", strategyId],
    queryFn: () => fetchStrategyDetail(strategyId),
    enabled: Boolean(strategyId),
  });

  if (strategyQuery.isPending) return <Skeleton className="h-72" />;
  if (strategyQuery.isError) {
    return <p className="text-sm text-loss">{strategyQuery.error.message}</p>;
  }

  return (
    <ValidationForm
      key={strategyQuery.data.data.latestVersion?.id}
      strategy={strategyQuery.data.data}
    />
  );
}

function ValidationForm({ strategy }: { strategy: StrategyDetailDto }) {
  const latestVersion = strategy.versions[0];
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<"backtest" | "walk-forward">("backtest");
  const [startDate, setStartDate] = useState(() => utcDateDaysAgo(365));
  const [endDate, setEndDate] = useState(() => utcDateDaysAgo(0));
  const [symbols, setSymbols] = useState(
    () => latestVersion?.config.universe.symbols.join(", ") ?? "",
  );
  const [initialCapital, setInitialCapital] = useState("10000");
  const [trainingDays, setTrainingDays] = useState("180");
  const [testDays, setTestDays] = useState("30");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [formError, setFormError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof queueValidationRun>[1]) =>
      queueValidationRun(strategy.id, input),
    onSuccess: () => {
      setIdempotencyKey(crypto.randomUUID());
      void queryClient.invalidateQueries({ queryKey: ["validations"] });
      void queryClient.invalidateQueries({ queryKey: ["strategy", strategy.id] });
      void queryClient.invalidateQueries({ queryKey: ["strategies"] });
    },
  });

  if (!latestVersion) return <p className="text-sm text-stale">У стратегии нет версии.</p>;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validationRunInputSchema.safeParse({
      strategyVersionId: latestVersion?.id,
      kind,
      dataset: {
        startDate,
        endDate,
        symbols: Array.from(
          new Set(
            symbols
              .split(/[\s,]+/)
              .map((symbol) => symbol.trim().toUpperCase())
              .filter(Boolean),
          ),
        ),
        timeframe: latestVersion?.config.universe.timeframe,
      },
      initialCapital,
      walkForward:
        kind === "walk-forward"
          ? { trainingDays: numberOrNaN(trainingDays), testDays: numberOrNaN(testDays) }
          : null,
      idempotencyKey,
    });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Проверьте параметры запуска");
      return;
    }
    setFormError(null);
    mutation.mutate(result.data);
  }

  const eligible = strategy.lifecycle.validation.eligible;

  return (
    <form className="space-y-4" onSubmit={handleSubmit} noValidate>
      <div className="rounded-[10px] border border-row-border bg-secondary/40 px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">Версия</span>
          <span className="font-mono text-xs">v{latestVersion.version}</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">Статус</span>
          <Badge variant={eligible ? "profit" : "warning"}>
            {eligible ? "Готова" : "Недоступна"}
          </Badge>
        </div>
      </div>

      {!eligible ? (
        <ul className="space-y-1 text-xs leading-5 text-warning">
          {strategy.lifecycle.validation.reasons.map((reason) => (
            <li key={reason}>— {reason}</li>
          ))}
        </ul>
      ) : null}

      <FormField label="Тип проверки">
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as typeof kind)}
          className={selectClassName}
        >
          <option value="backtest">Backtest</option>
          <option value="walk-forward">Walk-forward</option>
        </select>
      </FormField>

      <div className="grid grid-cols-2 gap-3">
        <FormField label="Начало">
          <Input
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </FormField>
        <FormField label="Окончание">
          <Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
        </FormField>
      </div>

      <FormField label="Торговые пары">
        <Input value={symbols} onChange={(event) => setSymbols(event.target.value.toUpperCase())} />
      </FormField>

      <div className="grid grid-cols-2 gap-3">
        <FormField label="Таймфрейм">
          <Input value={latestVersion.config.universe.timeframe} disabled />
        </FormField>
        <FormField label="Капитал, USDT">
          <Input
            type="number"
            min="0.01"
            step="0.01"
            value={initialCapital}
            onChange={(event) => setInitialCapital(event.target.value)}
          />
        </FormField>
      </div>

      {kind === "walk-forward" ? (
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Training, дней">
            <Input
              type="number"
              min="7"
              max="3650"
              value={trainingDays}
              onChange={(event) => setTrainingDays(event.target.value)}
            />
          </FormField>
          <FormField label="Test, дней">
            <Input
              type="number"
              min="1"
              max="365"
              value={testDays}
              onChange={(event) => setTestDays(event.target.value)}
            />
          </FormField>
        </div>
      ) : null}

      {formError || mutation.error ? (
        <p className="text-xs text-loss">
          {formError ??
            (mutation.error instanceof ApiClientError
              ? mutation.error.message
              : "Не удалось поставить проверку в очередь")}
        </p>
      ) : null}

      <Button type="submit" className="w-full" disabled={!eligible || mutation.isPending}>
        {mutation.isPending ? (
          <LoaderCircle className="animate-spin" aria-hidden="true" />
        ) : (
          <FlaskConical aria-hidden="true" />
        )}
        Поставить в очередь
      </Button>
    </form>
  );
}

function RunsTable({ runs }: { runs: ValidationRunDto[] }) {
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Запуски</h2>
          <Badge variant="outline">{runs.length}</Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {runs.length === 0 ? (
          <EmptyState
            title="Проверок пока нет"
            description="Настройте первый backtest или walk-forward запуск."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                  <th className="px-[18px] py-3 font-medium">Стратегия</th>
                  <th className="px-3 py-3 font-medium">Тип</th>
                  <th className="px-3 py-3 font-medium">Период</th>
                  <th className="px-3 py-3 font-medium">Статус</th>
                  <th className="px-[18px] py-3 text-right font-medium">Создан</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-t border-row-border hover:bg-row-hover">
                    <td className="px-[18px] py-3.5">
                      <Link
                        to={`/strategies/${run.strategy.id}`}
                        className="text-sm text-foreground hover:underline"
                      >
                        {run.strategy.name}
                      </Link>
                      <p className="mt-1 font-mono text-[10px] text-stale">
                        v{run.strategyVersion.version}
                      </p>
                    </td>
                    <td className="px-3 py-3.5">{kindLabels[run.kind]}</td>
                    <td className="px-3 py-3.5 text-muted-foreground">
                      {formatDate(run.input.dataset.startDate)} —{" "}
                      {formatDate(run.input.dataset.endDate)}
                    </td>
                    <td className="px-3 py-3.5">
                      <RunStatusBadge run={run} />
                    </td>
                    <td className="px-[18px] py-3.5 text-right text-muted-foreground">
                      {formatDateTime(run.queuedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RunStatusBadge({ run }: { run: ValidationRunDto }) {
  const content = runStatusContent[run.status];
  return <Badge variant={content.variant}>{content.label}</Badge>;
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-2 text-xs font-medium text-secondary-foreground">
      {label}
      {children}
    </label>
  );
}

function numberOrNaN(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

function utcDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("ru-RU");
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ValidationSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-24" />
      <div className="grid gap-[18px] xl:grid-cols-[360px_minmax(0,1fr)]">
        <Skeleton className="h-[620px]" />
        <Skeleton className="h-[420px]" />
      </div>
    </div>
  );
}

type BadgeVariant = "secondary" | "profit" | "loss" | "warning" | "outline";

const runStatusContent: Record<
  ValidationRunDto["status"],
  { label: string; variant: BadgeVariant }
> = {
  queued: { label: "В очереди", variant: "outline" },
  running: { label: "Выполняется", variant: "warning" },
  completed: { label: "Завершена", variant: "profit" },
  failed: { label: "Ошибка", variant: "loss" },
  cancelled: { label: "Отменена", variant: "secondary" },
};

const kindLabels: Record<ValidationKindDto, string> = {
  backtest: "Backtest",
  "walk-forward": "Walk-forward",
  holdout: "Holdout",
};

const selectClassName = cn(
  "h-9 w-full rounded-[10px] border border-input bg-background px-3 text-sm text-foreground outline-none",
  "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
);
