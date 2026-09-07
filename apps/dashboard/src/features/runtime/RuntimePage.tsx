import type {
  DeploymentCommandDto,
  DeploymentDto,
  DeploymentStatusDto,
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
import { CirclePause, CirclePlay, RotateCw, Square } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiClientError, applyDeploymentCommand, fetchDeployments } from "../../shared/api";

export default function RuntimePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const deploymentsQuery = useQuery({
    queryKey: ["deployments"],
    queryFn: fetchDeployments,
    refetchInterval: 5_000,
  });

  if (deploymentsQuery.isPending) return <RuntimeSkeleton />;
  if (deploymentsQuery.isError) {
    return (
      <div className="space-y-[18px]">
        <PageHeader
          eyebrow="Runtime"
          title="Управление запуском"
          description="Dry-run deployments и их execution context."
        />
        <ErrorState
          description={deploymentsQuery.error.message}
          requestId={
            deploymentsQuery.error instanceof ApiClientError
              ? deploymentsQuery.error.requestId
              : undefined
          }
          onRetry={() => void deploymentsQuery.refetch()}
        />
      </div>
    );
  }

  const { data, meta } = deploymentsQuery.data;
  const requestedId = searchParams.get("deployment");
  const selected =
    data.items.find((deployment) => deployment.id === requestedId) ?? data.items[0] ?? null;

  return (
    <div className="space-y-[18px]">
      <PageHeader
        eyebrow="Runtime control-plane"
        title="Управление запуском"
        description="Подготовка, запуск и остановка dry-run контура без отправки ордеров на биржу."
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="outline">dry-run only</Badge>
            <span className="text-xs text-stale">
              обновлено {new Date(meta.generatedAt).toLocaleTimeString("ru-RU")}
            </span>
          </div>
        }
      />

      <div className="grid gap-[18px] lg:grid-cols-4">
        <RuntimeMetric label="Всего" value={data.total} />
        <RuntimeMetric label="Готовы" value={data.counts.ready} />
        <RuntimeMetric label="Работают" value={data.counts.running} tone="profit" />
        <RuntimeMetric label="На паузе" value={data.counts.paused} tone="warning" />
      </div>

      {data.items.length === 0 ? (
        <Card>
          <EmptyState
            title="Deployments пока нет"
            description="Одобрите стратегию с пройденной валидацией и подготовьте её к dry-run из strategy workspace."
          />
          <CardContent className="flex justify-center pb-8">
            <Button asChild>
              <Link to="/strategies">Перейти к стратегиям</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid items-start gap-[18px] xl:grid-cols-[minmax(520px,1.4fr)_minmax(360px,0.8fr)]">
          <DeploymentTable
            deployments={data.items}
            selectedId={selected?.id ?? null}
            onSelect={(deploymentId) => setSearchParams({ deployment: deploymentId })}
          />
          {selected ? (
            <DeploymentControl key={`${selected.id}:${selected.status}`} deployment={selected} />
          ) : null}
        </div>
      )}
    </div>
  );
}

