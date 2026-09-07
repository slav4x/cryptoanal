import type {
  JournalDto,
  JournalEntryKind,
  JournalLinkType,
  JournalQueryDto,
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
  MetricCard,
  PageHeader,
  Select,
  Skeleton,
  cn,
} from "@cryptoanal/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowDown, BookOpenText, CalendarRange, ExternalLink, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiClientError, fetchJournal } from "../../shared/api";
import { JournalEntryComposer } from "./JournalEntryComposer";
import { ReviewSessionComposer } from "./ReviewSessionComposer";

type View = "entries" | "reviews";

export default function JournalPage() {
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState<JournalQueryDto>({ period: "30d", limit: 30 });
  const [view, setView] = useState<View>("entries");
  const [composer, setComposer] = useState<"entry" | "review" | null>(
    searchParams.get("new") === "1" ? "entry" : null,
  );
  const initialLink = parseInitialLink(searchParams);
  const journalQuery = useInfiniteQuery({
    queryKey: ["journal", filters],
    queryFn: ({ pageParam }) => fetchJournal(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.data.nextCursor ?? undefined,
  });

  if (journalQuery.isPending) return <JournalSkeleton />;
  if (journalQuery.isError)
    return (
      <div className="space-y-[18px]">
        <PageHeader title="Разбор" description="Исследовательский журнал и review sessions." />
        <ErrorState
          description={journalQuery.error.message}
          requestId={
            journalQuery.error instanceof ApiClientError ? journalQuery.error.requestId : undefined
          }
          onRetry={() => void journalQuery.refetch()}
        />
      </div>
    );

  const firstPage = journalQuery.data.pages[0]!.data;
  const entries = journalQuery.data.pages.flatMap((page) => page.data.entries);

  return (
    <div className="space-y-[18px]">
      <PageHeader
        eyebrow="Исследования"
        title="Разбор"
        description="Гипотезы, наблюдения и решения с привязкой к фактическим результатам."
        actions={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => setComposer(composer === "review" ? null : "review")}
            >
              <CalendarRange className="size-4" />
              Новый разбор
            </Button>
            <Button onClick={() => setComposer(composer === "entry" ? null : "entry")}>
              <Plus className="size-4" />
              Новая запись
            </Button>
          </div>
        }
      />

      {composer === "entry" ? (
        <JournalEntryComposer
          options={firstPage.linkOptions}
          initialLink={initialLink}
          onClose={() => setComposer(null)}
        />
      ) : null}
      {composer === "review" ? (
        <ReviewSessionComposer
          currentDate={journalQuery.data.pages[0]!.meta.generatedAt}
          onClose={() => setComposer(null)}
        />
      ) : null}

      <Card>
        <CardContent className="grid gap-3 pt-4 xl:grid-cols-5">
          <FilterSelect
            label="Период"
            value={filters.period}
            options={periodOptions}
            onChange={(period) => updateFilters({ period })}
          />
          <FilterSelect
            label="Тип"
            value={filters.kind ?? ""}
            options={[
              { value: "", label: "Все типы" },
              ...firstPage.filterOptions.kinds.map((kind) => ({
                value: kind,
                label: kindLabels[kind],
              })),
            ]}
            onChange={(kind) =>
              updateFilters({ kind: kind ? (kind as JournalEntryKind) : undefined })
            }
          />
          <FilterSelect
            label="Стратегия"
            value={filters.strategyId ?? ""}
            options={[
              { value: "", label: "Все стратегии" },
              ...firstPage.filterOptions.strategies.map((item) => ({
                value: item.id,
                label: item.name,
              })),
            ]}
            onChange={(strategyId) => updateFilters({ strategyId: strategyId || undefined })}
          />
          <FilterSelect
            label="Пара"
            value={filters.symbol ?? ""}
            options={[
              { value: "", label: "Все пары" },
              ...firstPage.filterOptions.symbols.map((symbol) => ({
                value: symbol,
                label: symbol,
              })),
            ]}
            onChange={(symbol) => updateFilters({ symbol: symbol || undefined })}
          />
          <FilterSelect
            label="Тег"
            value={filters.tag ?? ""}
            options={[
              { value: "", label: "Все теги" },
              ...firstPage.filterOptions.tags.map((tag) => ({ value: tag, label: tag })),
            ]}
            onChange={(tag) => updateFilters({ tag: tag || undefined })}
          />
        </CardContent>
      </Card>

      <div className="grid gap-3 xl:grid-cols-6">
        <MetricCard
          label="Записей"
          value={String(firstPage.summary.total)}
          hint={periodLabels[filters.period]}
        />
        <MetricCard
          label="Гипотезы"
          value={String(firstPage.summary.hypothesis)}
          hint="На проверку"
        />
        <MetricCard label="Наблюдения" value={String(firstPage.summary.observation)} hint="Факты" />
        <MetricCard label="Выводы" value={String(firstPage.summary.conclusion)} hint="Результаты" />
        <MetricCard
          label="Решения"
          value={String(firstPage.summary.decision)}
          hint="Следующие шаги"
        />
        <MetricCard
          label="Разборы"
          value={String(firstPage.summary.reviews)}
          hint="Зафиксировано"
        />
      </div>

      <div
        className="flex gap-1 border-b border-row-border"
        role="tablist"
        aria-label="Разделы журнала"
      >
        <Tab active={view === "entries"} onClick={() => setView("entries")}>
          Записи
        </Tab>
        <Tab active={view === "reviews"} onClick={() => setView("reviews")}>
          Разборы периода
        </Tab>
      </div>

      {view === "entries" ? (
        <EntryList
          entries={entries}
          hasMore={journalQuery.hasNextPage}
          loadingMore={journalQuery.isFetchingNextPage}
          onLoadMore={() => void journalQuery.fetchNextPage()}
        />
      ) : (
        <ReviewList reviews={firstPage.reviews} />
      )}
    </div>
  );

  function updateFilters(patch: Partial<JournalQueryDto>) {
    setFilters((current) => ({ ...current, ...patch }));
  }
}

