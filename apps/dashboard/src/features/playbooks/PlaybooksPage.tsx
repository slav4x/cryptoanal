import type { PlaybookDto, PlaybookQueryDto, PlaybookStatus } from "@cryptoanal/contracts";
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
  ArrowUpRight,
  BookMarked,
  Check,
  FilePenLine,
  Plus,
  RotateCcw,
  Search,
  ShieldAlert,
} from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiClientError, changePlaybookStatus, fetchPlaybooks } from "../../shared/api";
import { formatMoney } from "../../shared/format";
import { PlaybookComposer } from "./PlaybookComposer";

export default function PlaybooksPage() {
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState<PlaybookQueryDto>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composer, setComposer] = useState<"create" | "edit" | null>(
    searchParams.get("new") === "1" ? "create" : null,
  );
  const query = useQuery({
    queryKey: ["playbooks", filters],
    queryFn: () => fetchPlaybooks(filters),
  });

  if (query.isPending) return <PlaybooksSkeleton />;
  if (query.isError)
    return (
      <div className="space-y-[18px]">
        <PageHeader title="Плейбуки" description="Библиотека торговых сетапов и правил." />
        <ErrorState
          description={query.error.message}
          requestId={query.error instanceof ApiClientError ? query.error.requestId : undefined}
          onRetry={() => void query.refetch()}
        />
      </div>
    );

  const library = query.data.data;
  const selected = library.items.find((item) => item.id === selectedId) ?? library.items[0] ?? null;

  return (
    <div className="space-y-[18px]">
      <PageHeader
        eyebrow="Исследования"
        title="Плейбуки"
        description="Повторяемые сетапы, критерии входа и условия отмены — отдельно от конфигурации стратегий."
        actions={
          <Button onClick={() => setComposer(composer === "create" ? null : "create")}>
            <Plus className="size-4" />
            Новый плейбук
          </Button>
        }
      />

      {composer ? (
        <PlaybookComposer
          key={composer === "edit" ? selected?.updatedAt : "create"}
          playbook={composer === "edit" ? selected : null}
          options={library.linkOptions}
          onClose={() => setComposer(null)}
          onSaved={(playbookId) => {
            setSelectedId(playbookId);
            setComposer(null);
          }}
        />
      ) : null}

      <div className="grid gap-3 xl:grid-cols-5">
        <MetricCard label="Всего" value={String(library.summary.total)} hint="В библиотеке" />
        <MetricCard
          label="Активные"
          value={String(library.summary.active)}
          hint="Доступны в работе"
        />
        <MetricCard
          label="Архив"
          value={String(library.summary.archived)}
          hint="Сохранены для истории"
        />
        <MetricCard
          label="Связи со стратегиями"
          value={String(library.summary.linkedStrategies)}
          hint="Без изменения config"
        />
        <MetricCard
          label="Примеры сделок"
          value={String(library.summary.exampleTrades)}
          hint="Фактические кейсы"
        />
      </div>

      <Card>
        <CardContent className="grid gap-3 pt-4 xl:grid-cols-[1.4fr_repeat(3,minmax(180px,0.65fr))]">
          <label className="space-y-1.5">
            <FieldLabel>Поиск</FieldLabel>
            <span className="relative block">
              <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-stale" />
              <Input
                className="pl-9"
                value={filters.query ?? ""}
                placeholder="Название, описание, условия"
                onChange={(event) => updateFilters({ query: event.target.value || undefined })}
              />
            </span>
          </label>
          <FilterSelect
            label="Статус"
            value={filters.status ?? ""}
            options={[
              { value: "", label: "Все статусы" },
              { value: "active", label: "Активные" },
              { value: "archived", label: "Архив" },
            ]}
            onChange={(status) =>
              updateFilters({ status: status ? (status as PlaybookStatus) : undefined })
            }
          />
          <FilterSelect
            label="Стратегия"
            value={filters.strategyId ?? ""}
            options={[
              { value: "", label: "Все стратегии" },
              ...library.filterOptions.strategies.map((item) => ({
                value: item.id,
                label: item.name,
              })),
            ]}
            onChange={(strategyId) => updateFilters({ strategyId: strategyId || undefined })}
          />
          <FilterSelect
            label="Тег"
            value={filters.tag ?? ""}
            options={[
              { value: "", label: "Все теги" },
              ...library.filterOptions.tags.map((tag) => ({ value: tag, label: tag })),
            ]}
            onChange={(tag) => updateFilters({ tag: tag || undefined })}
          />
        </CardContent>
      </Card>

      {library.items.length === 0 ? (
        <EmptyLibrary
          filtered={Object.values(filters).some(Boolean)}
          onCreate={() => setComposer("create")}
        />
      ) : (
        <div className="grid items-start gap-3 xl:grid-cols-[360px_minmax(0,1fr)]">
          <PlaybookList
            items={library.items}
            selectedId={selected?.id ?? null}
            onSelect={setSelectedId}
          />
          {selected ? (
            <PlaybookDetail
              playbook={selected}
              onEdit={() => setComposer("edit")}
              onStatusChanged={() => setComposer(null)}
            />
          ) : null}
        </div>
      )}
    </div>
  );

  function updateFilters(patch: Partial<PlaybookQueryDto>) {
    setFilters((current) => ({ ...current, ...patch }));
  }
}

