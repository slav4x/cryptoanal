import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Input,
  PageHeader,
  Skeleton,
} from "@cryptoanal/ui";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Search, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiClientError, fetchMarkets } from "../../shared/api";
import { formatPercent, formatPrice } from "../../shared/format";

export default function MarketsPage() {
  const [search, setSearch] = useState("");
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
    if (!normalized) return markets;
    return markets.filter(
      (market) =>
        market.symbol.includes(normalized) ||
        market.baseAsset.includes(normalized) ||
        market.quoteAsset.includes(normalized),
    );
  }, [markets, search]);

  return (
    <div className="space-y-[18px]">
      <PageHeader
        title="Рынки"
        description="Торговые пары, watchlist и актуальность рыночных данных."
        actions={<Badge variant="outline">Bybit · Linear</Badge>}
      />

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4 border-b">
          <CardTitle>Инструменты</CardTitle>
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9"
              placeholder="Найти пару"
              aria-label="Поиск торговой пары"
            />
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
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
              <table className="w-full min-w-[760px] border-collapse text-sm">
                <thead>
                  <tr className="border-b text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                    <th className="h-10 px-5 font-medium">Пара</th>
                    <th className="h-10 px-4 text-right font-medium">Цена</th>
                    <th className="h-10 px-4 text-right font-medium">24 часа</th>
                    <th className="h-10 px-4 text-right font-medium">Объём</th>
                    <th className="h-10 px-4 font-medium">Режим</th>
                    <th className="h-10 px-5 text-right font-medium">Данные</th>
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
                            <Star
                              className={
                                market.watchlisted
                                  ? "size-4 fill-warning text-warning"
                                  : "size-4 text-muted-foreground"
                              }
                              aria-label={market.watchlisted ? "В watchlist" : "Не в watchlist"}
                            />
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