function EntryList({
  entries,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  entries: JournalDto["entries"];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  if (entries.length === 0)
    return (
      <Card>
        <CardContent className="grid min-h-52 place-items-center text-center">
          <div>
            <BookOpenText className="mx-auto mb-3 size-6 text-stale" />
            <p className="text-sm">Записей по выбранным фильтрам нет.</p>
            <p className="mt-1 text-xs text-stale">
              Зафиксируйте гипотезу или наблюдение и свяжите его с данными.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <Card key={entry.id}>
          <CardHeader className="flex-row items-start justify-between border-b">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <KindBadge kind={entry.kind} />
                <span className="font-mono text-[10px] text-stale">
                  {formatDateTime(entry.occurredAt)}
                </span>
              </div>
              <CardTitle>{entry.title}</CardTitle>
            </div>
            {entry.links.length > 0 ? (
              <Badge variant="outline">{entry.links.length} связей</Badge>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <p className="whitespace-pre-wrap text-sm leading-6 text-secondary-foreground">
              {entry.body}
            </p>
            {entry.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {entry.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-avatar px-2 py-1 font-mono text-[10px] text-muted-foreground"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            ) : null}
            {entry.links.length > 0 ? (
              <div className="flex flex-wrap gap-2 border-t border-row-border pt-3">
                {entry.links.map((link) =>
                  link.href ? (
                    <Button
                      key={`${link.type}:${link.targetId}`}
                      asChild
                      variant="secondary"
                      size="sm"
                    >
                      <Link to={link.href}>
                        {link.label}
                        <ExternalLink className="size-3.5" />
                      </Link>
                    </Button>
                  ) : null,
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ))}
      {hasMore ? (
        <div className="text-center">
          <Button variant="ghost" size="sm" disabled={loadingMore} onClick={onLoadMore}>
            <ArrowDown className="size-3.5" />
            {loadingMore ? "Загрузка…" : "Загрузить ещё"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ReviewList({ reviews }: { reviews: JournalDto["reviews"] }) {
  if (reviews.length === 0)
    return (
      <Card>
        <CardContent className="grid min-h-52 place-items-center text-center">
          <div>
            <CalendarRange className="mx-auto mb-3 size-6 text-stale" />
            <p className="text-sm">Разборов периода пока нет.</p>
            <p className="mt-1 text-xs text-stale">Сгруппируйте записи и зафиксируйте выводы.</p>
          </div>
        </CardContent>
      </Card>
    );
  return (
    <div className="space-y-3">
      {reviews.map((review) => (
        <Card key={review.id}>
          <CardHeader className="flex-row items-start justify-between border-b">
            <div>
              <CardTitle>{review.title}</CardTitle>
              <CardDescription>
                {formatDate(review.startsAt)} — {formatDate(review.endsAt)}
              </CardDescription>
            </div>
            <Badge variant="outline">{review.entryCount} записей</Badge>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <p className="whitespace-pre-wrap text-sm leading-6 text-secondary-foreground">
              {review.summary}
            </p>
            <div className="grid gap-4 xl:grid-cols-2">
              <ReviewItems title="Выводы" items={review.learnings} />
              <ReviewItems title="Следующие действия" items={review.nextActions} />
            </div>
            {review.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 border-t border-row-border pt-3">
                {review.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-avatar px-2 py-1 font-mono text-[10px] text-muted-foreground"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ReviewItems({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <h3 className="text-[10px] uppercase tracking-[0.1em] text-stale">{title}</h3>
      {items.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {items.map((item) => (
            <li key={item} className="flex gap-2 text-xs leading-5 text-secondary-foreground">
              <span className="text-stale">—</span>
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-stale">Не указаны.</p>
      )}
    </section>
  );
}
function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={cn(
        "border-b-2 px-3 py-2.5 text-xs",
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-stale hover:text-foreground",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function KindBadge({ kind }: { kind: JournalEntryKind }) {
  return (
    <Badge variant={kind === "decision" ? "profit" : kind === "hypothesis" ? "default" : "outline"}>
      {kindLabels[kind]}
    </Badge>
  );
}
function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <label className="space-y-1.5">
      <FieldLabel>{label}</FieldLabel>
      <Select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </label>
  );
}

function parseInitialLink(
  params: URLSearchParams,
): { type: JournalLinkType; targetId: string } | null {
  const type = params.get("type");
  const targetId = params.get("targetId");
  if (!targetId || !type || !linkTypes.includes(type as JournalLinkType)) return null;
  return { type: type as JournalLinkType, targetId };
}
function formatDateTime(value: string) {
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function formatDate(value: string) {
  return new Date(value).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function JournalSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-16" />
      <Skeleton className="h-20" />
      <div className="grid gap-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}

const linkTypes: JournalLinkType[] = [
  "strategy",
  "strategy-version",
  "execution-run",
  "validation-run",
  "trade",
  "decision",
  "symbol",
];
const kindLabels: Record<JournalEntryKind, string> = {
  hypothesis: "Гипотеза",
  observation: "Наблюдение",
  conclusion: "Вывод",
  decision: "Решение",
};
const periodOptions: Array<{ value: JournalQueryDto["period"]; label: string }> = [
  { value: "7d", label: "7 дней" },
  { value: "30d", label: "30 дней" },
  { value: "90d", label: "90 дней" },
  { value: "all", label: "Всё время" },
];
const periodLabels = {
  "7d": "7 дней",
  "30d": "30 дней",
  "90d": "90 дней",
  all: "Всё время",
} as const;
