import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Input,
  PageHeader,
  Skeleton,
  cn,
} from "@cryptoanal/ui";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Search, Star } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiClientError, fetchMarkets } from "../../shared/api";
import { formatPercent, formatPrice } from "../../shared/format";
import { useWatchlistMutation } from "./useWatchlistMutation";

export default function MarketsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get("q") ?? "";
  const watchlistOnly = searchParams.get("scope") === "watchlist";
  const watchlistMutation = useWatchlistMutation();
  const marketsQuery = useQuery({
    queryKey: ["markets"],
    queryFn: fetchMarkets,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
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
        description="Торговые пары, watchlist и актуальность рыночных данных."
        actions={<Badge variant="outline">Bybit · Linear</Badge>}
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
              <table className="w-full min-w-[760px] border-collapse text-[13px]">
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
                    <th scope="col" className="h-10 px-5 text-right font-medium">
                      Данные
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
                              <div className="text-xs text-muted-foreground">{market.exchange}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 text-right font-mono tabular-nums">
                          {formatPrice(market.price)}
                        </td>
                        <td
                          className={`px-4 text-right font-mono tabular-nums ${
                            market.change24hPercent === null
                              ? "text-muted-foreground"
                              : change >= 0
                                ? "text-profit"
                                : "text-loss"
                          }`}
                        >
                          {formatPercent(market.change24hPercent)}
                        </td>
                        <td className="px-4 text-right font-mono tabular-nums text-muted-foreground">
                          {formatPrice(market.volume24h)}
                        </td>
                        <td className="px-4">
                          <Badge variant="outline">{regimeLabel[market.regime]}</Badge>
                        </td>
                        <td className="px-5 text-right">
                          <Badge variant={market.freshness === "fresh" ? "profit" : "warning"}>
                            {freshnessLabel[market.freshness]}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredMarkets.length === 0 ? (
                <p className="px-5 py-12 text-center text-sm text-muted-foreground">
                  По этому запросу пары не найдены.
                </p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
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

const freshnessLabel = {
  fresh: "Свежие",
  stale: "Устарели",
  unavailable: "Нет данных",
} as const;

function MarketsSkeleton() {
  return (
    <div className="space-y-1 px-5 pb-5">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-11 w-full" />
      ))}
    </div>
  );
}