function PlaybookList({
  items,
  selectedId,
  onSelect,
}: {
  items: PlaybookDto[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b">
        <CardTitle>Библиотека</CardTitle>
        <CardDescription>{items.length} по выбранным фильтрам</CardDescription>
      </CardHeader>
      <div className="divide-y divide-row-border">
        {items.map((item) => (
          <button
            key={item.id}
            className={cn(
              "block w-full px-4 py-3.5 text-left transition-colors hover:bg-secondary/45",
              selectedId === item.id && "bg-secondary/70",
            )}
            onClick={() => onSelect(item.id)}
          >
            <span className="flex items-center justify-between gap-3">
              <span className="truncate text-sm font-medium">{item.name}</span>
              <StatusBadge status={item.status} />
            </span>
            <span className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
              {item.description}
            </span>
            <span className="mt-2.5 flex items-center gap-3 font-mono text-[10px] text-stale">
              <span>{item.entryRules.length} входов</span>
              <span>{item.invalidationRules.length} отмен</span>
              <span>{item.exampleTrades.length} сделок</span>
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function PlaybookDetail({
  playbook,
  onEdit,
  onStatusChanged,
}: {
  playbook: PlaybookDto;
  onEdit: () => void;
  onStatusChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const nextStatus = playbook.status === "active" ? "archived" : "active";
  const mutation = useMutation({
    mutationFn: () =>
      changePlaybookStatus(playbook.id, {
        expectedStatus: playbook.status,
        status: nextStatus,
        reason:
          nextStatus === "archived"
            ? "Архивация из библиотеки плейбуков"
            : "Возврат в активную библиотеку",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["playbooks"] });
      setConfirming(false);
      onStatusChanged();
    },
  });

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 border-b">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={playbook.status} />
            {playbook.tags.map((tag) => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>
          <CardTitle className="text-base">{playbook.name}</CardTitle>
          <CardDescription className="mt-1 max-w-3xl leading-5">
            {playbook.description}
          </CardDescription>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" onClick={onEdit}>
            <FilePenLine className="size-4" />
            Изменить
          </Button>
          <Button variant="ghost" onClick={() => setConfirming((value) => !value)}>
            {playbook.status === "active" ? (
              <Archive className="size-4" />
            ) : (
              <RotateCcw className="size-4" />
            )}
            {playbook.status === "active" ? "В архив" : "Вернуть"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-4">
        {confirming ? (
          <div className="flex items-center justify-between gap-4 rounded-[10px] border border-warning/25 bg-warning/[0.06] px-3.5 py-3">
            <p className="text-xs text-secondary-foreground">
              {nextStatus === "archived"
                ? "Плейбук исчезнет из активной библиотеки, но останется в истории."
                : "Плейбук снова станет доступен в активной библиотеке."}
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Отмена
              </Button>
              <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
                Подтвердить
              </Button>
            </div>
          </div>
        ) : null}
        {mutation.error ? <p className="text-xs text-loss">{mutation.error.message}</p> : null}

        <section>
          <SectionLabel>Условия рынка</SectionLabel>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-secondary-foreground">
            {playbook.marketConditions}
          </p>
        </section>

        <div className="grid gap-4 xl:grid-cols-2">
          <RuleSection title="Правила входа" items={playbook.entryRules} icon="check" />
          <RuleSection title="Условия инвалидации" items={playbook.invalidationRules} icon="risk" />
          <RuleSection title="Правила выхода" items={playbook.exitRules} />
          <RuleSection title="Риск-правила" items={playbook.riskRules} />
        </div>

        <RuleSection title="Чек-лист перед входом" items={playbook.checklist} icon="check" />

        <div className="grid gap-4 border-t border-row-border pt-4 xl:grid-cols-2">
          <LinkedStrategies items={playbook.strategies} />
          <ExampleTrades items={playbook.exampleTrades} />
        </div>
        <p className="font-mono text-[10px] text-stale">
          Обновлён {formatDateTime(playbook.updatedAt)} · связи справочные и не меняют strategy
          config
        </p>
      </CardContent>
    </Card>
  );
}

function RuleSection({
  title,
  items,
  icon,
}: {
  title: string;
  items: string[];
  icon?: "check" | "risk";
}) {
  return (
    <section className="rounded-[10px] border border-row-border bg-background/45 p-3.5">
      <SectionLabel>{title}</SectionLabel>
      {items.length > 0 ? (
        <ol className="mt-2.5 space-y-2">
          {items.map((item, index) => (
            <li
              key={`${item}-${index}`}
              className="flex gap-2.5 text-sm leading-5 text-secondary-foreground"
            >
              {icon === "check" ? (
                <Check className="mt-0.5 size-3.5 shrink-0 text-profit" />
              ) : icon === "risk" ? (
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
              ) : (
                <span className="mt-0.5 w-3.5 shrink-0 font-mono text-[10px] text-stale">
                  {index + 1}.
                </span>
              )}
              <span>{item}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-xs text-stale">Не задано</p>
      )}
    </section>
  );
}

function LinkedStrategies({ items }: { items: PlaybookDto["strategies"] }) {
  return (
    <section>
      <SectionLabel>Связанные стратегии</SectionLabel>
      <div className="mt-2 space-y-1.5">
        {items.length > 0 ? (
          items.map((item) => (
            <Button key={item.id} asChild variant="ghost" className="w-full justify-between">
              <Link to={`/strategies/${item.id}`}>
                {item.name}
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          ))
        ) : (
          <p className="text-xs text-stale">Связей нет</p>
        )}
      </div>
    </section>
  );
}

function ExampleTrades({ items }: { items: PlaybookDto["exampleTrades"] }) {
  return (
    <section>
      <SectionLabel>Примеры сделок</SectionLabel>
      <div className="mt-2 space-y-1.5">
        {items.length > 0 ? (
          items.map((item) => (
            <Link
              key={item.id}
              to={`/trades/${item.id}`}
              className="flex items-center justify-between rounded-[8px] px-2.5 py-2 text-xs transition-colors hover:bg-secondary"
            >
              <span>
                {item.symbol} · {item.side.toUpperCase()} · {item.closedAt.slice(0, 10)}
              </span>
              <span className={Number(item.netPnl) >= 0 ? "text-profit" : "text-loss"}>
                {formatMoney(item.netPnl)}
              </span>
            </Link>
          ))
        ) : (
          <p className="text-xs text-stale">Примеры пока не добавлены</p>
        )}
      </div>
    </section>
  );
}

function EmptyLibrary({ filtered, onCreate }: { filtered: boolean; onCreate: () => void }) {
  return (
    <Card>
      <CardContent className="grid min-h-64 place-items-center text-center">
        <div>
          <BookMarked className="mx-auto mb-3 size-7 text-stale" />
          <p className="text-sm">
            {filtered ? "По выбранным фильтрам ничего нет" : "Библиотека пуста"}
          </p>
          <p className="mt-1 text-xs text-stale">
            {filtered
              ? "Измените фильтры или создайте новый плейбук."
              : "Зафиксируйте первый повторяемый торговый сетап."}
          </p>
          <Button className="mt-4" onClick={onCreate}>
            <Plus className="size-4" />
            Создать плейбук
          </Button>
        </div>
      </CardContent>
    </Card>
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
    <div className="space-y-1.5">
      <FieldLabel>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange}>
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

function StatusBadge({ status }: { status: PlaybookStatus }) {
  return (
    <Badge variant={status === "active" ? "profit" : "outline"}>
      {status === "active" ? "активен" : "архив"}
    </Badge>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[10px] uppercase tracking-[0.1em] text-stale">{children}</h3>;
}

function PlaybooksSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-20 w-full" />
      <div className="grid gap-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-20" />
      <div className="grid gap-3 xl:grid-cols-[360px_1fr]">
        <Skeleton className="h-[520px]" />
        <Skeleton className="h-[520px]" />
      </div>
    </div>
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
