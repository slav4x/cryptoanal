import type {
  SystemLogDto,
  SystemLogLevel,
  SystemLogPeriod,
  SystemLogsQueryDto,
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
  FieldLabel,
  Input,
  MetricCard,
  PageHeader,
  Select,
  Skeleton,
  cn,
} from "@cryptoanal/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Radio,
  Search,
  TerminalSquare,
} from "lucide-react";
import { useState } from "react";
import { ApiClientError, fetchSystemLogs } from "../../shared/api";

export default function SystemLogsPage() {
  const [filters, setFilters] = useState<SystemLogsQueryDto>({ period: "24h", limit: 50 });
  const [live, setLive] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ["system-logs", filters],
    queryFn: ({ pageParam }) => fetchSystemLogs(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.data.nextCursor ?? undefined,
    refetchInterval: live ? 5_000 : false,
    refetchIntervalInBackground: false,
  });

  if (query.isPending) return <LogsSkeleton />;
  if (query.isError)
    return (
      <div className="space-y-[18px]">
        <PageHeader title="Системные логи" description="Техническая диагностика сервисов." />
        <ErrorState
          description={query.error.message}
          requestId={query.error instanceof ApiClientError ? query.error.requestId : undefined}
          onRetry={() => void query.refetch()}
        />
      </div>
    );

  const firstPage = query.data.pages[0]!;
  const logs = query.data.pages.flatMap((page) => page.data.items);
  const { summary, filterOptions } = firstPage.data;
  return (
    <div className="space-y-[18px]">
      <PageHeader
        eyebrow="Система"
        title="Системные логи"
        description="Структурированные события сервисов. Активность и бизнес-аудит остаются отдельными потоками."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant={live ? "secondary" : "ghost"}
              aria-pressed={live}
              onClick={() => setLive((value) => !value)}
            >
              <Radio className={cn("size-4", live && "text-profit")} />
              {live ? "Автообновление: вкл." : "Автообновление"}
            </Button>
            <Button variant="secondary" onClick={() => void query.refetch()}>
              <RefreshCw className={cn("size-4", query.isRefetching && "animate-spin")} />
              Обновить
            </Button>
          </div>
        }
      />

      <div className="grid gap-3 xl:grid-cols-4">
        <MetricCard
          label="Событий"
          value={String(summary.total)}
          hint={periodLabels[filters.period]}
        />
        <MetricCard
          label="Предупреждения"
          value={String(summary.warnings)}
          hint="Требуют внимания"
          tone={summary.warnings > 0 ? "warning" : "neutral"}
        />
        <MetricCard
          label="Ошибки"
          value={String(summary.errors)}
          hint="Ошибки и критические"
          tone={summary.errors > 0 ? "loss" : "neutral"}
        />
        <MetricCard
          label="Сервисов"
          value={String(summary.services)}
          hint={filterOptions.services.join(" · ") || "Нет данных"}
        />
      </div>

      <Card>
        <CardContent className="grid gap-3 pt-4 xl:grid-cols-[1.2fr_repeat(3,minmax(160px,0.6fr))]">
          <label className="space-y-1.5">
            <FieldLabel>Поиск</FieldLabel>
            <span className="relative block">
              <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-stale" />
              <Input
                className="pl-9"
                value={filters.query ?? ""}
                placeholder="Событие, сообщение, correlation id"
                onChange={(event) => updateFilters({ query: event.target.value || undefined })}
              />
            </span>
          </label>
          <FilterSelect
            label="Период"
            value={filters.period}
            options={Object.entries(periodLabels).map(([value, label]) => ({ value, label }))}
            onChange={(period) => updateFilters({ period: period as SystemLogPeriod })}
          />
          <FilterSelect
            label="Уровень"
            value={filters.level ?? ""}
            options={[
              { value: "", label: "Все уровни" },
              ...filterOptions.levels.map((level) => ({
                value: level,
                label: levelLabels[level],
              })),
            ]}
            onChange={(level) =>
              updateFilters({ level: level ? (level as SystemLogLevel) : undefined })
            }
          />
          <FilterSelect
            label="Сервис"
            value={filters.service ?? ""}
            options={[
              { value: "", label: "Все сервисы" },
              ...filterOptions.services.map((service) => ({ value: service, label: service })),
            ]}
            onChange={(service) => updateFilters({ service: service || undefined })}
          />
        </CardContent>
        {filters.correlationId ? (
          <div className="flex items-center justify-between border-t border-row-border px-4 py-2.5">
            <span className="font-mono text-[11px] text-muted-foreground">
              correlation: {filters.correlationId}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => updateFilters({ correlationId: undefined })}
            >
              Сбросить
            </Button>
          </div>
        ) : null}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-start justify-between border-b">
          <div>
            <CardTitle>Поток событий</CardTitle>
            <CardDescription>
              Обновлено {formatDateTime(firstPage.meta.generatedAt)} · тело запроса, заголовки и
              cookies не сохраняются
            </CardDescription>
          </div>
          {live ? (
            <Badge variant="profit">каждые 5 сек</Badge>
          ) : (
            <Badge variant="outline">вручную</Badge>
          )}
        </CardHeader>
        {logs.length > 0 ? (
          <div className="divide-y divide-row-border">
            {logs.map((log) => (
              <LogRow
                key={log.id}
                log={log}
                onCorrelation={(correlationId) => updateFilters({ correlationId })}
              />
            ))}
          </div>
        ) : (
          <CardContent className="grid min-h-56 place-items-center text-center">
            <div>
              <TerminalSquare className="mx-auto mb-3 size-7 text-stale" />
              <p className="text-sm">Событий по выбранным фильтрам нет.</p>
              <p className="mt-1 text-xs text-stale">
                Технические события появятся после команд или ошибок API.
              </p>
            </div>
          </CardContent>
        )}
      </Card>

      {query.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            <ArrowDown className="size-4" />
            {query.isFetchingNextPage ? "Загрузка…" : "Показать более ранние"}
          </Button>
        </div>
      ) : null}
    </div>
  );

  function updateFilters(patch: Partial<SystemLogsQueryDto>) {
    setFilters((current) => ({ ...current, ...patch }));
  }
}

