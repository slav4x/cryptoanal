import type { MarketCatalogInstrumentDto } from "@cryptoanal/contracts";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  Input,
  PageHeader,
  Skeleton,
  cn,
} from "@cryptoanal/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, LoaderCircle, Plus, Search, Star, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  addMarkets,
  ApiClientError,
  fetchMarketCatalog,
  fetchMarkets,
  removeMarket,
} from "../../shared/api";
import { formatPercent, formatPrice } from "../../shared/format";
import { useAuthSession } from "../auth/auth-context";
import { useWatchlistMutation } from "./useWatchlistMutation";

export default function MarketsPage() {
  const session = useAuthSession();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const search = searchParams.get("q") ?? "";
  const watchlistOnly = searchParams.get("scope") === "watchlist";
  const canManage = session.activeWorkspace.role === "owner";
  const watchlistMutation = useWatchlistMutation();
  const marketsQuery = useQuery({
    queryKey: ["markets"],
    queryFn: fetchMarkets,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const removeMutation = useMutation({
    mutationFn: removeMarket,
    onSuccess: async (_result, symbol) => {
      setPendingRemoval(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["markets"] }),
        queryClient.invalidateQueries({ queryKey: ["market-catalog"] }),
        queryClient.invalidateQueries({ queryKey: ["market", symbol] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
    },
  });

  const markets = marketsQuery.data?.data.items;
  const filteredMarkets = useMemo(() => {
    if (!markets) return [];
    const normalized = search.trim().toUpperCase();
    return markets.filter(
      (market) =>
        (!watchlistOnly || market.watchlisted) &&
        (!normalized ||
          market.symbol.includes(normalized) ||
          market.baseAsset.includes(normalized) ||
          market.quoteAsset.includes(normalized)),
    );
  }, [markets, search, watchlistOnly]);
  const watchlistCount = markets?.filter((market) => market.watchlisted).length ?? 0;

  function updateFilters(next: { search?: string; watchlistOnly?: boolean }) {
    const params = new URLSearchParams(searchParams);
    if (next.search !== undefined) {
      if (next.search) params.set("q", next.search);
      else params.delete("q");
    }
    if (next.watchlistOnly !== undefined) {
      if (next.watchlistOnly) params.set("scope", "watchlist");
      else params.delete("scope");
    }
    setSearchParams(params, { replace: true });
  }

  return (
    <div className="space-y-[18px]">
      <PageHeader
        title="Рынки"
        description="Торговые пары workspace, watchlist и актуальность рыночных данных."
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="outline">Bybit · Linear</Badge>
            <Button
              type="button"
              size="sm"
              onClick={() => setCatalogOpen(true)}
              disabled={!canManage}
              title={canManage ? undefined : "Управлять рынком может только владелец workspace"}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              Добавить пары
            </Button>
          </div>
        }
      />

      <Card>
        <CardHeader className="flex-col gap-3 border-b sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Инструменты</CardTitle>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <div className="flex shrink-0 rounded-full border border-input bg-background p-0.5">
              <FilterButton
                active={!watchlistOnly}
                onClick={() => updateFilters({ watchlistOnly: false })}
              >
                Все {markets?.length ?? 0}
              </FilterButton>
              <FilterButton
                active={watchlistOnly}
                onClick={() => updateFilters({ watchlistOnly: true })}
              >
                Watchlist {watchlistCount}
              </FilterButton>
            </div>
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => updateFilters({ search: event.target.value })}
                className="pl-9"
                placeholder="Найти пару"
                aria-label="Поиск торговой пары"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {pendingRemoval ? (
            <div className="flex items-center justify-between gap-4 border-b border-warning/20 bg-warning/5 px-5 py-3">
              <div>
                <p className="text-[13px] font-medium">Удалить {pendingRemoval} из рынка?</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Новые данные перестанут загружаться, накопленная история сохранится.
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPendingRemoval(null);
                    removeMutation.reset();
                  }}
                  disabled={removeMutation.isPending}
                >
                  Отмена
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => removeMutation.mutate(pendingRemoval)}
                  disabled={removeMutation.isPending}
                >
                  {removeMutation.isPending ? "Удаляем…" : "Удалить"}
                </Button>
              </div>
            </div>
          ) : null}
          {removeMutation.isError ? (
            <p className="border-b border-loss/20 bg-loss/5 px-5 py-2.5 text-xs text-loss">
              Не удалось удалить пару: {removeMutation.error.message}
            </p>
          ) : null}
          {watchlistMutation.isError ? (
            <p className="border-b border-loss/20 bg-loss/5 px-5 py-2.5 text-xs text-loss">
              Не удалось изменить watchlist: {watchlistMutation.error.message}
            </p>
          ) : null}
          {marketsQuery.isPending ? <MarketsSkeleton /> : null}
          {marketsQuery.isError ? (
            <div className="px-5 pb-5">
              <ErrorState
                description={marketsQuery.error.message}
                requestId={
                  marketsQuery.error instanceof ApiClientError
                    ? marketsQuery.error.requestId
                    : undefined
                }
                onRetry={() => void marketsQuery.refetch()}
              />
            </div>
          ) : null}
          {marketsQuery.isSuccess ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                    <th scope="col" className="h-10 px-5 font-medium">
                      Пара
                    </th>
                    <th scope="col" className="h-10 px-4 text-right font-medium">
                      Цена
                    </th>
                    <th scope="col" className="h-10 px-4 text-right font-medium">
                      24 часа
                    </th>
                    <th scope="col" className="h-10 px-4 text-right font-medium">
                      Объём
                    </th>
                    <th scope="col" className="h-10 px-4 font-medium">
                      Режим
                    </th>
                    <th scope="col" className="h-10 px-4 text-right font-medium">
                      Данные
                    </th>
                    <th scope="col" className="h-10 px-5 text-right font-medium">
                      <span className="sr-only">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMarkets.map((market) => {
                    const change = Number(market.change24hPercent ?? 0);
                    return (
                      <tr
                        key={market.symbol}
                        className="h-(--table-row-height) border-b border-row-border last:border-0 hover:bg-row-hover"
                      >
                        <td className="px-5">
                          <div className="flex items-center gap-3">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0"
                              aria-label={
                                market.watchlisted
                                  ? `Убрать ${market.symbol} из watchlist`
                                  : `Добавить ${market.symbol} в watchlist`
                              }
                              aria-pressed={market.watchlisted}
                              disabled={
                                watchlistMutation.isPending &&
                                watchlistMutation.variables?.symbol === market.symbol
                              }
                              onClick={() =>
                                watchlistMutation.mutate({
                                  symbol: market.symbol,
                                  watchlisted: !market.watchlisted,
                                })
                              }
                            >
                              <Star
                                className={
                                  market.watchlisted
                                    ? "fill-warning text-warning"
                                    : "text-muted-foreground"
                                }
                                aria-hidden="true"
                              />
                            </Button>
                            <div>
                              <Link
                                to={`/markets/${market.symbol}`}
                                className="group inline-flex items-center gap-1 font-mono font-medium hover:text-white"
                              >
                                {market.symbol}
                                <ArrowUpRight
                                  className="size-3 text-stale transition-colors group-hover:text-foreground"
                                  aria-hidden="true"
                                />
                              </Link>
                              <div className="text-xs text-muted-foreground">
                                {market.exchange} · {market.instrumentType}
                              </div>
                              {market.status !== "Trading" ? (
                                <Badge variant="warning" className="mt-1">
                                  {marketStatusLabel(market.status)}
                                </Badge>
                              ) : null}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 text-right font-mono tabular-nums">
                          {formatPrice(market.price)}
                        </td>
                        <td
                          className={`px-4 text-right font-mono tabular-nums ${market.change24hPercent === null ? "text-muted-foreground" : change >= 0 ? "text-profit" : "text-loss"}`}
                        >
                          {formatPercent(market.change24hPercent)}
                        </td>
                        <td className="px-4 text-right font-mono tabular-nums text-muted-foreground">
                          {formatPrice(market.volume24h)}
                        </td>
                        <td className="px-4">
                          <Badge variant="outline">{regimeLabel[market.regime]}</Badge>
                        </td>
                        <td className="px-4 text-right">
                          <Badge variant={market.freshness === "fresh" ? "profit" : "warning"}>
                            {freshnessLabel[market.freshness]}
                          </Badge>
                        </td>
                        <td className="px-5 text-right">
                          {canManage ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-7 text-muted-foreground hover:text-loss"
                              aria-label={`Удалить ${market.symbol} из рынка`}
                              onClick={() => {
                                removeMutation.reset();
                                setPendingRemoval(market.symbol);
                              }}
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" />
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredMarkets.length === 0 ? (
                <div className="px-5 py-12 text-center">
                  <p className="text-sm text-muted-foreground">
                    {markets?.length === 0
                      ? "В рынок ещё не добавлены торговые пары."
                      : "По этому запросу пары не найдены."}
                  </p>
                  {markets?.length === 0 && canManage ? (
                    <Button className="mt-4" size="sm" onClick={() => setCatalogOpen(true)}>
                      <Plus className="size-3.5" aria-hidden="true" />
                      Добавить пары
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <AddMarketsDialog
        open={catalogOpen}
        onOpenChange={setCatalogOpen}
        workspaceId={session.activeWorkspace.id}
      />
    </div>
  );
}

function AddMarketsDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const catalogQuery = useQuery({
    queryKey: ["market-catalog", workspaceId],
    queryFn: fetchMarketCatalog,
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const addMutation = useMutation({
    mutationFn: (instrumentIds: string[]) => addMarkets(instrumentIds),
    onSuccess: async () => {
      setSelected(new Set());
      setSearch("");
      onOpenChange(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["markets"] }),
        queryClient.invalidateQueries({ queryKey: ["market-catalog", workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
    },
  });
  const filteredItems = useMemo(() => {
    const items = catalogQuery.data?.data.items ?? [];
    const normalized = search.trim().toUpperCase();
    return items.filter(
      (item) =>
        !normalized ||
        item.symbol.includes(normalized) ||
        item.baseAsset.includes(normalized) ||
        item.quoteAsset.includes(normalized),
    );
  }, [catalogQuery.data?.data.items, search]);

  function setOpen(nextOpen: boolean) {
    if (!nextOpen && !addMutation.isPending) {
      setSelected(new Set());
      setSearch("");
      addMutation.reset();
    }
    onOpenChange(nextOpen);
  }

  function toggle(item: MarketCatalogInstrumentDto) {
    if (item.added) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Добавить торговые пары</DialogTitle>
          <DialogDescription>
            Доступные USDT perpetual-инструменты из подтверждённого подключения Bybit.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value.toUpperCase())}
              className="pl-9"
              placeholder="BTC, ETH, SOL…"
              aria-label="Поиск доступной торговой пары"
              autoFocus
            />
          </div>

          {catalogQuery.isPending ? (
            <div className="space-y-2 py-2">
              {Array.from({ length: 8 }, (_, index) => (
                <Skeleton key={index} className="h-14 w-full" />
              ))}
            </div>
          ) : null}
          {catalogQuery.isError ? (
            <ErrorState
              description={catalogQuery.error.message}
              requestId={
                catalogQuery.error instanceof ApiClientError
                  ? catalogQuery.error.requestId
                  : undefined
              }
              onRetry={() => void catalogQuery.refetch()}
            />
          ) : null}

          {catalogQuery.isSuccess && !catalogQuery.data.data.source.connected ? (
            <div className="rounded-[10px] border border-warning/20 bg-warning/5 p-4">
              <p className="text-sm font-medium">Нет активного подключения Bybit</p>
              <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
                Добавьте API-ключ в настройках и завершите проверку подключения. После этого каталог
                инструментов станет доступен.
              </p>
              <Button asChild variant="outline" size="sm" className="mt-4">
                <Link to="/settings">Открыть настройки</Link>
              </Button>
            </div>
          ) : null}

          {catalogQuery.isSuccess && catalogQuery.data.data.source.connected ? (
            <div className="min-h-0 flex-1 overflow-y-auto rounded-[10px] border border-row-border">
              {filteredItems.map((item) => {
                const checked = selected.has(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="checkbox"
                    aria-checked={item.added || checked}
                    disabled={item.added}
                    onClick={() => toggle(item)}
                    className="flex min-h-14 w-full items-center gap-3 border-b border-row-border px-3 text-left outline-none last:border-0 hover:bg-row-hover focus-visible:bg-accent disabled:cursor-default disabled:opacity-55"
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input",
                        checked && "border-primary bg-primary text-primary-foreground",
                        item.added && "border-profit/40 bg-profit/10 text-profit",
                      )}
                    >
                      {checked || item.added ? (
                        <Check className="size-3" aria-hidden="true" />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-[13px] font-medium">{item.symbol}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        Tick {item.tickSize} · Qty step {item.qtyStep} · Min {item.minOrderQty} · ≥{" "}
                        {item.minNotional} USDT
                      </span>
                    </span>
                    {item.added ? <Badge variant="outline">Добавлена</Badge> : null}
                  </button>
                );
              })}
              {filteredItems.length === 0 ? (
                <p className="px-4 py-12 text-center text-sm text-muted-foreground">
                  Подходящие инструменты не найдены.
                </p>
              ) : null}
            </div>
          ) : null}

          {addMutation.isError ? (
            <p className="mt-3 text-xs text-loss">
              Не удалось добавить пары: {addMutation.error.message}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <p className="text-xs text-muted-foreground">Выбрано: {selected.size}</p>
          <div className="flex gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm" disabled={addMutation.isPending}>
                Отмена
              </Button>
            </DialogClose>
            <Button
              size="sm"
              disabled={selected.size === 0 || addMutation.isPending}
              onClick={() => addMutation.mutate([...selected])}
            >
              {addMutation.isPending ? (
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="size-3.5" aria-hidden="true" />
              )}
              {addMutation.isPending ? "Добавляем…" : `Добавить ${selected.size || ""}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-7 rounded-full px-3 text-[11px] text-muted-foreground",
        active && "bg-avatar text-foreground",
      )}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

const regimeLabel = {
  bull: "Bull",
  bear: "Bear",
  neutral: "Neutral",
  unknown: "Не определён",
} as const;
const freshnessLabel = { fresh: "Свежие", stale: "Устарели", unavailable: "Нет данных" } as const;

function marketStatusLabel(status: string) {
  if (status === "Settling") return "Расчёт";
  if (status === "Closed") return "Закрыт";
  if (status === "Unavailable") return "Недоступен";
  return status;
}

function MarketsSkeleton() {
  return (
    <div className="space-y-1 px-5 pb-5">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-11 w-full" />
      ))}
    </div>
  );
}
