import type {
  ExperimentFamilyDto,
  ExperimentRankingItemDto,
  ExperimentRankingQueryDto,
  ExperimentRiskTierDto,
  ExperimentSampleStageDto,
} from "@cryptoanal/contracts";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  cn,
} from "@cryptoanal/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiClientError, fetchExperimentRanking } from "../../shared/api";
import { formatMetricMoney } from "../../shared/format";

type SortKey = "return" | "sample" | "profit-factor" | "drawdown" | "exposure";

export default function ExperimentsPage() {
  const [filters, setFilters] = useState<ExperimentRankingQueryDto>({ period: "all" });
  const [sortKey, setSortKey] = useState<SortKey>("return");
  const rankingQuery = useQuery({
    queryKey: ["experiments", filters],
    queryFn: () => fetchExperimentRanking(filters),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  const sortedItems = useMemo(() => {
    const items = [...(rankingQuery.data?.data.items ?? [])];
    return items.sort(sortComparators[sortKey]);
  }, [rankingQuery.data?.data.items, sortKey]);

  if (rankingQuery.isPending) return <ExperimentsSkeleton />;

  if (rankingQuery.isError) {
    return (
      <div className="space-y-[18px]">
        <PageHeader
          eyebrow="Исследования"
          title="Эксперименты"
          description="Сравнение запущенных стратегий и контроль достаточности данных."
        />
        <ErrorState
          description={rankingQuery.error.message}
          requestId={
            rankingQuery.error instanceof ApiClientError ? rankingQuery.error.requestId : undefined
          }
          onRetry={() => void rankingQuery.refetch()}
        />
      </div>
    );
  }

  const { data, meta } = rankingQuery.data;
  const stageCounts = countStages(data.items);

  return (
    <div className="space-y-[18px]">
      <PageHeader
        eyebrow="Исследования"
        title="Эксперименты"
        description="Рейтинг стратегий по нормализованной доходности, риску и качеству выборки."
        actions={
          <span className="text-xs text-stale">
            обновлено {new Date(meta.generatedAt).toLocaleTimeString("ru-RU")}
          </span>
        }
      />

      <Card>
        <CardContent className="grid gap-3 pt-4 xl:grid-cols-5">
          <FilterSelect
            label="Период результата"
            value={filters.period}
            options={periodOptions}
            onChange={(period) =>
              setFilters((current) => ({
                ...current,
                period: period as ExperimentRankingQueryDto["period"],
              }))
            }
          />
          <FilterSelect
            label="Семейство"
            value={filters.family ?? "all"}
            options={[
              { value: "all", label: "Все семейства" },
              ...data.filterOptions.families.map((family) => ({
                value: family,
                label: familyLabels[family],
              })),
            ]}
            onChange={(family) =>
              setFilters((current) => ({
                ...current,
                family: family === "all" ? undefined : (family as ExperimentFamilyDto),
              }))
            }
          />
          <FilterSelect
            label="Риск"
            value={filters.riskTier ?? "all"}
            options={[
              { value: "all", label: "Все уровни риска" },
              ...data.filterOptions.riskTiers.map((riskTier) => ({
                value: riskTier,
                label: riskTierLabels[riskTier],
              })),
            ]}
            onChange={(riskTier) =>
              setFilters((current) => ({
                ...current,
                riskTier: riskTier === "all" ? undefined : (riskTier as ExperimentRiskTierDto),
              }))
            }
          />
          <FilterSelect
            label="Пара"
            value={filters.symbol ?? "all"}
            options={[
              { value: "all", label: "Все пары" },
              ...data.filterOptions.symbols.map((symbol) => ({ value: symbol, label: symbol })),
            ]}
            onChange={(symbol) =>
              setFilters((current) => ({
                ...current,
                symbol: symbol === "all" ? undefined : symbol,
              }))
            }
          />
          <FilterSelect
            label="Сортировка"
            value={sortKey}
            options={sortOptions}
            onChange={(sort) => setSortKey(sort as SortKey)}
          />
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <MetricCard
          label="Общий результат"
          value={formatMetricMoney(data.summary.totalPnl)}
          hint={`${formatSignedPercent(data.summary.returnPercent)} от выделенного капитала`}
          tone={metricTone(data.summary.totalPnl)}
        />
        <MetricCard
          label="Закрытый PnL"
          value={formatMetricMoney(data.summary.realizedPnl)}
          hint={`${data.summary.trades} закрытых сделок`}
          tone={metricTone(data.summary.realizedPnl)}
        />
        <MetricCard
          label="Открытый PnL"
          value={formatMetricMoney(data.summary.unrealizedPnl)}
          hint={`${data.summary.openPositions} открытых позиций`}
          tone={metricTone(data.summary.unrealizedPnl)}
        />
        <MetricCard
          label="Экспозиция"
          value={formatMetricMoney(data.summary.grossExposure)}
          hint="Текущий gross notional"
        />
        <MetricCard
          label="Эксперименты"
          value={`${data.summary.running} / ${data.summary.experiments}`}
          hint="Работают сейчас"
        />
        <MetricCard
          label="Сравнимы"
          value={`${data.summary.comparable} / ${data.summary.experiments}`}
          hint="Набрали минимум 100 сделок"
        />
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Контроль выборки</CardTitle>
          <CardDescription>
            Рейтинг виден сразу, но решение по стратегии принимается только после достаточной
            выборки.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 pt-4 xl:grid-cols-4">
          {sampleStages.map((stage) => (
            <div
              key={stage.value}
              className="rounded-[10px] border border-border bg-secondary/35 p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <SampleBadge stage={stage.value} />
                <span className="font-mono text-lg tabular-nums">{stageCounts[stage.value]}</span>
              </div>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">{stage.description}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 border-b">
          <div>
            <CardTitle>Рейтинг экспериментов</CardTitle>
            <CardDescription>
              Доходность считается от одинакового капитала эксперимента; открытый результат показан
              отдельно.
            </CardDescription>
          </div>
          <Badge variant="outline">{data.items.length} строк</Badge>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {sortedItems.length === 0 ? (
            <EmptyState
              title="Эксперименты не найдены"
              description="Измените фильтры или создайте deployment стратегии."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1780px] border-collapse text-[13px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                    <th scope="col" className="w-12 px-[18px] py-3 text-center font-medium">
                      #
                    </th>
                    <th scope="col" className="min-w-64 px-3 py-3 font-medium">
                      Эксперимент
                    </th>
                    <th scope="col" className="min-w-44 px-3 py-3 font-medium">
                      Контур
                    </th>
                    <th scope="col" className="min-w-52 px-3 py-3 font-medium">
                      Выборка
                    </th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">
                      Сделки
                    </th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">
                      Результат
                    </th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">
                      Realized
                    </th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">
                      Unrealized
                    </th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">
                      PF / EV
                    </th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">
                      DD / издержки
                    </th>
                    <th scope="col" className="px-[18px] py-3 text-right font-medium">
                      Позиции / риск
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedItems.map((item, index) => (
                    <ExperimentRow key={item.deploymentId} item={item} rank={index + 1} />
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

function ExperimentRow({ item, rank }: { item: ExperimentRankingItemDto; rank: number }) {
  return (
    <tr className="border-t border-row-border align-top hover:bg-row-hover">
      <td className="px-[18px] py-4 text-center font-mono text-sm text-stale">{rank}</td>
      <td className="px-3 py-4">
        <Link
          to={`/strategies/${item.strategy.id}`}
          className="block max-w-72 truncate text-sm font-medium text-foreground hover:underline"
        >
          {item.strategy.name}
        </Link>
        <p className="mt-1 text-[11px] text-stale">
          v{item.strategyVersion.version} · {familyLabels[item.strategyVersion.family]} ·{" "}
          {item.strategyVersion.timeframe}
        </p>
        <p className="mt-1 max-w-72 truncate text-[11px] text-stale">
          {item.strategyVersion.symbols.join(", ")}
        </p>
      </td>
      <td className="px-3 py-4">
        <div className="flex flex-wrap gap-1.5">
          <DeploymentBadge status={item.status} />
          <Badge variant={riskBadgeVariant[item.riskTier]}>{riskTierLabels[item.riskTier]}</Badge>
        </div>
        <p className="mt-2 text-[11px] text-stale">
          Риск {formatNumber(item.strategyVersion.riskPerTradePercent)}% · лимит{" "}
          {item.strategyVersion.maxOpenPositions}
        </p>
        <p className="mt-1 text-[11px] text-stale">{formatRunningDays(item.runningDays)}</p>
      </td>
      <td className="px-3 py-4">
        <div className="flex items-center justify-between gap-3">
          <SampleBadge stage={item.sample.stage} />
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {item.sample.trades}
            {item.sample.nextTarget ? ` / ${item.sample.nextTarget}` : ""}
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-avatar">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${item.sample.progressPercent}%` }}
          />
        </div>
        <div className="mt-2 flex gap-1.5" aria-label="Контрольные точки выборки">
          {item.checkpoints.map((checkpoint) => (
            <span
              key={checkpoint.targetTrades}
              className={cn(
                "rounded-full border px-2 py-0.5 font-mono text-[10px] tabular-nums",
                checkpoint.reachedAt
                  ? "border-profit/30 bg-profit/[0.1] text-profit"
                  : "border-border text-stale",
              )}
              title={
                checkpoint.reachedAt
                  ? `${formatMetricMoney(checkpoint.netPnl)} к ${formatDateTime(checkpoint.reachedAt)}`
                  : `Ожидается ${checkpoint.targetTrades} сделок`
              }
            >
              {checkpoint.targetTrades}
            </span>
          ))}
        </div>
      </td>
      <td className="px-3 py-4 text-right">
        <p className="font-mono text-sm tabular-nums">{item.trades}</p>
        <p className="mt-1 text-[11px] text-stale">
          {item.wins}W · {item.losses}L · {formatNumber(item.winRatePercent)}%
        </p>
      </td>
      <td className="px-3 py-4 text-right">
        <p className={cn("font-mono text-sm tabular-nums", pnlTone(item.totalPnl))}>
          {formatSignedPercent(item.returnPercent)}
        </p>
        <p className={cn("mt-1 font-mono text-[11px] tabular-nums", pnlTone(item.totalPnl))}>
          {formatMetricMoney(item.totalPnl)}
        </p>
      </td>
      <MoneyCell value={item.realizedPnl} hint={`Gross ${formatMetricMoney(item.grossPnl)}`} />
      <MoneyCell value={item.unrealizedPnl} hint={`${item.openPositions} открыто`} />
      <td className="px-3 py-4 text-right">
        <p className="font-mono text-sm tabular-nums">{formatProfitFactor(item)}</p>
        <p className={cn("mt-1 font-mono text-[11px] tabular-nums", pnlTone(item.expectancy))}>
          EV {formatMetricMoney(item.expectancy)}
        </p>
      </td>
      <td className="px-3 py-4 text-right">
        <p className="font-mono text-sm tabular-nums text-loss">
          −{formatNumber(item.maxDrawdownPercent)}%
        </p>
        <p className="mt-1 font-mono text-[11px] tabular-nums text-stale">
          {formatMetricMoney(item.costs)}
        </p>
      </td>
      <td className="px-[18px] py-4 text-right">
        <p className="font-mono text-sm tabular-nums">{item.openPositions}</p>
        <p className="mt-1 font-mono text-[11px] tabular-nums text-stale">
          {formatMetricMoney(item.grossExposure)}
        </p>
        <p className="mt-1 text-[10px] text-stale">
          L {formatCompactMoney(item.longExposure)} · S {formatCompactMoney(item.shortExposure)}
        </p>
      </td>
    </tr>
  );
}

function MoneyCell({ value, hint }: { value: string; hint: string }) {
  return (
    <td className="px-3 py-4 text-right">
      <p className={cn("font-mono text-sm tabular-nums", pnlTone(value))}>
        {formatMetricMoney(value)}
      </p>
      <p className="mt-1 text-[11px] text-stale">{hint}</p>
    </td>
  );
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
    <label className="min-w-0 space-y-1.5">
      <span className="block text-[10px] font-medium uppercase tracking-[0.08em] text-stale">
        {label}
      </span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full bg-secondary">
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
    </label>
  );
}

function SampleBadge({ stage }: { stage: ExperimentSampleStageDto }) {
  const content = sampleStageContent[stage];
  return <Badge variant={content.variant}>{content.label}</Badge>;
}

function DeploymentBadge({ status }: { status: ExperimentRankingItemDto["status"] }) {
  const content = deploymentContent[status];
  return <Badge variant={content.variant}>{content.label}</Badge>;
}

function countStages(items: ExperimentRankingItemDto[]) {
  const counts: Record<ExperimentSampleStageDto, number> = {
    insufficient: 0,
    preliminary: 0,
    comparable: 0,
    sufficient: 0,
  };
  for (const item of items) counts[item.sample.stage] += 1;
  return counts;
}

function formatSignedPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${formatNumber(value)}%`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatCompactMoney(value: string): string {
  return new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 }).format(
    Number(value),
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

function formatRunningDays(value: number): string {
  if (value < 1) return `${Math.max(1, Math.round(value * 24))} ч. в работе`;
  return `${formatNumber(value)} дн. в работе`;
}

function formatProfitFactor(item: ExperimentRankingItemDto): string {
  if (item.profitFactor !== null) return formatNumber(item.profitFactor);
  if (item.wins > 0 && item.losses === 0) return "∞";
  return "—";
}

function pnlTone(value: string): string {
  const numeric = Number(value);
  if (numeric > 0) return "text-profit";
  if (numeric < 0) return "text-loss";
  return "text-foreground";
}

function metricTone(value: string): "profit" | "loss" | "neutral" {
  const numeric = Number(value);
  if (numeric > 0) return "profit";
  if (numeric < 0) return "loss";
  return "neutral";
}

const sortComparators: Record<
  SortKey,
  (a: ExperimentRankingItemDto, b: ExperimentRankingItemDto) => number
> = {
  return: (a, b) => b.returnPercent - a.returnPercent || b.sample.trades - a.sample.trades,
  sample: (a, b) => b.sample.trades - a.sample.trades || b.returnPercent - a.returnPercent,
  "profit-factor": (a, b) => (b.profitFactor ?? -1) - (a.profitFactor ?? -1),
  drawdown: (a, b) => a.maxDrawdownPercent - b.maxDrawdownPercent,
  exposure: (a, b) => Number(b.grossExposure) - Number(a.grossExposure),
};

const periodOptions = [
  { value: "24h", label: "24 часа" },
  { value: "7d", label: "7 дней" },
  { value: "30d", label: "30 дней" },
  { value: "all", label: "Всё время" },
];

const sortOptions = [
  { value: "return", label: "Доходность" },
  { value: "sample", label: "Размер выборки" },
  { value: "profit-factor", label: "Profit factor" },
  { value: "drawdown", label: "Минимальная просадка" },
  { value: "exposure", label: "Текущая экспозиция" },
];

const familyLabels: Record<ExperimentFamilyDto, string> = {
  "ema-crossover": "EMA crossover",
  breakout: "Breakout",
  "mean-reversion": "Mean reversion",
  momentum: "Momentum",
};

const riskTierLabels: Record<ExperimentRiskTierDto, string> = {
  conservative: "Консервативный",
  balanced: "Сбалансированный",
  aggressive: "Высокий риск",
};

type BadgeVariant = "default" | "secondary" | "profit" | "loss" | "warning" | "outline";

const riskBadgeVariant: Record<ExperimentRiskTierDto, BadgeVariant> = {
  conservative: "outline",
  balanced: "secondary",
  aggressive: "warning",
};

const deploymentContent: Record<
  ExperimentRankingItemDto["status"],
  { label: string; variant: BadgeVariant }
> = {
  draft: { label: "Черновик", variant: "secondary" },
  ready: { label: "Готов", variant: "outline" },
  running: { label: "Работает", variant: "profit" },
  paused: { label: "Пауза", variant: "warning" },
  stopped: { label: "Остановлен", variant: "outline" },
  failed: { label: "Ошибка", variant: "loss" },
};

const sampleStageContent: Record<
  ExperimentSampleStageDto,
  { label: string; variant: BadgeVariant }
> = {
  insufficient: { label: "Данных мало", variant: "outline" },
  preliminary: { label: "Предварительно", variant: "warning" },
  comparable: { label: "Можно сравнивать", variant: "default" },
  sufficient: { label: "Достаточная база", variant: "profit" },
};

const sampleStages: Array<{
  value: ExperimentSampleStageDto;
  description: string;
}> = [
  { value: "insufficient", description: "До 30 сделок. Любой результат считается шумом." },
  { value: "preliminary", description: "30–99 сделок. Видны первые закономерности." },
  { value: "comparable", description: "100–199 сделок. Стратегии можно сопоставлять." },
  { value: "sufficient", description: "200+ сделок. База для решения и следующей валидации." },
];

function ExperimentsSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-20" />
      <Skeleton className="h-24" />
      <Skeleton className="h-28" />
      <Skeleton className="h-[480px]" />
    </div>
  );
}
