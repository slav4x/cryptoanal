import type {
  AnalyticsBreakdownDto,
  AnalyticsEnvironment,
  AnalyticsPeriod,
  AnalyticsQueryDto,
} from "@cryptoanal/contracts";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  cn,
} from "@cryptoanal/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiClientError, fetchAnalytics } from "../../shared/api";
import { formatMetricMoney, formatPercent } from "../../shared/format";
import { DrawdownChart } from "./DrawdownChart";
import { HoldingTimeDistribution, PnlDistribution } from "./DistributionCharts";
import { PerformanceChart } from "./PerformanceChart";
import { PnlCalendar } from "./PnlCalendar";

export default function AnalyticsPage() {
  const [filters, setFilters] = useState<AnalyticsQueryDto>({ period: "30d" });
  const analyticsQuery = useQuery({
    queryKey: ["analytics", filters],
    queryFn: () => fetchAnalytics(filters),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  if (analyticsQuery.isPending) return <AnalyticsSkeleton />;

  if (analyticsQuery.isError) {
    return (
      <div className="space-y-[18px]">
        <PageHeader
          title="Аналитика"
          description="Результаты торгового контура по закрытым сделкам."
        />
        <ErrorState
          description={analyticsQuery.error.message}
          requestId={
            analyticsQuery.error instanceof ApiClientError
              ? analyticsQuery.error.requestId
              : undefined
          }
          onRetry={() => void analyticsQuery.refetch()}
        />
      </div>
    );
  }

  const { data, meta } = analyticsQuery.data;
  const summary = data.summary;

  return (
    <div className="space-y-[18px]">
      <PageHeader
        title="Аналитика"
        description="Performance, просадка и структура результата по закрытым сделкам."
        actions={
          <span className="text-xs text-stale">
            обновлено {new Date(meta.generatedAt).toLocaleTimeString("ru-RU")}
          </span>
        }
      />

      <Card>
        <CardContent className="grid gap-3 pt-4 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
          <FilterSelect
            label="Период"
            value={filters.period}
            options={periodOptions}
            onChange={(period) => setFilters((current) => ({ ...current, period }))}
          />
          <FilterSelect
            label="Контур"
            value={filters.environment ?? ""}
            options={[
              { value: "", label: "Все контуры" },
              ...data.filterOptions.environments.map((environment) => ({
                value: environment,
                label: environmentLabels[environment],
              })),
            ]}
            onChange={(environment) =>
              setFilters((current) => ({
                ...current,
                environment: environment ? (environment as AnalyticsEnvironment) : undefined,
              }))
            }
          />
          <FilterSelect
            label="Стратегия"
            value={filters.strategyId ?? ""}
            options={[
              { value: "", label: "Все стратегии" },
              ...data.filterOptions.strategies.map((strategy) => ({
                value: strategy.id,
                label: strategy.name,
              })),
            ]}
            onChange={(strategyId) =>
              setFilters((current) => ({
                ...current,
                strategyId: strategyId || undefined,
              }))
            }
          />
          <FilterSelect
            label="Пара"
            value={filters.symbol ?? ""}
            options={[
              { value: "", label: "Все пары" },
              ...data.filterOptions.symbols.map((symbol) => ({ value: symbol, label: symbol })),
            ]}
            onChange={(symbol) =>
              setFilters((current) => ({ ...current, symbol: symbol || undefined }))
            }
          />
          <div className="flex items-end">
            <Badge variant={summary.trades > 0 ? "profit" : "outline"}>
              {summary.trades} сделок
            </Badge>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <MetricCard
          label="Net PnL"
          value={formatMetricMoney(summary.netPnl)}
          hint={`Gross ${formatMetricMoney(summary.grossPnl)}`}
          tone={metricTone(summary.netPnl)}
        />
        <MetricCard
          label="Win rate"
          value={formatPercent(String(summary.winRatePercent))}
          hint={`${summary.wins}W · ${summary.losses}L · ${summary.breakeven}BE`}
        />
        <MetricCard
          label="Profit factor"
          value={formatRatio(summary.profitFactor)}
          hint="Прибыль / убыток"
        />
        <MetricCard
          label="Max drawdown"
          value={`−${summary.maxDrawdownPercent.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%`}
          hint="От локального пика"
          tone={summary.maxDrawdownPercent > 0 ? "loss" : "neutral"}
        />
        <MetricCard
          label="Expectancy"
          value={formatMetricMoney(summary.expectancy)}
          hint="На одну сделку"
          tone={metricTone(summary.expectancy)}
        />
        <MetricCard
          label="Издержки"
          value={formatMetricMoney(totalCosts(data.summary))}
          hint={`Комиссии ${formatMetricMoney(summary.totalFees)}`}
        />
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between border-b">
          <div>
            <CardTitle>Кривая капитала</CardTitle>
            <CardDescription>
              Стартовый капитал {formatMetricMoney(data.initialCapital)} · закрытые сделки
            </CardDescription>
          </div>
          <span
            className={cn(
              "font-mono text-sm tabular-nums",
              Number(summary.netPnl) >= 0 ? "text-profit" : "text-loss",
            )}
          >
            {formatMetricMoney(summary.netPnl)}
          </span>
        </CardHeader>
        <CardContent className="p-0">
          <PerformanceChart points={data.equitySeries} />
        </CardContent>
      </Card>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.75fr)]">
        <Card>
          <CardHeader className="border-b">
            <CardTitle>Просадка</CardTitle>
            <CardDescription>Отклонение от предыдущего максимума капитала.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <DrawdownChart points={data.equitySeries} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="border-b">
            <CardTitle>PnL-календарь</CardTitle>
            <CardDescription>Результат закрытых сделок по дням.</CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            <PnlCalendar days={data.dailyPnl} period={filters.period} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        <BreakdownCard title="По стратегиям" items={data.breakdowns.strategies} />
        <BreakdownCard title="По парам" items={data.breakdowns.symbols} />
        <BreakdownCard
          title="По причинам выхода"
          items={data.breakdowns.exitReasons.map((item) => ({
            ...item,
            label: exitReasonLabels[item.label] ?? item.label,
          }))}
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader className="border-b">
            <CardTitle>Распределение результата</CardTitle>
            <CardDescription>Частота и суммарный Net PnL по диапазонам сделки.</CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            <PnlDistribution buckets={data.distributions.pnl} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="border-b">
            <CardTitle>Время в позиции</CardTitle>
            <CardDescription>Количество сделок и win rate по длительности.</CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            <HoldingTimeDistribution buckets={data.distributions.holdingTime} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <BreakdownCard
          title="По режиму рынка на входе"
          items={data.breakdowns.regimes.map((item) => ({
            ...item,
            label: regimeLabels[item.key] ?? item.label,
          }))}
        />
        <BreakdownCard
          title="По UTC-сессии входа"
          items={data.breakdowns.sessions.map((item) => ({
            ...item,
            label: sessionLabels[item.key] ?? item.label,
          }))}
        />
      </div>
    </div>
  );
}

