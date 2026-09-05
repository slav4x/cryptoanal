import type { StrategyStatusDto, StrategySummaryDto } from "@cryptoanal/contracts";
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
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiClientError, fetchStrategies } from "../../shared/api";

type StatusFilter = "all" | StrategyStatusDto;

export default function StrategiesPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const strategiesQuery = useQuery({
    queryKey: ["strategies"],
    queryFn: fetchStrategies,
    staleTime: 15_000,
  });

  const filteredStrategies = useMemo(() => {
    const strategies = strategiesQuery.data?.data.items ?? [];
    const normalizedSearch = search.trim().toLocaleLowerCase("ru-RU");
    return strategies.filter(
      (strategy) =>
        (statusFilter === "all" || strategy.status === statusFilter) &&
        (!normalizedSearch ||
          strategy.name.toLocaleLowerCase("ru-RU").includes(normalizedSearch) ||
          strategy.description?.toLocaleLowerCase("ru-RU").includes(normalizedSearch)),
    );
  }, [search, statusFilter, strategiesQuery.data]);

  if (strategiesQuery.isPending) return <StrategiesSkeleton />;

  if (strategiesQuery.isError) {
    return (
      <div className="space-y-[18px]">
        <PageHeader
          eyebrow="Лаборатория стратегий"
          title="Стратегии"
          description="Версии, валидация и состояние запуска в одном каталоге."
        />
        <ErrorState
          description={strategiesQuery.error.message}
          requestId={
            strategiesQuery.error instanceof ApiClientError
              ? strategiesQuery.error.requestId
              : undefined
          }
          onRetry={() => void strategiesQuery.refetch()}
        />
      </div>
    );
  }

  const { data, meta } = strategiesQuery.data;

  return (
    <div className="space-y-[18px]">
      <PageHeader
        eyebrow="Лаборатория стратегий"
        title="Стратегии"
        description="Версии, валидация и состояние запуска в одном каталоге."
        actions={
          <>
            <span className="text-xs text-stale">
              обновлено {new Date(meta.generatedAt).toLocaleTimeString("ru-RU")}
            </span>
            <Button asChild>
              <Link to="/strategies/new">
                <Plus aria-hidden="true" />
                Создать стратегию
              </Link>
            </Button>
          </>
        }
      />

      <Card>
        <CardHeader className="gap-3 border-b">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm font-medium">Каталог</p>
            <Badge variant="outline">{data.total} стратегий</Badge>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative w-72 shrink-0">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="bg-secondary pl-9"
                placeholder="Найти стратегию"
                aria-label="Поиск стратегии"
              />
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-full border border-input bg-background p-0.5">
              {statusFilters.map((filter) => (
                <Button
                  key={filter.value}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-7 shrink-0 rounded-full px-3 text-[11px] text-muted-foreground",
                    statusFilter === filter.value && "bg-avatar text-foreground",
                  )}
                  aria-pressed={statusFilter === filter.value}
                  onClick={() => setStatusFilter(filter.value)}
                >
                  {filter.label} {filter.value === "all" ? data.total : data.counts[filter.value]}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>

        <CardContent className="px-0 pb-0">
          {data.total === 0 ? (
            <EmptyState
              title="Стратегий пока нет"
              description="Каталог начнёт заполняться после создания первой стратегии и её начальной версии."
            />
          ) : filteredStrategies.length === 0 ? (
            <p className="px-5 py-14 text-center text-sm text-muted-foreground">
              По выбранным фильтрам стратегии не найдены.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] border-collapse text-[13px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                    <th className="px-[18px] py-3 font-medium">Название</th>
                    <th className="px-3 py-3 font-medium">Статус</th>
                    <th className="px-3 py-3 font-medium">Версия</th>
                    <th className="px-3 py-3 font-medium">Валидация</th>
                    <th className="px-3 py-3 font-medium">Deployment</th>
                    <th className="px-[18px] py-3 text-right font-medium">Обновлена</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredStrategies.map((strategy) => (
                    <StrategyRow key={strategy.id} strategy={strategy} />
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

function StrategyRow({ strategy }: { strategy: StrategySummaryDto }) {
  const displayVersion = strategy.activeVersion ?? strategy.latestVersion;

  return (
    <tr className="border-t border-row-border hover:bg-row-hover">
      <td className="px-[18px] py-3.5">
        <Link
          to={`/strategies/${strategy.id}`}
          className="text-base font-normal text-foreground hover:underline"
        >
          {strategy.name}
        </Link>
        <p className="mt-1 max-w-xl truncate text-xs text-stale">
          {strategy.description ?? "Описание не добавлено"}
        </p>
      </td>
      <td className="px-3 py-3.5">
        <StrategyStatusBadge status={strategy.status} />
      </td>
      <td className="px-3 py-3.5">
        {displayVersion ? (
          <div>
            <p className="font-mono text-sm">v{displayVersion.version}</p>
            <p className="mt-1 text-[11px] text-stale">{strategy.versionsCount} версий</p>
          </div>
        ) : (
          <span className="text-stale">—</span>
        )}
      </td>
      <td className="px-3 py-3.5">
        <ValidationState validation={strategy.lastValidation} />
      </td>
      <td className="px-3 py-3.5">
        <DeploymentState deployment={strategy.deployment} />
      </td>
      <td className="px-[18px] py-3.5 text-right text-xs text-muted-foreground">
        {formatDateTime(strategy.updatedAt)}
      </td>
    </tr>
  );
}

function StrategyStatusBadge({ status }: { status: StrategyStatusDto }) {
  const content = strategyStatusContent[status];
  return <Badge variant={content.variant}>{content.label}</Badge>;
}

function ValidationState({ validation }: { validation: StrategySummaryDto["lastValidation"] }) {
  if (!validation) return <span className="text-xs text-stale">Не запускалась</span>;
  const content = validationContent[validation.verdict];
  return (
    <div>
      <Badge variant={content.variant}>{content.label}</Badge>
      <p className="mt-1 text-[11px] text-stale">v{validation.strategyVersion}</p>
    </div>
  );
}

function DeploymentState({ deployment }: { deployment: StrategySummaryDto["deployment"] }) {
  if (!deployment) return <span className="text-xs text-stale">Не запускалась</span>;
  const content = deploymentContent[deployment.status];
  return (
    <div>
      <Badge variant={content.variant}>{content.label}</Badge>
      <p className="mt-1 text-[11px] text-stale">
        {environmentLabels[deployment.environment]} · v{deployment.strategyVersion}
      </p>
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

const validationContent = {
  pending: { label: "Ожидает", variant: "outline" },
  passed: { label: "Пройдена", variant: "profit" },
  failed: { label: "Не пройдена", variant: "loss" },
  warning: { label: "С замечаниями", variant: "warning" },
} as const;

const deploymentContent = {
  draft: { label: "Черновик", variant: "secondary" },
  ready: { label: "Готов", variant: "outline" },
  running: { label: "Работает", variant: "profit" },
  paused: { label: "На паузе", variant: "warning" },
  stopped: { label: "Остановлен", variant: "outline" },
  failed: { label: "Ошибка", variant: "loss" },
} as const;

const environmentLabels = {
  "dry-run": "Dry-run",
  demo: "Demo",
  live: "Live",
} as const;

const statusFilters: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "Все" },
  { value: "draft", label: "Черновики" },
  { value: "validating", label: "Проверяются" },
  { value: "approved", label: "Одобрены" },
  { value: "deployed", label: "Запущены" },
  { value: "paused", label: "На паузе" },
  { value: "archived", label: "Архив" },
];

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StrategiesSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-20" />
      <Skeleton className="h-[420px]" />
    </div>
  );
}