function LogRow({
  log,
  onCorrelation,
}: {
  log: SystemLogDto;
  onCorrelation: (correlationId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        className="grid w-full grid-cols-[18px_82px_76px_minmax(180px,0.65fr)_minmax(260px,1.35fr)_180px] items-center gap-3 px-4 py-3 text-left text-xs transition-colors hover:bg-row-hover"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 text-stale" />
        ) : (
          <ChevronRight className="size-3.5 text-stale" />
        )}
        <LevelBadge level={log.level} />
        <span className="font-mono text-[11px] text-muted-foreground">{log.service}</span>
        <span className="truncate font-medium" title={log.event}>
          {log.event}
        </span>
        <span className="truncate text-muted-foreground" title={log.message}>
          {log.message}
        </span>
        <span className="text-right font-mono text-[10px] text-stale">
          {formatDateTime(log.createdAt)}
        </span>
      </button>
      {expanded ? (
        <div className="grid gap-4 border-t border-row-border bg-background/45 px-10 py-3.5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div>
            <FieldLabel>Метаданные</FieldLabel>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-[8px] border border-row-border bg-background p-3 font-mono text-[11px] leading-5 text-muted-foreground">
              {log.metadata ? JSON.stringify(log.metadata, null, 2) : "Метаданные отсутствуют"}
            </pre>
          </div>
          <div>
            <FieldLabel>Correlation ID</FieldLabel>
            {log.correlationId ? (
              <button
                type="button"
                className="mt-2 break-all text-left font-mono text-[11px] text-info hover:underline"
                onClick={() => onCorrelation(log.correlationId!)}
              >
                {log.correlationId}
              </button>
            ) : (
              <p className="mt-2 text-xs text-stale">Не задан</p>
            )}
            <p className="mt-4 text-xs leading-5 text-stale">
              Чувствительные ключи и значения скрываются при записи и повторно при выдаче.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LevelBadge({ level }: { level: SystemLogLevel }) {
  const variant =
    level === "critical" || level === "error"
      ? "loss"
      : level === "warning"
        ? "warning"
        : level === "info"
          ? "default"
          : "outline";
  return <Badge variant={variant}>{levelLabels[level]}</Badge>;
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-1.5">
      <FieldLabel>{label}</FieldLabel>
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </label>
  );
}

function LogsSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-20" />
      <div className="grid gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-20" />
      <Skeleton className="h-[520px]" />
    </div>
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

const periodLabels: Record<SystemLogPeriod, string> = {
  "1h": "Последний час",
  "24h": "Последние 24 часа",
  "7d": "Последние 7 дней",
  "30d": "Последние 30 дней",
  all: "За всё время",
};

const levelLabels: Record<SystemLogLevel, string> = {
  debug: "debug",
  info: "info",
  warning: "warning",
  error: "error",
  critical: "critical",
};