function RuntimeMetric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "profit" | "warning";
}) {
  return (
    <Card>
      <CardContent className="p-[18px]">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          className={cn(
            "mt-2 text-2xl font-medium tabular-nums",
            tone === "profit" && "text-profit",
            tone === "warning" && "text-warning",
          )}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

function DeploymentTable({
  deployments,
  selectedId,
  onSelect,
}: {
  deployments: DeploymentDto[];
  selectedId: string | null;
  onSelect: (deploymentId: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between border-b">
        <div>
          <h2 className="text-sm font-medium">Deployments</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Один активный запуск на dry-run счёт.
          </p>
        </div>
        <Badge variant="outline">{deployments.length}</Badge>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <table className="w-full min-w-[560px] border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
              <th scope="col" className="px-[18px] py-3 font-medium">
                Стратегия
              </th>
              <th scope="col" className="px-3 py-3 font-medium">
                Статус
              </th>
              <th scope="col" className="px-3 py-3 font-medium">
                Среда
              </th>
              <th scope="col" className="px-[18px] py-3 text-right font-medium">
                Обновлён
              </th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((deployment) => (
              <tr
                key={deployment.id}
                className={cn(
                  "cursor-pointer border-t border-row-border hover:bg-row-hover",
                  selectedId === deployment.id && "bg-row-hover",
                )}
                onClick={() => onSelect(deployment.id)}
              >
                <td className="px-[18px] py-3.5">
                  <p className="font-medium text-foreground">{deployment.strategy.name}</p>
                  <p className="mt-1 text-xs text-stale">v{deployment.strategyVersion.version}</p>
                </td>
                <td className="px-3 py-3.5">
                  <DeploymentStatusBadge status={deployment.status} />
                </td>
                <td className="px-3 py-3.5 font-mono text-xs text-muted-foreground">
                  {deployment.environment}
                </td>
                <td className="px-[18px] py-3.5 text-right text-xs text-stale">
                  {formatDateTime(deployment.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function DeploymentControl({ deployment }: { deployment: DeploymentDto }) {
  const queryClient = useQueryClient();
  const [pendingCommand, setPendingCommand] = useState<DeploymentCommandDto | null>(null);
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (input: {
      command: DeploymentCommandDto;
      reason: string;
      idempotencyKey: string;
    }) =>
      applyDeploymentCommand(deployment.id, {
        command: input.command,
        expectedStatus: deployment.status,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      }),
    onSuccess: () => {
      setPendingCommand(null);
      setReason("");
      setLocalError(null);
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
      void queryClient.invalidateQueries({ queryKey: ["strategies"] });
      void queryClient.invalidateQueries({ queryKey: ["strategy", deployment.strategy.id] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  function confirmCommand() {
    if (!pendingCommand) return;
    if (reason.trim().length < 3) {
      setLocalError("Укажите причину команды");
      return;
    }
    setLocalError(null);
    mutation.mutate({
      command: pendingCommand,
      reason: reason.trim(),
      idempotencyKey: crypto.randomUUID(),
    });
  }

  const executionRun = deployment.latestExecutionRun;

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">{deployment.strategy.name}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              v{deployment.strategyVersion.version} ·{" "}
              {deployment.exchangeConnection?.label ?? "подключение не задано"}
            </p>
          </div>
          <DeploymentStatusBadge status={deployment.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-[18px] p-[18px]">
        <div className="space-y-3 text-sm">
          <MetaRow label="Среда" value="dry-run" />
          <MetaRow
            label="Подключение"
            value={
              deployment.exchangeConnection
                ? `Bybit ${deployment.exchangeConnection.environment}`
                : "Не привязано"
            }
          />
          <MetaRow
            label="Проверка ключа"
            value={
              deployment.exchangeConnection?.lastVerifiedAt
                ? formatDateTime(deployment.exchangeConnection.lastVerifiedAt)
                : "Не подтверждена"
            }
          />
          <MetaRow label="Execution run" value={executionRun?.id.slice(0, 8) ?? "Не создан"} mono />
          <MetaRow label="Engine" value={executionRun?.engineVersion ?? "—"} mono />
          <MetaRow
            label="Позиции"
            value={executionRun ? String(executionRun.openPositions) : "0"}
          />
          <MetaRow
            label="Обработано пар"
            value={executionRun ? String(executionRun.evaluatedSymbols) : "0"}
          />
          <MetaRow
            label="Ошибки пар"
            value={executionRun ? String(executionRun.failingSymbols) : "0"}
          />
          <MetaRow
            label="Context hash"
            value={executionRun ? `${executionRun.contextHash.slice(0, 12)}…` : "—"}
            mono
          />
          <MetaRow
            label="Запущен"
            value={executionRun?.startedAt ? formatDateTime(executionRun.startedAt) : "—"}
          />
          <MetaRow
            label="Последний цикл"
            value={
              executionRun?.lastEvaluatedAt ? formatDateTime(executionRun.lastEvaluatedAt) : "—"
            }
          />
        </div>

        {executionRun?.lastDecision ? (
          <div className="rounded-[10px] border border-row-border bg-secondary/35 p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-secondary-foreground">Последнее решение</p>
              <Badge variant="outline">{executionRun.lastDecision.action}</Badge>
            </div>
            <p className="mt-2 text-sm">{executionRun.lastDecision.summary}</p>
            <p className="mt-1 font-mono text-[11px] text-stale">
              {executionRun.lastDecision.symbol} · {executionRun.lastDecision.reasonCode}
            </p>
          </div>
        ) : null}

        <div className="rounded-[10px] border border-row-border bg-secondary/35 p-3">
          <p className="text-xs font-medium text-secondary-foreground">Граница безопасности</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Команды меняют состояние и фиксируют immutable context вместе с подключением. Runtime
            остаётся dry-run и не отправляет приватные ордера на биржу.
          </p>
        </div>

        {deployment.exchangeConnection?.status !== "active" ? (
          <p className="text-xs leading-5 text-warning">
            Подключение не подтверждено. Старт и возобновление заблокированы до успешной проверки.
          </p>
        ) : null}

        {executionRun && executionRun.openPositions > 0 ? (
          <p className="text-xs leading-5 text-warning">
            Stop заблокирован до закрытия позиций. Ручное закрытие доступно в разделе «Сделки».
          </p>
        ) : null}

        {pendingCommand ? (
          <div className="space-y-3 border-t border-row-border pt-[18px]">
            <div>
              <p className="text-sm font-medium">{commandContent[pendingCommand].confirmTitle}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {commandContent[pendingCommand].description}
              </p>
            </div>
            <label className="block space-y-2 text-xs font-medium text-secondary-foreground">
              Причина команды
              <Input
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  setLocalError(null);
                }}
                placeholder="Например: запуск после проверки"
                autoFocus
              />
            </label>
            {localError ? <p className="text-xs text-loss">{localError}</p> : null}
            {mutation.isError ? (
              <p className="text-xs text-loss">{mutation.error.message}</p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPendingCommand(null)}
                disabled={mutation.isPending}
              >
                Отмена
              </Button>
              <Button
                variant={pendingCommand === "stop" ? "destructive" : "default"}
                size="sm"
                onClick={confirmCommand}
                disabled={mutation.isPending}
              >
                {mutation.isPending ? "Выполняется…" : "Подтвердить"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 border-t border-row-border pt-[18px]">
            {deployment.allowedCommands.map((command) => {
              const { icon: Icon, label, variant } = commandContent[command];
              return (
                <Button
                  key={command}
                  size="sm"
                  variant={variant}
                  onClick={() => {
                    mutation.reset();
                    setPendingCommand(command);
                  }}
                >
                  <Icon aria-hidden="true" />
                  {label}
                </Button>
              );
            })}
            {deployment.allowedCommands.length === 0 ? (
              <p className="text-xs text-stale">Для текущего статуса нет доступных команд.</p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DeploymentStatusBadge({ status }: { status: DeploymentStatusDto }) {
  const content = statusContent[status];
  return <Badge variant={content.variant}>{content.label}</Badge>;
}

function MetaRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("text-right text-secondary-foreground", mono && "font-mono text-xs")}>
        {value}
      </span>
    </div>
  );
}

function RuntimeSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-20" />
      <div className="grid gap-[18px] lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24" />
        ))}
      </div>
      <div className="grid gap-[18px] xl:grid-cols-[1.4fr_0.8fr]">
        <Skeleton className="h-96" />
        <Skeleton className="h-96" />
      </div>
    </div>
  );
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type BadgeVariant = "secondary" | "profit" | "loss" | "warning" | "outline";

const statusContent: Record<DeploymentStatusDto, { label: string; variant: BadgeVariant }> = {
  draft: { label: "Черновик", variant: "secondary" },
  ready: { label: "Готов", variant: "outline" },
  running: { label: "Работает", variant: "profit" },
  paused: { label: "На паузе", variant: "warning" },
  stopped: { label: "Остановлен", variant: "secondary" },
  failed: { label: "Ошибка", variant: "loss" },
};

const commandContent = {
  start: {
    label: "Запустить",
    confirmTitle: "Запустить dry-run контур?",
    description: "Будет создан новый immutable execution context и execution run.",
    icon: CirclePlay,
    variant: "default" as const,
  },
  pause: {
    label: "Пауза",
    confirmTitle: "Приостановить запуск?",
    description: "Execution context сохранится, новые циклы не должны запускаться.",
    icon: CirclePause,
    variant: "outline" as const,
  },
  resume: {
    label: "Продолжить",
    confirmTitle: "Продолжить запуск?",
    description: "Deployment вернётся в активное состояние с тем же execution context.",
    icon: RotateCw,
    variant: "default" as const,
  },
  stop: {
    label: "Остановить",
    confirmTitle: "Остановить deployment?",
    description: "Текущий execution run будет завершён. Следующий старт создаст новый context.",
    icon: Square,
    variant: "destructive" as const,
  },
} satisfies Record<
  DeploymentCommandDto,
  {
    label: string;
    confirmTitle: string;
    description: string;
    icon: typeof CirclePlay;
    variant: "default" | "outline" | "destructive";
  }
>;
