import type {
  StrategyConfigDto,
  StrategyDetailDto,
  StrategyManualStatusDto,
  StrategyStatusDto,
} from "@cryptoanal/contracts";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  ErrorState,
  FieldLabel,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  cn,
} from "@cryptoanal/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  Check,
  FlaskConical,
  GitCompareArrows,
  LoaderCircle,
  Plus,
  Rocket,
  RotateCcw,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ApiClientError,
  changeStrategyStatus,
  createDeployment,
  fetchExchangeConnections,
  fetchStrategyDetail,
} from "../../shared/api";
import { useAuthSession } from "../auth/auth-context";

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
          eyebrow="Стратегия"
          title={strategy.name}
          description={strategy.description ?? "Описание не добавлено"}
          actions={
            <>
              <StrategyStatusBadge status={strategy.status} />
              {strategy.status === "draft" || strategy.status === "approved" ? (
                <Button asChild>
                  <Link to={`/strategies/${strategy.id}/versions/new`}>
                    <Plus aria-hidden="true" />
                    Новая версия
                  </Link>
                </Button>
              ) : (
                <Button disabled title="Текущий статус запрещает создавать версии">
                  <Plus aria-hidden="true" />
                  Новая версия
                </Button>
              )}
            </>
          }
        />
      </div>

      <div
        className="flex items-center gap-1 overflow-x-auto rounded-[10px] border bg-card p-1"
        role="tablist"
        aria-label="Разделы стратегии"
      >
        {tabs.map((item) => (
          <Button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={tab === item.value}
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

      <DeploymentCard strategy={strategy} />
      <LifecycleCard strategy={strategy} />
    </div>
  );
}

function DeploymentCard({ strategy }: { strategy: StrategyDetailDto }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useAuthSession();
  const latestVersion = strategy.latestVersion;
  const [requestedConnectionId, setRequestedConnectionId] = useState("");
  const connectionsQueryKey = ["exchange-connections", session.activeWorkspace.id] as const;
  const connectionsQuery = useQuery({
    queryKey: connectionsQueryKey,
    queryFn: fetchExchangeConnections,
    enabled: !strategy.deployment,
  });
  const activeConnections =
    connectionsQuery.data?.data.items.filter((connection) => connection.status === "active") ?? [];
  const selectedConnection =
    activeConnections.find((connection) => connection.id === requestedConnectionId) ??
    activeConnections[0] ??
    null;
  const mutation = useMutation({
    mutationFn: () => {
      if (!latestVersion) throw new Error("У стратегии нет версии");
      if (!selectedConnection) throw new Error("Выберите проверенное подключение Bybit");
      return createDeployment(strategy.id, {
        strategyVersionId: latestVersion.id,
        exchangeConnectionId: selectedConnection.id,
        idempotencyKey: crypto.randomUUID(),
      });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["strategy", strategy.id] });
      void queryClient.invalidateQueries({ queryKey: ["strategies"] });
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
      void queryClient.invalidateQueries({ queryKey: connectionsQueryKey });
      navigate(`/runtime?deployment=${result.data.deployment.id}`);
    },
  });

  return (
    <Card className="lg:col-span-3">
      <CardHeader className="flex-row items-center justify-between gap-4 border-b">
        <div>
          <h2 className="text-sm font-medium">Dry-run deployment</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Фиксирует одобренную версию и переводит её в безопасный контур управления запуском.
          </p>
        </div>
        {strategy.deployment ? (
          <Button asChild size="sm">
            <Link to={`/runtime?deployment=${strategy.deployment.id}`}>
              <Rocket aria-hidden="true" />
              Управление
            </Link>
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={
              strategy.status !== "approved" ||
              !latestVersion ||
              !selectedConnection ||
              connectionsQuery.isPending ||
              mutation.isPending
            }
            onClick={() => mutation.mutate()}
            title={
              strategy.status !== "approved"
                ? "Сначала одобрите стратегию с пройденной валидацией"
                : !selectedConnection
                  ? "Добавьте и проверьте подключение Bybit"
                  : undefined
            }
          >
            {mutation.isPending ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : (
              <Rocket aria-hidden="true" />
            )}
            Подготовить dry-run
          </Button>
        )}
      </CardHeader>
      {!strategy.deployment ? (
        <CardContent className="space-y-3 p-[18px]">
          {connectionsQuery.isError ? (
            <p className="text-xs text-loss">{connectionsQuery.error.message}</p>
          ) : activeConnections.length > 0 ? (
            <>
              <div className="space-y-2">
                <FieldLabel>Проверенное подключение</FieldLabel>
                <Select
                  value={selectedConnection?.id ?? ""}
                  onValueChange={setRequestedConnectionId}
                >
                  <SelectTrigger aria-label="Проверенное подключение">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {activeConnections.map((connection) => (
                      <SelectItem key={connection.id} value={connection.id}>
                        {connection.label} · {connection.environment}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                Deployment останется dry-run. Подключение фиксируется для provenance и будущего
                demo/live gate, но приватные ордера не отправляются.
              </p>
              {selectedConnection ? (
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">
                    {selectedConnection.readOnly ? "только чтение" : "чтение и запись"}
                  </Badge>
                  <Badge variant={selectedConnection.tradingPermission ? "profit" : "outline"}>
                    {selectedConnection.tradingPermission ? "торговые права" : "без торговых прав"}
                  </Badge>
                  <Badge variant={selectedConnection.ipBound ? "profit" : "warning"}>
                    {selectedConnection.ipBound ? "IP ограничен" : "без IP allowlist"}
                  </Badge>
                </div>
              ) : null}
            </>
          ) : connectionsQuery.isPending ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">
              Нет активных подключений. Добавьте ключи и завершите проверку в{" "}
              <Link className="text-foreground underline underline-offset-4" to="/settings">
                настройках
              </Link>
              .
            </p>
          )}
          {mutation.isError ? <p className="text-xs text-loss">{mutation.error.message}</p> : null}
        </CardContent>
      ) : mutation.isError ? (
        <CardContent className="p-[18px]">
          <p className="text-xs text-loss">{mutation.error.message}</p>
        </CardContent>
      ) : null}
    </Card>
  );
}

function LifecycleCard({ strategy }: { strategy: StrategyDetailDto }) {
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const transitionMutation = useMutation({
    mutationFn: (target: StrategyManualStatusDto) =>
      changeStrategyStatus(strategy.id, {
        expectedStatus: strategy.status,
        target,
        reason,
      }),
    onSuccess: () => {
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["strategy", strategy.id] });
      void queryClient.invalidateQueries({ queryKey: ["strategies"] });
    },
  });

  function runTransition(target: StrategyManualStatusDto) {
    if (reason.trim().length < 3) {
      setLocalError("Добавьте комментарий к изменению статуса");
      return;
    }
    setLocalError(null);
    transitionMutation.mutate(target);
  }

  return (
    <Card className="lg:col-span-3">
      <CardHeader className="border-b">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">Lifecycle и validation eligibility</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Доступность действий рассчитана сервером из текущей версии, проверок и deployment.
            </p>
          </div>
          <Badge variant={strategy.lifecycle.validation.eligible ? "profit" : "warning"}>
            {strategy.lifecycle.validation.eligible ? "Готова к проверке" : "Проверка недоступна"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-[18px] p-[18px] lg:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-secondary-foreground">Validation</p>
          {strategy.lifecycle.validation.reasons.length === 0 ? (
            <div className="mt-2 space-y-3">
              <p className="text-sm leading-6 text-muted-foreground">
                Последнюю версию можно передать в durable очередь Validation Center.
              </p>
              <Button size="sm" variant="outline" asChild>
                <Link to={`/validation?strategy=${strategy.id}`}>
                  <FlaskConical aria-hidden="true" />
                  Новая проверка
                </Link>
              </Button>
            </div>
          ) : (
            <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              {strategy.lifecycle.validation.reasons.map((validationReason) => (
                <li key={validationReason}>— {validationReason}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-3">
          <label className="block space-y-2">
            <FieldLabel>Комментарий к изменению статуса</FieldLabel>
            <Input
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setLocalError(null);
                transitionMutation.reset();
              }}
              placeholder="Почему меняется статус"
              maxLength={300}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {strategy.lifecycle.transitions.map((transition) => (
              <Button
                key={transition.target}
                type="button"
                size="sm"
                variant={transition.target === "archived" ? "destructive" : "outline"}
                disabled={!transition.allowed || transitionMutation.isPending}
                title={transition.reason ?? undefined}
                onClick={() => runTransition(transition.target)}
              >
                <TransitionIcon target={transition.target} />
                {transitionLabels[transition.target]}
              </Button>
            ))}
            {strategy.lifecycle.transitions.length === 0 ? (
              <span className="text-xs text-stale">Ручных переходов нет</span>
            ) : null}
          </div>
          {localError || transitionMutation.error ? (
            <p className="text-xs text-loss">
              {localError ??
                (transitionMutation.error instanceof ApiClientError
                  ? transitionMutation.error.message
                  : "Не удалось изменить статус")}
            </p>
          ) : null}
          {strategy.lifecycle.transitions.some((transition) => !transition.allowed) ? (
            <div className="space-y-1 text-[11px] text-stale">
              {strategy.lifecycle.transitions
                .filter((transition) => !transition.allowed)
                .map((transition) => (
                  <p key={transition.target}>
                    {transitionLabels[transition.target]}: {transition.reason}
                  </p>
                ))}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function TransitionIcon({ target }: { target: StrategyManualStatusDto }) {
  if (target === "archived") return <Archive aria-hidden="true" />;
  if (target === "approved") return <Check aria-hidden="true" />;
  return <RotateCcw aria-hidden="true" />;
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
              <table className="w-full min-w-[640px] border-collapse text-[13px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                    <th scope="col" className="px-[18px] py-3 font-medium">
                      Параметр
                    </th>
                    <th scope="col" className="px-3 py-3 font-medium">
                      Было
                    </th>
                    <th scope="col" className="px-[18px] py-3 font-medium">
                      Стало
                    </th>
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
    row("signal.family", "Signal", "Семейство", signalFamilyLabels[config.signal.family]),
    row("signal.direction", "Signal", "Направление", directionLabels[config.signal.direction]),
    ...signalConfigRows(config),
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

function signalConfigRows(config: StrategyConfigDto) {
  if (config.signal.family === "breakout") {
    return [
      row(
        "signal.breakoutLookbackPeriod",
        "Signal",
        "Период диапазона",
        config.signal.breakoutLookbackPeriod,
      ),
    ];
  }
  if (config.signal.family === "mean-reversion") {
    return [
      row(
        "signal.meanReversionLookbackPeriod",
        "Signal",
        "Период средней",
        config.signal.meanReversionLookbackPeriod,
      ),
      row(
        "signal.meanReversionEntryZScore",
        "Signal",
        "Порог отклонения",
        `${config.signal.meanReversionEntryZScore}σ`,
      ),
      row("signal.rsiPeriod", "Signal", "Период RSI", config.signal.rsiPeriod),
      row("signal.rsiOversold", "Signal", "RSI oversold", config.signal.rsiOversold),
      row("signal.rsiOverbought", "Signal", "RSI overbought", config.signal.rsiOverbought),
    ];
  }
  if (config.signal.family === "momentum") {
    return [
      row(
        "signal.momentumLookbackPeriod",
        "Signal",
        "Период импульса",
        config.signal.momentumLookbackPeriod,
      ),
      row(
        "signal.momentumThresholdPercent",
        "Signal",
        "Порог импульса",
        `${config.signal.momentumThresholdPercent}%`,
      ),
    ];
  }
  return [
    row("signal.emaFastPeriod", "Signal", "Быстрая EMA", config.signal.emaFastPeriod),
    row("signal.emaSlowPeriod", "Signal", "Медленная EMA", config.signal.emaSlowPeriod),
    row("signal.rsiPeriod", "Signal", "Период RSI", config.signal.rsiPeriod),
    row("signal.rsiOversold", "Signal", "RSI oversold", config.signal.rsiOversold),
    row("signal.rsiOverbought", "Signal", "RSI overbought", config.signal.rsiOverbought),
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

const transitionLabels: Record<StrategyManualStatusDto, string> = {
  draft: "Вернуть в черновик",
  approved: "Одобрить",
  archived: "Архивировать",
};

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
const signalFamilyLabels = {
  "ema-crossover": "EMA crossover",
  breakout: "Пробой диапазона",
  "mean-reversion": "Возврат к средней",
  momentum: "Momentum",
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
