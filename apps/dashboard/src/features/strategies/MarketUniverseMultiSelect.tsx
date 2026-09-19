import type { MarketsDto } from "@cryptoanal/contracts";
import { Badge, Button, Input, Popover, PopoverContent, PopoverTrigger, cn } from "@cryptoanal/ui";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchMarkets } from "../../shared/api";

type Market = MarketsDto["items"][number];

export function MarketUniverseMultiSelect({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const marketsQuery = useQuery({
    queryKey: ["markets"],
    queryFn: fetchMarkets,
    staleTime: 30_000,
  });
  const markets = useMemo(() => marketsQuery.data?.data.items ?? [], [marketsQuery.data]);
  const marketSymbols = useMemo(() => new Set(markets.map(({ symbol }) => symbol)), [markets]);
  const unavailableSymbols = marketsQuery.isSuccess
    ? value.filter((symbol) => !marketSymbols.has(symbol))
    : [];
  const filteredMarkets = useMemo(() => {
    const normalized = search.trim().toUpperCase();
    return markets.filter(
      (market) =>
        !normalized ||
        market.symbol.includes(normalized) ||
        market.baseAsset.includes(normalized) ||
        market.quoteAsset.includes(normalized),
    );
  }, [markets, search]);

  function toggle(market: Market) {
    onChange(
      value.includes(market.symbol)
        ? value.filter((symbol) => symbol !== market.symbol)
        : [...value, market.symbol],
    );
  }

  function setPopoverOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) setSearch("");
  }

  const summary =
    value.length === 0
      ? marketsQuery.isPending
        ? "Загружаем пары…"
        : "Выберите пары из рынка"
      : value.join(", ");

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            id="strategy-symbols"
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-invalid={unavailableSymbols.length > 0 || undefined}
            className={cn(
              "h-9 w-full min-w-0 justify-between gap-2 px-3 font-normal",
              value.length === 0 && "text-muted-foreground",
              unavailableSymbols.length > 0 && "border-warning/50",
            )}
            disabled={marketsQuery.isPending}
          >
            <span className="min-w-0 flex-1 truncate text-left text-[13px]">{summary}</span>
            <span className="flex shrink-0 items-center gap-2">
              {value.length > 0 ? (
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {value.length}
                </span>
              ) : null}
              <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="flex max-h-[390px] flex-col p-0">
          <div className="border-b border-row-border p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value.toUpperCase())}
                placeholder="Найти пару"
                aria-label="Поиск пары в рынке"
                className="pl-8"
                autoFocus
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1" role="listbox" aria-multiselectable>
            {filteredMarkets.map((market) => {
              const selected = value.includes(market.symbol);
              return (
                <button
                  key={market.symbol}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="flex min-h-10 w-full items-center gap-3 rounded-[7px] px-2 text-left outline-none hover:bg-accent focus-visible:bg-accent"
                  onClick={() => toggle(market)}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input",
                      selected && "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {selected ? <Check className="size-3" aria-hidden="true" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-[13px] font-medium">{market.symbol}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {market.baseAsset}/{market.quoteAsset} · {market.instrumentType}
                    </span>
                  </span>
                </button>
              );
            })}
            {filteredMarkets.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                {markets.length === 0 ? (
                  <>
                    В Market Universe пока нет пар.{" "}
                    <Link to="/markets" className="text-primary hover:underline">
                      Добавить пары
                    </Link>
                  </>
                ) : (
                  "Подходящие пары не найдены."
                )}
              </div>
            ) : null}
          </div>
          <div className="flex items-center justify-between border-t border-row-border px-3 py-2 text-[11px] text-muted-foreground">
            <span>Выбрано: {value.length}</span>
            {value.length > 0 ? (
              <button type="button" className="hover:text-foreground" onClick={() => onChange([])}>
                Очистить
              </button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>

      {marketsQuery.isError ? (
        <p className="text-[11px] text-loss">Не удалось загрузить Market Universe.</p>
      ) : null}
      {unavailableSymbols.length > 0 ? (
        <div className="rounded-[9px] border border-warning/25 bg-warning/5 p-2.5">
          <p className="text-[11px] leading-4 text-warning">
            Эти пары удалены из Market Universe. Immutable-версия сохранена, но для новой версии их
            нужно убрать:
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {unavailableSymbols.map((symbol) => (
              <button
                key={symbol}
                type="button"
                onClick={() => onChange(value.filter((item) => item !== symbol))}
                aria-label={`Убрать недоступную пару ${symbol}`}
              >
                <Badge variant="warning" className="gap-1 pr-1.5">
                  {symbol}
                  <X className="size-3" aria-hidden="true" />
                </Badge>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
