import type {
  ExchangeConnectionDto,
  SettingsDto,
  TableDensity,
  WorkspaceAccessDto,
  WorkspacePreferencesDto,
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
  PageHeader,
  Select,
  Skeleton,
} from "@cryptoanal/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellOff,
  Building2,
  Copy,
  Download,
  Gauge,
  Globe2,
  KeyRound,
  Plus,
  RotateCcw,
  Save,
  ServerCog,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import {
  ApiClientError,
  createExchangeConnection,
  createWorkspace,
  createWorkspaceInvitation,
  exportWorkspace,
  fetchExchangeConnections,
  fetchSettings,
  fetchWorkspaceAccess,
  removeWorkspaceMember,
  revokeExchangeConnection,
  revokeWorkspaceInvitation,
  rotateExchangeConnectionCredentials,
  updateWorkspaceMemberRole,
  updateWorkspacePreferences,
  verifyExchangeConnection,
} from "../../shared/api";
import { authSessionQueryKey, useAuthSession } from "../auth/auth-context";

export default function SettingsPage() {
  const session = useAuthSession();
  const query = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });
  if (query.isPending) return <SettingsSkeleton />;
  if (query.isError)
    return (
      <div className="space-y-[18px]">
        <PageHeader title="Настройки" description="Параметры рабочего пространства разработки." />
        <ErrorState
          description={query.error.message}
          requestId={query.error instanceof ApiClientError ? query.error.requestId : undefined}
          onRetry={() => void query.refetch()}
        />
      </div>
    );

  const settings = query.data.data;
  return (
    <div className="space-y-[18px]">
      <PageHeader
        eyebrow="Система"
        title="Настройки"
        description="Рабочие параметры текущего пространства и прозрачное состояние инфраструктуры."
      />
      <div className="grid items-start gap-[18px] xl:grid-cols-2">
        <WorkspaceCard session={session} />
        <WorkspaceAccessCard session={session} />
        <PreferencesCard key={settings.preferences.updatedAt} preferences={settings.preferences} />
        <RuntimeSafetyCard settings={settings} />
        <MarketDataCard settings={settings} />
        <ExchangeConnectionsCard session={session} />
        <NotificationsCard settings={settings} />
        <RetentionCard settings={settings} />
        <SystemCard settings={settings} />
      </div>
    </div>
  );
}