type FilterSelectProps<T extends string> = {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
};

function FilterSelect<T extends string>({ label, value, options, onChange }: FilterSelectProps<T>) {
  return (
    <div className="space-y-1.5">
      <span className="block text-[10px] uppercase tracking-[0.1em] text-stale">{label}</span>
      <Select value={value} onValueChange={(nextValue) => onChange(nextValue as T)}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function BreakdownCard({ title, items }: { title: string; items: AnalyticsBreakdownDto[] }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between border-b">
        <CardTitle>{title}</CardTitle>
        <Badge variant="outline">{items.length}</Badge>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {items.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Нет данных.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[400px] border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Группа
                  </th>
                  <th scope="col" className="px-2 py-2.5 text-right font-medium">
                    Сделки
                  </th>
                  <th scope="col" className="px-2 py-2.5 text-right font-medium">
                    WR
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">
                    Net PnL
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.key} className="border-t border-row-border hover:bg-row-hover">
                    <td className="max-w-40 truncate px-4 py-2.5 font-medium" title={item.label}>
                      {item.label}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono text-stale">{item.trades}</td>
                    <td className="px-2 py-2.5 text-right font-mono text-secondary-foreground">
                      {item.winRatePercent.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%
                    </td>
                    <td
                      className={cn(
                        "px-4 py-2.5 text-right font-mono",
                        Number(item.netPnl) >= 0 ? "text-profit" : "text-loss",
                      )}
                    >
                      {formatMetricMoney(item.netPnl)}
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

function AnalyticsSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-20 w-full" />
      <div className="grid gap-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-[370px] w-full" />
      <div className="grid gap-3 xl:grid-cols-2">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
    </div>
  );
}

function totalCosts(summary: {
  totalFees: string;
  totalFunding: string;
  totalSlippage: string;
}): string {
  return String(
    Number(summary.totalFees) + Number(summary.totalFunding) + Number(summary.totalSlippage),
  );
}

function metricTone(value: string): "neutral" | "profit" | "loss" {
  const parsed = Number(value);
  return parsed > 0 ? "profit" : parsed < 0 ? "loss" : "neutral";
}

function formatRatio(value: number | null): string {
  return value === null
    ? "—"
    : value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const periodOptions: Array<{ value: AnalyticsPeriod; label: string }> = [
  { value: "7d", label: "7 дней" },
  { value: "30d", label: "30 дней" },
  { value: "90d", label: "90 дней" },
  { value: "all", label: "Всё время" },
];

const environmentLabels: Record<AnalyticsEnvironment, string> = {
  "dry-run": "Dry-run",
  demo: "Demo",
  live: "Live",
};

const exitReasonLabels: Record<string, string> = {
  "signal-exit": "Сигнал возврата к средней",
  TAKE_PROFIT: "Take profit",
  STOP_LOSS: "Stop loss",
  MANUAL: "Ручное закрытие",
  STRATEGY_EXIT: "Сигнал стратегии",
  DEPLOYMENT_STOP: "Остановка deployment",
};

const regimeLabels: Record<string, string> = {
  bull: "Бычий",
  bear: "Медвежий",
  neutral: "Нейтральный",
  unknown: "Нет данных",
};

const sessionLabels: Record<string, string> = {
  asia: "Азия · 00:00–08:00 UTC",
  europe: "Европа · 08:00–13:00 UTC",
  us: "США · 13:00–21:00 UTC",
  "off-hours": "Вне основных сессий · 21:00–00:00 UTC",
  unknown: "Нет данных",
};
