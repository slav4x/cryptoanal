import type { SettingsDto, TableDensity, WorkspacePreferencesDto } from "@cryptoanal/contracts";
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
  PageHeader,
  Select,
  Skeleton,
} from "@cryptoanal/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, Download, Gauge, Globe2, Save, ServerCog, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import {
  ApiClientError,
  exportWorkspace,
  fetchSettings,
  updateWorkspacePreferences,
} from "../../shared/api";

export default function SettingsPage() {
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
        <PreferencesCard key={settings.preferences.updatedAt} preferences={settings.preferences} />
        <RuntimeSafetyCard settings={settings} />
        <MarketDataCard settings={settings} />
        <NotificationsCard settings={settings} />
        <RetentionCard settings={settings} />
        <SystemCard settings={settings} />
      </div>
    </div>
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
          value="не настроен"
          hint="Добавляется после авторизации и разделения workspace"
        />
      </CardContent>
    </Card>
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

const timezones = ["UTC", "Europe/Moscow", "Asia/Novosibirsk", "Asia/Almaty", "Asia/Dubai"];