function WorkspaceAccessCard({ session }: { session: ReturnType<typeof useAuthSession> }) {
  const workspaceId = session.activeWorkspace.id;
  const canManage = session.activeWorkspace.role === "owner";
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"owner" | "member">("member");
  const [invitationLink, setInvitationLink] = useState<string | null>(null);
  const queryKey = ["workspace-access", workspaceId] as const;
  const accessQuery = useQuery({
    queryKey,
    queryFn: () => fetchWorkspaceAccess(workspaceId),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const invitationMutation = useMutation({
    mutationFn: () => createWorkspaceInvitation(workspaceId, { email, role }),
    onSuccess: async ({ data }) => {
      setInvitationLink(`${window.location.origin}/invite/${data.token}`);
      setEmail("");
      await refresh();
    },
  });
  const roleMutation = useMutation({
    mutationFn: ({ userId, nextRole }: { userId: string; nextRole: "owner" | "member" }) =>
      updateWorkspaceMemberRole(workspaceId, userId, { role: nextRole }),
    onSuccess: async () => {
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({ queryKey: authSessionQueryKey }),
      ]);
    },
  });
  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeWorkspaceMember(workspaceId, userId),
    onSuccess: refresh,
  });
  const revokeMutation = useMutation({
    mutationFn: (invitationId: string) => revokeWorkspaceInvitation(workspaceId, invitationId),
    onSuccess: refresh,
  });
  const mutationError =
    invitationMutation.error ?? roleMutation.error ?? removeMutation.error ?? revokeMutation.error;

  return (
    <Card className="xl:col-span-2">
      <CardHeader className="flex-row items-start gap-3 border-b">
        <CardIcon icon={Users} />
        <div>
          <CardTitle>Участники и доступ</CardTitle>
          <CardDescription>
            Роли и приглашения изолированы внутри текущего рабочего пространства.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-4">
        {accessQuery.isPending ? (
          <Skeleton className="h-28 w-full" />
        ) : accessQuery.isError ? (
          <ErrorState
            description={accessQuery.error.message}
            requestId={
              accessQuery.error instanceof ApiClientError ? accessQuery.error.requestId : undefined
            }
            onRetry={() => void accessQuery.refetch()}
          />
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <FieldLabel>Участники</FieldLabel>
              <div className="mt-2">
                {accessQuery.data.data.members.map((member) => (
                  <MemberRow
                    key={member.id}
                    member={member}
                    currentUserId={session.user.id}
                    canManage={canManage}
                    disabled={roleMutation.isPending || removeMutation.isPending}
                    onRoleChange={(nextRole) =>
                      roleMutation.mutate({ userId: member.id, nextRole })
                    }
                    onRemove={() => {
                      if (window.confirm(`Удалить ${member.email} из workspace?`)) {
                        removeMutation.mutate(member.id);
                      }
                    }}
                  />
                ))}
              </div>
            </div>
            <div>
              <FieldLabel>Активные приглашения</FieldLabel>
              <div className="mt-2">
                {accessQuery.data.data.invitations.length ? (
                  accessQuery.data.data.invitations.map((invitation) => (
                    <div
                      key={invitation.id}
                      className="flex min-h-12 items-center justify-between gap-4 border-b border-row-border last:border-0"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs text-secondary-foreground">
                          {invitation.email}
                        </span>
                        <span className="block text-[10px] text-stale">
                          {invitation.role === "owner" ? "владелец" : "участник"} · до{" "}
                          {formatDate(invitation.expiresAt)}
                        </span>
                      </span>
                      {canManage ? (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label="Отозвать приглашение"
                          disabled={revokeMutation.isPending}
                          onClick={() => revokeMutation.mutate(invitation.id)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <p className="py-4 text-xs text-stale">Нет ожидающих приглашений.</p>
                )}
              </div>
            </div>
          </div>
        )}

        {canManage ? (
          <form
            className="grid gap-3 border-t border-row-border pt-4 md:grid-cols-[minmax(0,1fr)_160px_auto] md:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              setInvitationLink(null);
              invitationMutation.mutate();
            }}
          >
            <Field label="Email для приглашения">
              <Input
                type="email"
                value={email}
                maxLength={320}
                placeholder="user@example.com"
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </Field>
            <Field label="Роль">
              <Select value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
                <option value="member">Участник</option>
                <option value="owner">Владелец</option>
              </Select>
            </Field>
            <Button type="submit" disabled={invitationMutation.isPending}>
              <UserPlus className="size-4" />
              {invitationMutation.isPending ? "Создание…" : "Пригласить"}
            </Button>
          </form>
        ) : null}

        {invitationLink ? (
          <div className="flex items-center gap-3 rounded-[8px] border border-profit/30 bg-profit/5 p-3">
            <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-secondary-foreground">
              {invitationLink}
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void navigator.clipboard.writeText(invitationLink)}
            >
              <Copy className="size-4" />
              Копировать
            </Button>
          </div>
        ) : null}
        {mutationError ? <p className="text-xs text-loss">{mutationError.message}</p> : null}
      </CardContent>
    </Card>
  );
}

function MemberRow({
  member,
  currentUserId,
  canManage,
  disabled,
  onRoleChange,
  onRemove,
}: {
  member: WorkspaceAccessDto["members"][number];
  currentUserId: string;
  canManage: boolean;
  disabled: boolean;
  onRoleChange: (role: "owner" | "member") => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 border-b border-row-border last:border-0">
      <span className="min-w-0">
        <span className="block truncate text-xs text-secondary-foreground">
          {member.displayName}
          {member.id === currentUserId ? " · вы" : ""}
        </span>
        <span className="block truncate text-[10px] text-stale">{member.email}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {canManage ? (
          <Select
            className="h-8 w-[116px] text-[11px]"
            value={member.role}
            disabled={disabled}
            aria-label={`Роль ${member.email}`}
            onChange={(event) => onRoleChange(event.target.value as "owner" | "member")}
          >
            <option value="member">Участник</option>
            <option value="owner">Владелец</option>
          </Select>
        ) : (
          <Badge variant="outline">{member.role === "owner" ? "владелец" : "участник"}</Badge>
        )}
        {canManage && member.id !== currentUserId ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Удалить ${member.email}`}
            disabled={disabled || member.role === "owner"}
            onClick={onRemove}
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null}
      </span>
    </div>
  );
}

function WorkspaceCard({ session }: { session: ReturnType<typeof useAuthSession> }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const mutation = useMutation({
    mutationFn: createWorkspace,
    onSuccess: (response) => {
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== authSessionQueryKey[0],
      });
      queryClient.setQueryData(authSessionQueryKey, response);
    },
  });

  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3 border-b">
        <CardIcon icon={Building2} />
        <div>
          <CardTitle>Рабочие пространства</CardTitle>
          <CardDescription>
            Каждое пространство имеет собственные стратегии и историю.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <div className="space-y-2">
          {session.workspaces.map((workspace) => (
            <div
              key={workspace.id}
              className="flex min-h-10 items-center justify-between gap-4 border-b border-row-border last:border-0"
            >
              <span className="min-w-0 truncate text-xs text-secondary-foreground">
                {workspace.name}
              </span>
              <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-stale">
                {workspace.id === session.activeWorkspace.id ? "текущее" : workspace.role}
              </span>
            </div>
          ))}
        </div>
        <form
          className="space-y-3 border-t border-row-border pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({ name });
          }}
        >
          <Field label="Новое пространство">
            <Input
              value={name}
              minLength={2}
              maxLength={80}
              placeholder="Название клиента или проекта"
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>
          {mutation.error ? <p className="text-xs text-loss">{mutation.error.message}</p> : null}
          <Button
            type="submit"
            variant="secondary"
            disabled={mutation.isPending || name.trim().length < 2}
          >
            <Plus className="size-4" />
            {mutation.isPending ? "Создание…" : "Создать и открыть"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function PreferencesCard({ preferences }: { preferences: WorkspacePreferencesDto }) {
  const queryClient = useQueryClient();
  const [timezone, setTimezone] = useState(preferences.timezone);
  const [tableDensity, setTableDensity] = useState<TableDensity>(preferences.tableDensity);
  const dirty = timezone !== preferences.timezone || tableDensity !== preferences.tableDensity;
  const mutation = useMutation({
    mutationFn: () =>
      updateWorkspacePreferences({
        timezone,
        tableDensity,
        expectedUpdatedAt: preferences.updatedAt,
      }),
    onSuccess: async (response) => {
      document.documentElement.dataset.density = response.data.preferences.tableDensity;
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3 border-b">
        <CardIcon icon={Globe2} />
        <div>
          <CardTitle>Интерфейс и время</CardTitle>
          <CardDescription>Сохраняются на уровне текущего рабочего пространства.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Timezone">
            <Select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
              {timezones.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Плотность таблиц">
            <Select
              value={tableDensity}
              onChange={(event) => setTableDensity(event.target.value as TableDensity)}
            >
              <option value="compact">Компактная</option>
              <option value="comfortable">Комфортная</option>
            </Select>
          </Field>
        </div>
        <SettingRow
          label="Валюта отчётности"
          value={preferences.currency}
          hint="Фиксирована для текущего журнала dry-run"
        />
        {mutation.error ? <p className="text-xs text-loss">{mutation.error.message}</p> : null}
        <div className="flex justify-end border-t border-row-border pt-4">
          <Button disabled={!dirty || mutation.isPending} onClick={() => mutation.mutate()}>
            <Save className="size-4" />
            {mutation.isPending ? "Сохранение…" : "Сохранить"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RuntimeSafetyCard({ settings }: { settings: SettingsDto }) {
  const safety = settings.runtimeSafety;
  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3 border-b">
        <CardIcon icon={ShieldCheck} />
        <div>
          <CardTitle>Безопасность запуска</CardTitle>
          <CardDescription>Защитные ограничения применяются сервером.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="pt-2">
        <SettingRow label="Контур" value={safety.tradingEnvironment} tone="profit" />
        <SettingRow
          label="Реальная торговля"
          value={safety.liveTradingEnabled ? "включена" : "отключена"}
        />
        <SettingRow
          label="Подтверждения команд"
          value={safety.confirmationsRequired ? "обязательны" : "отключены"}
        />
        <SettingRow label="Активных запусков" value={`не более ${safety.maxActiveDeployments}`} />
      </CardContent>
    </Card>
  );
}

function MarketDataCard({ settings }: { settings: SettingsDto }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3 border-b">
        <CardIcon icon={Gauge} />
        <div>
          <CardTitle>Рыночные данные и биржа</CardTitle>
          <CardDescription>Секреты и приватные ключи не выводятся.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="pt-2">
        <SettingRow label="Провайдер" value={settings.marketData.provider} />
        <SettingRow
          label="Тикеры"
          value={formatInterval(settings.marketData.marketPollIntervalMs)}
        />
        <SettingRow
          label="Свечи"
          value={formatInterval(settings.marketData.candlePollIntervalMs)}
        />
        <SettingRow
          label="Снимок счёта"
          value={formatInterval(settings.marketData.accountSnapshotIntervalMs)}
        />
        <SettingRow
          label="Публичное подключение"
          value={settings.exchange.publicConnectionConfigured ? "настроен" : "не настроен"}
          tone={settings.exchange.publicConnectionConfigured ? "profit" : undefined}
        />
        <SettingRow
          label="Приватное подключение"
          value={settings.exchange.privateConnectionConfigured ? "настроен" : "не настроен"}
          hint="Ключи изолированы на уровне workspace"
          tone={settings.exchange.privateConnectionConfigured ? "profit" : undefined}
        />
      </CardContent>
    </Card>
  );
}

function ExchangeConnectionsCard({ session }: { session: ReturnType<typeof useAuthSession> }) {
  const canManage = session.activeWorkspace.role === "owner";
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [environment, setEnvironment] = useState<"demo" | "live">("demo");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const queryKey = ["exchange-connections", session.activeWorkspace.id] as const;
  const query = useQuery({ queryKey, queryFn: fetchExchangeConnections });

  const resetForm = () => {
    setEditingId(null);
    setLabel("");
    setEnvironment("demo");
    setApiKey("");
    setApiSecret("");
  };
  const saveMutation = useMutation({
    mutationFn: () =>
      editingId
        ? rotateExchangeConnectionCredentials(editingId, { apiKey, apiSecret })
        : createExchangeConnection({
            exchange: "bybit",
            label,
            environment,
            apiKey,
            apiSecret,
          }),
    onSuccess: async () => {
      resetForm();
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  const revokeMutation = useMutation({
    mutationFn: revokeExchangeConnection,
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  const verifyMutation = useMutation({
    mutationFn: verifyExchangeConnection,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: ["deployments"] }),
        queryClient.invalidateQueries({ queryKey: ["strategies"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
    },
  });
  const error = saveMutation.error ?? revokeMutation.error ?? verifyMutation.error;

  return (
    <Card className="xl:col-span-2">
      <CardHeader className="flex-row items-start gap-3 border-b">
        <CardIcon icon={KeyRound} />
        <div>
          <CardTitle>Подключения бирж</CardTitle>
          <CardDescription>
            API-ключи зашифрованы; интерфейс показывает только последние четыре символа.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-4">
        {query.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : query.isError ? (
          <ErrorState
            description={query.error.message}
            requestId={query.error instanceof ApiClientError ? query.error.requestId : undefined}
            onRetry={() => void query.refetch()}
          />
        ) : query.data.data.items.length ? (
          <div>
            {query.data.data.items.map((connection) => (
              <ExchangeConnectionRow
                key={connection.id}
                connection={connection}
                canManage={canManage}
                disabled={
                  saveMutation.isPending || revokeMutation.isPending || verifyMutation.isPending
                }
                verifying={verifyMutation.isPending && verifyMutation.variables === connection.id}
                onVerify={() => verifyMutation.mutate(connection.id)}
                onRotate={() => {
                  setEditingId(connection.id);
                  setLabel(connection.label);
                  setEnvironment(connection.environment);
                  setApiKey("");
                  setApiSecret("");
                }}
                onRevoke={() => {
                  if (window.confirm(`Отозвать подключение «${connection.label}»?`)) {
                    revokeMutation.mutate(connection.id);
                  }
                }}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-stale">Приватные подключения ещё не добавлены.</p>
        )}

        {canManage ? (
          <form
            className="space-y-3 border-t border-row-border pt-4"
            onSubmit={(event) => {
              event.preventDefault();
              saveMutation.mutate();
            }}
          >
            <div className="flex items-center justify-between gap-4">
              <FieldLabel>
                {editingId ? "Замена ключей подключения" : "Новое подключение"}
              </FieldLabel>
              {editingId ? (
                <Button type="button" size="sm" variant="ghost" onClick={resetForm}>
                  Отмена
                </Button>
              ) : null}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {!editingId ? (
                <>
                  <Field label="Название">
                    <Input
                      value={label}
                      minLength={2}
                      maxLength={80}
                      placeholder="Bybit основной"
                      onChange={(event) => setLabel(event.target.value)}
                      required
                    />
                  </Field>
                  <Field label="Контур">
                    <Select
                      value={environment}
                      onChange={(event) => setEnvironment(event.target.value as "demo" | "live")}
                    >
                      <option value="demo">Demo</option>
                      <option value="live">Live</option>
                    </Select>
                  </Field>
                </>
              ) : null}
              <Field label="API key">
                <Input
                  type="password"
                  value={apiKey}
                  minLength={8}
                  maxLength={256}
                  autoComplete="off"
                  onChange={(event) => setApiKey(event.target.value)}
                  required
                />
              </Field>
              <Field label="API secret">
                <Input
                  type="password"
                  value={apiSecret}
                  minLength={16}
                  maxLength={512}
                  autoComplete="off"
                  onChange={(event) => setApiSecret(event.target.value)}
                  required
                />
              </Field>
            </div>
            <div className="flex items-center justify-between gap-4">
              <p className="text-[10px] text-stale">
                После сохранения запустите проверку. Live-торговля не включается автоматически.
              </p>
              <Button type="submit" disabled={saveMutation.isPending}>
                {editingId ? <RotateCcw className="size-4" /> : <Plus className="size-4" />}
                {saveMutation.isPending ? "Сохранение…" : editingId ? "Заменить ключи" : "Добавить"}
              </Button>
            </div>
          </form>
        ) : null}
        {error ? <p className="text-xs text-loss">{error.message}</p> : null}
      </CardContent>
    </Card>
  );
}

function ExchangeConnectionRow({
  connection,
  canManage,
  disabled,
  verifying,
  onVerify,
  onRotate,
  onRevoke,
}: {
  connection: ExchangeConnectionDto;
  canManage: boolean;
  disabled: boolean;
  verifying: boolean;
  onVerify: () => void;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const status = {
    unverified: { label: "не проверено", variant: "outline" as const },
    active: { label: "активно", variant: "profit" as const },
    invalid: { label: "ошибка", variant: "loss" as const },
  }[connection.status];
  return (
    <div className="flex min-h-16 items-center justify-between gap-5 border-b border-row-border py-3 last:border-0">
      <span className="min-w-0 space-y-1.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-xs text-secondary-foreground">{connection.label}</span>
          <Badge variant={status.variant}>{status.label}</Badge>
        </span>
        <span className="mt-0.5 block text-[10px] uppercase tracking-[0.06em] text-stale">
          Bybit · {connection.environment} · {connection.apiKeyHint}
        </span>
        {connection.lastVerificationMessage ? (
          <span
            className={`block text-[11px] ${
              connection.status === "invalid"
                ? "text-loss"
                : connection.lastVerificationCode !== "VERIFIED"
                  ? "text-warning"
                  : "text-muted-foreground"
            }`}
          >
            {connection.lastVerificationMessage}
          </span>
        ) : null}
        {connection.nextVerificationAt ? (
          <span className="block text-[10px] text-stale">
            Следующая проверка {formatDateTime(connection.nextVerificationAt)}
          </span>
        ) : null}
        {connection.lastVerifiedAt ? (
          <span className="block text-[10px] text-stale">
            Проверено {formatDateTime(connection.lastVerifiedAt)}
          </span>
        ) : null}
        {connection.activeDeployments > 0 ? (
          <span className="block text-[10px] text-warning">
            Используется активным deployment: {connection.activeDeployments}
          </span>
        ) : null}
        {connection.lastVerifiedAt && connection.readOnly !== null ? (
          <span className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">
              {connection.readOnly ? "только чтение" : "чтение и запись"}
            </Badge>
            <Badge variant={connection.tradingPermission ? "profit" : "outline"}>
              {connection.tradingPermission ? "торговля разрешена" : "без торговли"}
            </Badge>
            <Badge variant={connection.ipBound ? "profit" : "warning"}>
              {connection.ipBound ? "IP ограничен" : "без IP allowlist"}
            </Badge>
          </span>
        ) : null}
        {connection.permissionGroups.length ? (
          <span className="block text-[10px] text-stale">
            {connection.permissionGroups
              .map((group) => `${group.name}: ${group.permissions.join(", ")}`)
              .join(" · ")}
          </span>
        ) : null}
      </span>
      {canManage ? (
        <span className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={onVerify}
          >
            <ShieldCheck className="size-4" />
            {verifying ? "Проверка…" : "Проверить"}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Заменить ключи ${connection.label}`}
            disabled={disabled || connection.activeDeployments > 0}
            title={
              connection.activeDeployments > 0
                ? "Сначала остановите связанный deployment"
                : undefined
            }
            onClick={onRotate}
          >
            <RotateCcw className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Отозвать ${connection.label}`}
            disabled={disabled || connection.activeDeployments > 0}
            title={
              connection.activeDeployments > 0
                ? "Сначала остановите связанный deployment"
                : undefined
            }
            onClick={onRevoke}
          >
            <Trash2 className="size-4" />
          </Button>
        </span>
      ) : null}
    </div>
  );
}

function NotificationsCard({ settings }: { settings: SettingsDto }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3 border-b">
        <CardIcon icon={BellOff} />
        <div>
          <CardTitle>Уведомления</CardTitle>
          <CardDescription>Состояние канала доставки.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        <Badge variant="outline">не настроены</Badge>
        <p className="text-sm leading-6 text-muted-foreground">{settings.notifications.reason}</p>
        <p className="text-xs text-stale">
          Watchdog продолжает фиксировать инциденты внутри дашборда независимо от внешних
          уведомлений.
        </p>
      </CardContent>
    </Card>
  );
}

function RetentionCard({ settings }: { settings: SettingsDto }) {
  const [exportError, setExportError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: exportWorkspace,
    onSuccess: ({ data }) => {
      const blob = new Blob([data.content], { type: data.mediaType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = data.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setExportError(null);
    },
    onError: (error) => setExportError(error.message),
  });
  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3 border-b">
        <CardIcon icon={Download} />
        <div>
          <CardTitle>Хранение и экспорт</CardTitle>
          <CardDescription>Ручной переносимый снимок без секретов.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <SettingRow
          label="Автоочистка"
          value={settings.retention.automaticCleanupEnabled ? "включена" : "отключена"}
        />
        <div>
          <FieldLabel>Включается</FieldLabel>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {settings.retention.exportIncludes.join(" · ")}
          </p>
        </div>
        <div>
          <FieldLabel>Не включается</FieldLabel>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {settings.retention.exportExcludes.join(" · ")}
          </p>
        </div>
        {exportError ? <p className="text-xs text-loss">{exportError}</p> : null}
        <Button variant="secondary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          <Download className="size-4" />
          {mutation.isPending ? "Подготовка…" : "Скачать JSON"}
        </Button>
      </CardContent>
    </Card>
  );
}

function SystemCard({ settings }: { settings: SettingsDto }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3 border-b">
        <CardIcon icon={ServerCog} />
        <div>
          <CardTitle>Система</CardTitle>
          <CardDescription>
            Диагностическая информация без конфигурационных секретов.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="pt-2">
        <SettingRow label="CryptoAnal" value={`v${settings.system.applicationVersion}`} />
        <SettingRow label="Environment" value={settings.runtimeSafety.environment} />
        <SettingRow
          label="Database"
          value={settings.system.database}
          tone={settings.system.database === "connected" ? "profit" : "loss"}
        />
        <SettingRow label="Workspace" value={settings.system.workspaceId} mono />
        <SettingRow label="Actor" value={settings.system.actorId} mono />
        <SettingRow label="Dry-run account" value={settings.exchange.accountId} mono />
      </CardContent>
    </Card>
  );
}

function SettingRow({
  label,
  value,
  hint,
  tone,
  mono,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "profit" | "loss" | undefined;
  mono?: boolean;
}) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-5 border-b border-row-border last:border-0">
      <span>
        <span className="block text-xs text-secondary-foreground">{label}</span>
        {hint ? <span className="mt-0.5 block text-[10px] text-stale">{hint}</span> : null}
      </span>
      <span
        className={`${mono ? "font-mono text-[11px]" : "text-xs"} ${tone === "profit" ? "text-profit" : tone === "loss" ? "text-loss" : "text-muted-foreground"}`}
      >
        {value}
      </span>
    </div>
  );
}

function CardIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-secondary text-muted-foreground">
      <Icon className="size-4" />
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1.5">
      <FieldLabel>{label}</FieldLabel>
      {children}
    </label>
  );
}

function SettingsSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-20" />
      <div className="grid gap-[18px] xl:grid-cols-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-72" />
        ))}
      </div>
    </div>
  );
}

function formatInterval(value: number) {
  if (value % 60_000 === 0) return `${value / 60_000} мин`;
  return `${value / 1_000} сек`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short" }).format(
    new Date(value),
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

const timezones = ["UTC", "Europe/Moscow", "Asia/Novosibirsk", "Asia/Almaty", "Asia/Dubai"];
