import type {
  ActivityAction,
  ActivityDto,
  ActivityPeriod,
  ActivityQueryDto,
} from "@cryptoanal/contracts";
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
  PageHeader,
  Skeleton,
  cn,
} from "@cryptoanal/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowDown, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiClientError, fetchActivity } from "../../shared/api";

export default function ActivityPage() {
  const [filters, setFilters] = useState<ActivityQueryDto>({ period: "24h", limit: 30 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activityQuery = useInfiniteQuery({
    queryKey: ["activity", filters],
    queryFn: ({ pageParam }) => fetchActivity(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.data.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });

  if (activityQuery.isPending) return <ActivitySkeleton />;
  if (activityQuery.isError) {
    return (
      <div className="space-y-[18px]">
        <PageHeader title="Активность" description="Объяснимые решения торгового контура." />
        <ErrorState
          description={activityQuery.error.message}
          requestId={
            activityQuery.error instanceof ApiClientError
              ? activityQuery.error.requestId
              : undefined
          }
          onRetry={() => void activityQuery.refetch()}
        />
      </div>
    );
  }

  const firstPage = activityQuery.data.pages[0]!.data;
  const items = activityQuery.data.pages.flatMap((page) => page.data.items);
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;

  return (
    <div className="space-y-[18px]">
      <PageHeader
        eyebrow="Explainability"
        title="Активность"
        description="Хронология решений стратегии, причин и входных факторов каждого runtime-цикла."
        actions={<Badge variant="outline">product audit trail</Badge>}
      />

      <Card>
        <CardContent className="grid gap-3 pt-4 xl:grid-cols-5">
          <FilterSelect
            label="Период"
            value={filters.period}
            options={periodOptions}
            onChange={(period) => updateFilters({ period })}
          />
          <FilterSelect
            label="Действие"
            value={filters.action ?? ""}
            options={[
              { value: "", label: "Все действия" },
              ...firstPage.filterOptions.actions.map((action) => ({
                value: action,
                label: actionLabels[action],
              })),
            ]}
            onChange={(action) =>
              updateFilters({ action: action ? (action as ActivityAction) : undefined })
            }
          />
          <FilterSelect
            label="Стратегия"
            value={filters.strategyId ?? ""}
            options={[
              { value: "", label: "Все стратегии" },
              ...firstPage.filterOptions.strategies.map((strategy) => ({
                value: strategy.id,
                label: strategy.name,
              })),
            ]}
            onChange={(strategyId) => updateFilters({ strategyId: strategyId || undefined })}
          />
          <FilterSelect
            label="Пара"
            value={filters.symbol ?? ""}
            options={[
              { value: "", label: "Все пары" },
              ...firstPage.filterOptions.symbols.map((symbol) => ({
                value: symbol,
                label: symbol,
              })),
            ]}
            onChange={(symbol) => updateFilters({ symbol: symbol || undefined })}
          />
          <FilterSelect
            label="Причина"
            value={filters.reasonCode ?? ""}
            options={[
              { value: "", label: "Все причины" },
              ...firstPage.filterOptions.reasonCodes.map((reasonCode) => ({
                value: reasonCode,
                label: reasonCode,
              })),
            ]}
            onChange={(reasonCode) => updateFilters({ reasonCode: reasonCode || undefined })}
          />
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          label="Всего решений"
          value={String(firstPage.summary.total)}
          hint={periodLabel[filters.period]}
        />
        <MetricCard
          label="Входы"
          value={String(firstPage.summary.open)}
          hint="OPEN"
          tone="profit"
        />
        <MetricCard label="Выходы" value={String(firstPage.summary.close)} hint="CLOSE" />
        <MetricCard
          label="Пропуски"
          value={String(firstPage.summary.skip)}
          hint={`${firstPage.summary.hold} HOLD`}
        />
        <MetricCard
          label="Ошибки"
          value={String(firstPage.summary.error)}
          hint="ERROR"
          tone={firstPage.summary.error > 0 ? "loss" : "neutral"}
        />
      </div>

      <div className="grid items-start gap-3 xl:grid-cols-[minmax(520px,1.15fr)_minmax(380px,0.85fr)]">
        <Card>
          <CardHeader className="flex-row items-start justify-between border-b">
            <div>
              <CardTitle>Лента решений</CardTitle>
              <CardDescription>Новые события сверху, без raw system logs.</CardDescription>
            </div>
            <Badge variant="outline">{items.length} загружено</Badge>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {items.length === 0 ? (
              <p className="px-4 py-14 text-center text-sm text-muted-foreground">
                Решений по выбранным фильтрам пока нет.
              </p>
            ) : (
              <div>
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={cn(
                      "grid w-full grid-cols-[86px_minmax(0,1fr)_auto] items-start gap-3 border-t border-row-border px-4 py-3 text-left first:border-t-0 hover:bg-row-hover",
                      selected?.id === item.id && "bg-row-hover",
                    )}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className="font-mono text-[10px] leading-5 text-stale">
                      {formatTime(item.decidedAt)}
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-[12px] font-medium">{item.symbol}</span>
                        <span className="truncate text-[11px] text-stale">
                          {item.strategy.name} · v{item.strategy.version}
                        </span>
                      </span>
                      <span className="mt-1 block truncate text-[13px] text-secondary-foreground">
                        {item.summary}
                      </span>
                      <span className="mt-1 block font-mono text-[10px] text-stale">
                        {item.reasonCode}
                      </span>
                    </span>
                    <ActionBadge action={item.action} />
                  </button>
                ))}
                {activityQuery.hasNextPage ? (
                  <div className="border-t border-row-border p-3 text-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={activityQuery.isFetchingNextPage}
                      onClick={() => void activityQuery.fetchNextPage()}
                    >
                      <ArrowDown className="size-3.5" />
                      {activityQuery.isFetchingNextPage ? "Загрузка…" : "Загрузить ещё"}
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>

        {selected ? <DecisionDetails decision={selected} /> : <EmptyDecisionDetails />}
      </div>
    </div>
  );

  function updateFilters(patch: Partial<ActivityQueryDto>) {
    setSelectedId(null);
    setFilters((current) => ({ ...current, ...patch }));
  }
}

function DecisionDetails({ decision }: { decision: ActivityDto["items"][number] }) {
  const factors = flattenFactors(decision.factors);
  return (
    <Card className="xl:sticky xl:top-[18px]">
      <CardHeader className="border-b">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{decision.symbol} · решение</CardTitle>
            <CardDescription>{formatDateTime(decision.decidedAt)}</CardDescription>
          </div>
          <ActionBadge action={decision.action} />
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-4">
        <div>
          <p className="text-sm leading-6">{decision.summary}</p>
          <p className="mt-1 font-mono text-[11px] text-stale">{decision.reasonCode}</p>
        </div>

        <section>
          <h3 className="text-[10px] uppercase tracking-[0.1em] text-stale">Факторы</h3>
          <div className="mt-2 rounded-[10px] border border-row-border px-3">
            {factors.length === 0 ? (
              <p className="py-3 text-xs text-muted-foreground">Факторы не сохранены.</p>
            ) : (
              factors.map((factor) => (
                <DetailRow key={factor.label} label={factor.label} value={factor.value} mono />
              ))
            )}
          </div>
        </section>

        <section>
          <h3 className="text-[10px] uppercase tracking-[0.1em] text-stale">Provenance</h3>
          <div className="mt-2 rounded-[10px] border border-row-border px-3">
            <DetailRow
              label="Стратегия"
              value={`${decision.strategy.name} · v${decision.strategy.version}`}
            />
            <DetailRow label="Контур" value={decision.execution.environment} mono />
            <DetailRow label="Run ID" value={shortId(decision.execution.runId)} mono />
            <DetailRow label="Correlation" value={decision.correlationId} mono wrap />
            <DetailRow label="Market ref" value={decision.marketSnapshotRef ?? "—"} mono wrap />
            <DetailRow label="Position" value={shortId(decision.links.positionId)} mono />
            <DetailRow label="Trade" value={shortId(decision.links.tradeId)} mono />
          </div>
        </section>

        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary" size="sm">
            <Link to={`/markets/${decision.symbol}`}>
              Пара
              <ExternalLink className="size-3.5" />
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm">
            <Link to={`/runtime?deployment=${decision.execution.deploymentId}`}>
              Runtime
              <ExternalLink className="size-3.5" />
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm">
            <Link to={`/strategies/${decision.strategy.id}`}>
              Стратегия
              <ExternalLink className="size-3.5" />
            </Link>
          </Button>
          {decision.links.tradeId ? (
            <Button asChild variant="secondary" size="sm">
              <Link to={`/trades/${decision.links.tradeId}`}>
                Сделка
                <ExternalLink className="size-3.5" />
              </Link>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyDecisionDetails() {
  return (
    <Card>
      <CardContent className="grid min-h-64 place-items-center text-sm text-muted-foreground">
        Выберите решение в ленте.
      </CardContent>
    </Card>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
  wrap = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 border-b border-row-border last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-right text-xs text-secondary-foreground",
          mono && "font-mono text-[10px]",
          wrap && "min-w-0 break-all",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <label className="space-y-1.5">
      <span className="block text-[10px] uppercase tracking-[0.1em] text-stale">{label}</span>
      <select
        value={value}
        className="h-9 w-full rounded-[9px] border border-input bg-background px-3 text-[13px] text-secondary-foreground outline-none focus:border-ring"
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ActionBadge({ action }: { action: ActivityAction }) {
  const variant =
    action === "open"
      ? "profit"
      : action === "close"
        ? "default"
        : action === "error"
          ? "loss"
          : action === "skip"
            ? "warning"
            : "outline";
  return <Badge variant={variant}>{action.toUpperCase()}</Badge>;
}

function flattenFactors(
  value: Record<string, unknown>,
  prefix = "",
): Array<{ label: string; value: string }> {
  return Object.entries(value).flatMap(([key, entry]) => {
    const label = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return flattenFactors(entry as Record<string, unknown>, label);
    }
    return [{ label, value: formatFactor(entry) }];
  });
}

function formatFactor(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    return value.toLocaleString("ru-RU", { maximumFractionDigits: 8 });
  }
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function shortId(value: string | null): string {
  return value ? value.slice(0, 8) : "—";
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ActivitySkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-16" />
      <Skeleton className="h-20" />
      <div className="grid gap-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <Skeleton className="h-[520px]" />
        <Skeleton className="h-[520px]" />
      </div>
    </div>
  );
}

const periodOptions: Array<{ value: ActivityPeriod; label: string }> = [
  { value: "24h", label: "24 часа" },
  { value: "7d", label: "7 дней" },
  { value: "30d", label: "30 дней" },
  { value: "all", label: "Всё время" },
];

const periodLabel: Record<ActivityPeriod, string> = {
  "24h": "За 24 часа",
  "7d": "За 7 дней",
  "30d": "За 30 дней",
  all: "За всё время",
};

const actionLabels: Record<ActivityAction, string> = {
  open: "Входы",
  close: "Выходы",
  hold: "Удержание",
  skip: "Пропуски",
  error: "Ошибки",
};
