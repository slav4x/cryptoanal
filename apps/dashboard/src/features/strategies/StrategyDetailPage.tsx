import type {
  StrategyConfigDto,
  StrategyDetailDto,
  StrategyStatusDto,
} from "@cryptoanal/contracts";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  ErrorState,
  PageHeader,
  Skeleton,
  cn,
} from "@cryptoanal/ui";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, GitCompareArrows, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ApiClientError, fetchStrategyDetail } from "../../shared/api";

type Tab = "overview" | "config" | "versions";

export default function StrategyDetailPage() {
  const { strategyId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const tab: Tab = tabs.some((item) => item.value === requestedTab)
    ? (requestedTab as Tab)
    : "overview";
  const strategyQuery = useQuery({
    queryKey: ["strategy", strategyId],
    queryFn: () => fetchStrategyDetail(strategyId),
    enabled: Boolean(strategyId),
  });

  if (strategyQuery.isPending) return <DetailSkeleton />;
  if (strategyQuery.isError) {
    return (
      <div className="space-y-[18px]">
        <PageHeader title="Стратегия недоступна" description="Не удалось загрузить workspace." />
        <ErrorState
          description={strategyQuery.error.message}
          requestId={
            strategyQuery.error instanceof ApiClientError
              ? strategyQuery.error.requestId
              : undefined
          }
          onRetry={() => void strategyQuery.refetch()}
        />
      </div>
    );
  }

  const strategy = strategyQuery.data.data;

  return (
    <div className="space-y-[18px]">
      <div className="flex items-start gap-3">
        <Button variant="ghost" size="icon" asChild className="mt-5 shrink-0">
          <Link to="/strategies" aria-label="Вернуться к стратегиям">
            <ArrowLeft aria-hidden="true" />
          </Link>
        </Button>
        <PageHeader
          eyebrow="Strategy workspace"
          title={strategy.name}
          description={strategy.description ?? "Описание не добавлено"}
          actions={
            <>
              <StrategyStatusBadge status={strategy.status} />
              <Button asChild>
                <Link to={`/strategies/${strategy.id}/versions/new`}>
                  <Plus aria-hidden="true" />
                  Новая версия
                </Link>
              </Button>
            </>
          }
        />
      </div>

      <div className="flex items-center gap-1 overflow-x-auto rounded-[10px] border bg-card p-1">
        {tabs.map((item) => (
          <Button
            key={item.value}
            type="button"
            size="sm"
            variant="ghost"
            className={cn(
              "shrink-0 text-muted-foreground",
              tab === item.value && "bg-avatar text-foreground",
            )}
            onClick={() => setSearchParams(item.value === "overview" ? {} : { tab: item.value })}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {tab === "overview" ? <OverviewTab strategy={strategy} /> : null}
      {tab === "config" ? <ConfigTab strategy={strategy} /> : null}
      {tab === "versions" ? <VersionsTab strategy={strategy} /> : null}
    </div>
  );
}

function OverviewTab({ strategy }: { strategy: StrategyDetailDto }) {
  return (
    <div className="grid gap-[18px] lg:grid-cols-3">
      <SummaryCard
        label="Последняя версия"
        value={strategy.latestVersion ? `v${strategy.latestVersion.version}` : "—"}
        hint={`${strategy.versionsCount} ${versionWord(strategy.versionsCount)}`}
      />
      <SummaryCard
        label="Валидация"
        value={
          strategy.lastValidation
            ? validationLabels[strategy.lastValidation.verdict]
            : "Не запускалась"
        }
        hint={
          strategy.lastValidation
            ? `Версия v${strategy.lastValidation.strategyVersion}`
            : "Нет результатов"
        }
      />
      <SummaryCard
        label="Deployment"
        value={strategy.deployment ? deploymentLabels[strategy.deployment.status] : "Не запускался"}
        hint={
          strategy.deployment ? `Версия v${strategy.deployment.strategyVersion}` : "Нет окружения"
        }
      />

      <Card className="lg:col-span-2">
        <CardHeader className="border-b">
          <h2 className="text-sm font-medium">Текущая конфигурация</h2>
        </CardHeader>
        <CardContent className="p-[18px]">
          {strategy.versions[0] ? (
            <ConfigSnapshot config={strategy.versions[0].config} compact />
          ) : (
            <p className="text-sm text-stale">Версий пока нет.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <h2 className="text-sm font-medium">Состояние</h2>
        </CardHeader>
        <CardContent className="space-y-4 p-[18px] text-sm">
          <MetaRow label="Статус" value={strategyStatusContent[strategy.status].label} />
          <MetaRow
            label="Active version"
            value={strategy.activeVersion ? `v${strategy.activeVersion.version}` : "Не назначена"}
          />
          <MetaRow label="Обновлена" value={formatDateTime(strategy.updatedAt)} />
        </CardContent>
      </Card>
    </div>
  );
}

function ConfigTab({ strategy }: { strategy: StrategyDetailDto }) {
  const version = strategy.versions[0];
  if (!version)
    return (
      <Card>
        <CardContent className="p-[18px] text-sm text-stale">Версий пока нет.</CardContent>
      </Card>
    );
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between border-b">
        <div>
          <h2 className="text-sm font-medium">Конфигурация v{version.version}</h2>
          <p className="mt-1 text-xs text-muted-foreground">Snapshot только для чтения</p>
        </div>
        <span className="font-mono text-[11px] text-stale">{version.configHash.slice(0, 12)}</span>
      </CardHeader>
      <CardContent className="p-[18px]">
        <ConfigSnapshot config={version.config} />
      </CardContent>
    </Card>
  );
}

function VersionsTab({ strategy }: { strategy: StrategyDetailDto }) {
  const [selectedId, setSelectedId] = useState(strategy.versions[0]?.id ?? "");
  const selectedIndex = Math.max(
    0,
    strategy.versions.findIndex((version) => version.id === selectedId),
  );
  const selected = strategy.versions[selectedIndex];
  const previous = strategy.versions[selectedIndex + 1];
  const differences = useMemo(
    () => (selected && previous ? createConfigDiff(previous.config, selected.config) : []),
    [previous, selected],
  );

  return (
    <div className="grid items-start gap-[18px] xl:grid-cols-[330px_minmax(0,1fr)]">
      <Card>
        <CardHeader className="border-b">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium">История версий</h2>
            <Badge variant="outline">{strategy.versions.length}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 p-2">
          {strategy.versions.map((version) => (
            <button
              key={version.id}
              type="button"
              onClick={() => setSelectedId(version.id)}
              className={cn(
                "w-full rounded-[10px] border border-transparent px-3 py-3 text-left transition-colors hover:bg-accent",
                selected?.id === version.id && "border-input bg-secondary",
              )}
            >
              <span className="flex items-center justify-between gap-3">
                <span className="font-mono text-sm text-foreground">v{version.version}</span>
                <span className="text-[10px] text-stale">{formatDateTime(version.createdAt)}</span>
              </span>
              <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">
                {version.changeSummary ?? "Без описания"}
              </span>
              <span className="mt-1 block font-mono text-[10px] text-stale">
                {version.configHash.slice(0, 12)}
              </span>
            </button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <div className="flex items-center gap-2">
            <GitCompareArrows className="size-4 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-medium">
              {selected && previous
                ? `Изменения v${previous.version} → v${selected.version}`
                : "Сравнение версий"}
            </h2>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {!selected || !previous ? (
            <p className="px-[18px] py-14 text-center text-sm text-stale">
              Для первой версии нет предыдущей конфигурации.
            </p>
          ) : differences.length === 0 ? (
            <p className="px-[18px] py-14 text-center text-sm text-stale">
              Параметры не изменились.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                    <th className="px-[18px] py-3 font-medium">Параметр</th>
                    <th className="px-3 py-3 font-medium">Было</th>
                    <th className="px-[18px] py-3 font-medium">Стало</th>
                  </tr>
                </thead>
                <tbody>
                  {differences.map((difference) => (
                    <tr key={difference.key} className="border-t border-row-border">
                      <td className="px-[18px] py-3">
                        <span className="text-foreground">{difference.label}</span>
                        <span className="mt-0.5 block text-[10px] text-stale">
                          {difference.section}
                        </span>
                      </td>
                      <td className="px-3 py-3 font-mono text-loss">{difference.before}</td>
                      <td className="px-[18px] py-3 font-mono text-profit">{difference.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ConfigSnapshot({
  config,
  compact = false,
}: {
  config: StrategyConfigDto;
  compact?: boolean;
}) {
  const rows = configRows(config);
  const groups = Array.from(new Set(rows.map((row) => row.section)));
  return (
    <div className={cn("grid gap-[18px]", compact ? "lg:grid-cols-2" : "lg:grid-cols-3")}>
      {groups.map((group) => (
        <div key={group}>
          <p className="mb-2 text-[10px] uppercase tracking-[0.1em] text-stale">{group}</p>
          <div className="divide-y divide-row-border rounded-[10px] border border-row-border">
            {rows
              .filter((row) => row.section === group)
              .map((row) => (
                <MetaRow key={row.key} label={row.label} value={row.value} className="px-3 py-2" />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent className="p-[18px]">
        <p className="text-[10px] uppercase tracking-[0.1em] text-stale">{label}</p>
        <p className="mt-2 text-xl font-medium tracking-tight">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function MetaRow({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-4", className)}>
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right text-foreground">{value}</span>
    </div>
  );
}

function StrategyStatusBadge({ status }: { status: StrategyStatusDto }) {
  const content = strategyStatusContent[status];
  return <Badge variant={content.variant}>{content.label}</Badge>;
}

function createConfigDiff(before: StrategyConfigDto, after: StrategyConfigDto) {
  const beforeRows = configRows(before);
  return configRows(after)
    .map((row) => ({
      ...row,
      before: beforeRows.find((candidate) => candidate.key === row.key)?.value ?? "—",
      after: row.value,
    }))
    .filter((row) => row.before !== row.after);
}

function configRows(config: StrategyConfigDto) {
  return [
    row("universe.symbols", "Universe", "Торговые пары", config.universe.symbols.join(", ")),
    row("universe.timeframe", "Universe", "Таймфрейм", config.universe.timeframe),
    row("signal.direction", "Signal", "Направление", directionLabels[config.signal.direction]),
    row("signal.emaFastPeriod", "Signal", "Быстрая EMA", config.signal.emaFastPeriod),
    row("signal.emaSlowPeriod", "Signal", "Медленная EMA", config.signal.emaSlowPeriod),
    row("signal.rsiPeriod", "Signal", "Период RSI", config.signal.rsiPeriod),
    row("signal.rsiOversold", "Signal", "RSI oversold", config.signal.rsiOversold),
    row("signal.rsiOverbought", "Signal", "RSI overbought", config.signal.rsiOverbought),
    row(
      "filters.minimumVolume24hUsdt",
      "Filters",
      "Мин. объём 24ч",
      `${config.filters.minimumVolume24hUsdt} USDT`,
    ),
    row("filters.minimumAtrPercent", "Filters", "Мин. ATR", `${config.filters.minimumAtrPercent}%`),
    row(
      "filters.maximumAtrPercent",
      "Filters",
      "Макс. ATR",
      `${config.filters.maximumAtrPercent}%`,
    ),
    row(
      "risk.riskPerTradePercent",
      "Risk",
      "Риск на сделку",
      `${config.risk.riskPerTradePercent}%`,
    ),
    row("risk.maxOpenPositions", "Risk", "Открытых позиций", config.risk.maxOpenPositions),
    row("risk.maxDailyLossPercent", "Risk", "Дневной лимит", `${config.risk.maxDailyLossPercent}%`),
    row("entry.orderType", "Entry", "Тип заявки", config.entry.orderType),
    row("entry.limitOffsetBps", "Entry", "Смещение цены", `${config.entry.limitOffsetBps} bps`),
    row("exit.stopLossPercent", "Exit", "Stop loss", `${config.exit.stopLossPercent}%`),
    row("exit.takeProfitPercent", "Exit", "Take profit", `${config.exit.takeProfitPercent}%`),
    row("exit.trailingStopPercent", "Exit", "Trailing stop", `${config.exit.trailingStopPercent}%`),
    row("costs.makerFeeBps", "Costs", "Maker fee", `${config.costs.makerFeeBps} bps`),
    row("costs.takerFeeBps", "Costs", "Taker fee", `${config.costs.takerFeeBps} bps`),
    row("costs.slippageBps", "Costs", "Проскальзывание", `${config.costs.slippageBps} bps`),
    row("schedule.timezone", "Schedule", "Часовой пояс", config.schedule.timezone),
    row(
      "schedule.activeDays",
      "Schedule",
      "Активные дни",
      config.schedule.activeDays.map((day) => dayLabels[day]).join(", "),
    ),
  ];
}

function row(key: string, section: string, label: string, value: string | number) {
  return { key, section, label, value: String(value) };
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

function versionWord(count: number): string {
  const lastTwo = count % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return "версий";
  const last = count % 10;
  if (last === 1) return "версия";
  if (last >= 2 && last <= 4) return "версии";
  return "версий";
}

function DetailSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-24" />
      <Skeleton className="h-10" />
      <div className="grid gap-[18px] lg:grid-cols-3">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
      <Skeleton className="h-80" />
    </div>
  );
}

type BadgeVariant = "secondary" | "profit" | "loss" | "warning" | "outline";

const strategyStatusContent: Record<StrategyStatusDto, { label: string; variant: BadgeVariant }> = {
  draft: { label: "Черновик", variant: "secondary" },
  validating: { label: "Проверяется", variant: "warning" },
  approved: { label: "Одобрена", variant: "profit" },
  deployed: { label: "Запущена", variant: "profit" },
  paused: { label: "На паузе", variant: "warning" },
  archived: { label: "В архиве", variant: "outline" },
};

const tabs: Array<{ value: Tab; label: string }> = [
  { value: "overview", label: "Обзор" },
  { value: "config", label: "Конфигурация" },
  { value: "versions", label: "Версии" },
];

const validationLabels = {
  pending: "Ожидает",
  passed: "Пройдена",
  failed: "Не пройдена",
  warning: "С замечаниями",
} as const;

const deploymentLabels = {
  draft: "Черновик",
  ready: "Готов",
  running: "Работает",
  paused: "На паузе",
  stopped: "Остановлен",
  failed: "Ошибка",
} as const;

const directionLabels = {
  long: "Только long",
  short: "Только short",
  both: "Long и short",
} as const;
const dayLabels = {
  mon: "Пн",
  tue: "Вт",
  wed: "Ср",
  thu: "Чт",
  fri: "Пт",
  sat: "Сб",
  sun: "Вс",
} as const;
