import type { HealthDashboardDto, HealthLevel } from "@cryptoanal/contracts";
import {
  Badge,
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
import { useQuery } from "@tanstack/react-query";
import { ApiClientError, fetchHealthDashboard } from "../../shared/api";

export default function HealthPage() {
  const healthQuery = useQuery({
    queryKey: ["health-dashboard"],
    queryFn: fetchHealthDashboard,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  if (healthQuery.isPending) return <HealthSkeleton />;
  if (healthQuery.isError) {
    return (
      <div className="space-y-[18px]">
        <PageHeader title="Здоровье системы" description="Operational health и watchdog." />
        <ErrorState
          description={healthQuery.error.message}
          requestId={
            healthQuery.error instanceof ApiClientError ? healthQuery.error.requestId : undefined
          }
          onRetry={() => void healthQuery.refetch()}
        />
      </div>
    );
  }

  const { data, meta } = healthQuery.data;
  const openIncidents = data.incidents.filter((incident) => incident.status === "open");
  const resolvedIncidents = data.incidents.filter((incident) => incident.status === "resolved");

  return (
    <div className="space-y-[18px]">
      <PageHeader
        eyebrow="Analytics"
        title="Здоровье системы"
        description="Свежесть данных, execution-контур, watchdog и отклонение от validated baseline."
        actions={<StatusBadge status={data.overallStatus} />}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Общий статус"
          value={overallLabels[data.overallStatus]}
          hint={`Проверено ${formatDateTime(data.checkedAt)}`}
          tone={data.overallStatus === "healthy" ? "profit" : "loss"}
        />
        <MetricCard
          label="Открытые инциденты"
          value={String(openIncidents.length)}
          hint={`${openIncidents.filter((incident) => incident.severity === "critical").length} критических`}
          tone={openIncidents.length > 0 ? "loss" : "neutral"}
        />
        <MetricCard
          label="Watchdog"
          value={data.watchdogLastSeenAt ? "Активен" : "Нет сигнала"}
          hint={
            data.watchdogLastSeenAt
              ? `Цикл ${formatRelative(data.watchdogLastSeenAt)}`
              : "Heartbeat ещё не записан"
          }
          tone={data.watchdogLastSeenAt ? "profit" : "loss"}
        />
        <MetricCard
          label="Risk stops · 24ч"
          value={String(data.notices.riskStops24h)}
          hint={`${data.notices.failedJobs24h} failed jobs · ${data.notices.rejectedOrders24h} rejected`}
          tone={data.notices.riskStops24h > 0 ? "loss" : "neutral"}
        />
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between border-b">
          <div>
            <CardTitle>Health domains</CardTitle>
            <CardDescription>
              Независимые сигналы готовности и устойчивости системы.
            </CardDescription>
          </div>
          <span className="text-xs text-stale">
            ответ {new Date(meta.generatedAt).toLocaleTimeString("ru-RU")}
          </span>
        </CardHeader>
        <CardContent className="grid gap-px bg-row-border p-px sm:grid-cols-2 xl:grid-cols-3">
          {data.domains.map((domain) => (
            <div key={domain.id} className="min-h-28 bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[13px] font-medium">{domain.label}</p>
                <StatusBadge status={domain.status} compact />
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{domain.summary}</p>
              <p className="mt-2 font-mono text-[10px] text-stale">
                {domain.observedAt ? formatDateTime(domain.observedAt) : "нет отдельной метки"}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between border-b">
          <div>
            <CardTitle>Drift относительно валидации</CardTitle>
            <CardDescription>
              Сравнение runtime с baseline запуска, зафиксированного в execution context.
            </CardDescription>
          </div>
          <Badge variant="outline">минимум 20 сделок</Badge>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {data.drift.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              Нет активного deployment с validated baseline.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] border-collapse text-[13px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Стратегия
                    </th>
                    <th scope="col" className="px-3 py-2.5 font-medium">
                      Статус
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">
                      Сделки
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">
                      Win rate
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">
                      Expectancy
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">
                      Profit factor
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">
                      Max DD
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.drift.map((item) => (
                    <tr key={item.executionRunId} className="border-t border-row-border">
                      <td className="px-4 py-3">
                        <p className="font-medium">{item.strategyName}</p>
                        <p className="mt-0.5 text-[10px] text-stale">v{item.strategyVersion}</p>
                      </td>
                      <td className="px-3 py-3">
                        <DriftBadge status={item.status} />
                      </td>
                      <td className="px-3 py-3 text-right font-mono">
                        {item.runtime.trades} / {item.minimumSampleSize}
                      </td>
                      <MetricComparison
                        current={`${formatNumber(item.runtime.winRatePercent)}%`}
                        baseline={`${formatNumber(item.baseline.winRatePercent)}%`}
                        delta={formatDelta(item.delta.winRatePercentagePoints, " п.п.")}
                      />
                      <MetricComparison
                        current={formatNumber(item.runtime.expectancy)}
                        baseline={formatNumber(item.baseline.expectancy)}
                        delta={formatNullablePercent(item.delta.expectancyPercent)}
                      />
                      <MetricComparison
                        current={formatNullable(item.runtime.profitFactor)}
                        baseline={formatNullable(item.baseline.profitFactor)}
                        delta={formatNullablePercent(item.delta.profitFactorPercent)}
                      />
                      <MetricComparison
                        current={`${formatNumber(item.runtime.maxDrawdownPercent)}%`}
                        baseline={`${formatNumber(item.baseline.maxDrawdownPercent)}%`}
                        delta={formatDelta(item.delta.maxDrawdownPercentagePoints, " п.п.")}
                        last
                      />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 xl:grid-cols-2">
        <IncidentCard
          title="Открытые инциденты"
          incidents={openIncidents}
          empty="Активных инцидентов нет."
        />
        <IncidentCard
          title="Недавние восстановленные"
          incidents={resolvedIncidents.slice(0, 20)}
          empty="История восстановлений пока пуста."
        />
      </div>
    </div>
  );
}

function IncidentCard({
  title,
  incidents,
  empty,
}: {
  title: string;
  incidents: HealthDashboardDto["incidents"];
  empty: string;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between border-b">
        <CardTitle>{title}</CardTitle>
        <Badge variant="outline">{incidents.length}</Badge>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {incidents.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">{empty}</p>
        ) : (
          incidents.map((incident) => (
            <div
              key={incident.id}
              className="border-t border-row-border px-4 py-3 first:border-t-0"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[13px] font-medium">{incident.title}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {incident.description}
                  </p>
                </div>
                <Badge variant={incident.severity === "critical" ? "loss" : "warning"}>
                  {incident.severity === "critical" ? "critical" : "warning"}
                </Badge>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-stale">
                <span>{incident.code}</span>
                <span>×{incident.occurrenceCount}</span>
                <span>{formatDateTime(incident.lastObservedAt)}</span>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function MetricComparison({
  current,
  baseline,
  delta,
  last = false,
}: {
  current: string;
  baseline: string;
  delta: string;
  last?: boolean;
}) {
  return (
    <td className={cn("px-3 py-3 text-right font-mono", last && "pr-4")}>
      <p className="text-secondary-foreground">{current}</p>
      <p className="mt-0.5 text-[10px] text-stale">
        {baseline} · {delta}
      </p>
    </td>
  );
}

function StatusBadge({ status, compact = false }: { status: HealthLevel; compact?: boolean }) {
  return (
    <Badge
      variant={
        status === "healthy"
          ? "profit"
          : status === "degraded"
            ? "warning"
            : status === "critical"
              ? "loss"
              : "outline"
      }
      className={compact ? "h-5 px-2 text-[9px]" : undefined}
    >
      {healthLabels[status]}
    </Badge>
  );
}

function DriftBadge({ status }: { status: HealthDashboardDto["drift"][number]["status"] }) {
  const variants = {
    "insufficient-data": "outline",
    "within-range": "profit",
    warning: "warning",
    critical: "loss",
  } as const;
  const labels = {
    "insufficient-data": "мало данных",
    "within-range": "в диапазоне",
    warning: "warning",
    critical: "critical",
  };
  return <Badge variant={variants[status]}>{labels[status]}</Badge>;
}

function HealthSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-16" />
      <div className="grid gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-80" />
      <Skeleton className="h-64" />
    </div>
  );
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatRelative(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1_000));
  return seconds < 60 ? `${seconds} сек. назад` : `${Math.floor(seconds / 60)} мин. назад`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

function formatNullable(value: number | null): string {
  return value === null ? "—" : formatNumber(value);
}

function formatNullablePercent(value: number | null): string {
  return value === null ? "—" : formatDelta(value, "%");
}

function formatDelta(value: number, suffix: string): string {
  return `${value > 0 ? "+" : ""}${formatNumber(value)}${suffix}`;
}

const healthLabels: Record<HealthLevel, string> = {
  healthy: "healthy",
  degraded: "degraded",
  critical: "critical",
  unknown: "нет данных",
};

const overallLabels: Record<HealthDashboardDto["overallStatus"], string> = {
  healthy: "В норме",
  degraded: "Отклонения",
  critical: "Критично",
};
