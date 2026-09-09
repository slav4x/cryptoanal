import type { PositionDto, TradeDto } from "@cryptoanal/contracts";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  cn,
} from "@cryptoanal/ui";
import { formatMoney, formatPrice } from "../../shared/format";

type PairTradingContextProps = {
  positions: PositionDto[];
  trades: TradeDto[];
  loading?: boolean;
  unavailable?: boolean;
};

export function PairTradingContext({
  positions,
  trades,
  loading = false,
  unavailable = false,
}: PairTradingContextProps) {
  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="flex-row items-center justify-between border-b">
          <div>
            <CardTitle>Открытые позиции</CardTitle>
            <CardDescription>Все активные стратегии по выбранной паре.</CardDescription>
          </div>
          <Badge variant="outline">{positions.length}</Badge>
        </CardHeader>
        <CardContent className={positions.length > 0 ? "px-0 pb-0" : undefined}>
          {loading ? <TradingContextSkeleton /> : null}
          {unavailable ? <Unavailable /> : null}
          {!loading && !unavailable && positions.length === 0 ? (
            <NoData>Открытых позиций нет.</NoData>
          ) : null}
          {!loading && positions.length > 0 ? <OpenPositionsTable positions={positions} /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Последние сделки</CardTitle>
          <CardDescription>До пяти завершённых сделок по этой паре.</CardDescription>
        </CardHeader>
        <CardContent className={trades.length > 0 ? "px-0 pb-0" : undefined}>
          {loading ? <TradingContextSkeleton /> : null}
          {unavailable ? <Unavailable /> : null}
          {!loading && !unavailable && trades.length === 0 ? (
            <NoData>Завершённых сделок пока нет.</NoData>
          ) : null}
          {!loading && trades.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse text-[12px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Время
                    </th>
                    <th scope="col" className="px-3 py-2.5 font-medium">
                      Сторона
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">
                      Выход
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">
                      PnL
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((trade) => (
                    <tr key={trade.id} className="border-t border-row-border">
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {new Date(trade.closedAt).toLocaleString("ru-RU", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge variant={trade.side === "buy" ? "profit" : "loss"}>
                          {trade.side === "buy" ? "Лонг" : "Шорт"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono">
                        {formatPrice(trade.averageExitPrice)}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-2.5 text-right font-mono",
                          Number(trade.netPnl) >= 0 ? "text-profit" : "text-loss",
                        )}
                      >
                        {formatMoney(trade.netPnl)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function OpenPositionsTable({ positions }: { positions: PositionDto[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1120px] border-collapse text-[13px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-stale">
            <th scope="col" className="px-4 py-3 font-medium">
              Открыта
            </th>
            <th scope="col" className="px-3 py-3 font-medium">
              Сторона
            </th>
            <th scope="col" className="px-3 py-3 text-right font-medium">
              Количество
            </th>
            <th scope="col" className="px-3 py-3 text-right font-medium">
              Вход
            </th>
            <th scope="col" className="px-3 py-3 text-right font-medium">
              Mark
            </th>
            <th scope="col" className="px-3 py-3 text-right font-medium">
              Stop loss
            </th>
            <th scope="col" className="px-3 py-3 text-right font-medium">
              Take profit
            </th>
            <th scope="col" className="px-3 py-3 text-right font-medium">
              PnL
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Стратегия
            </th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => (
            <tr key={position.id} className="border-t border-row-border hover:bg-row-hover">
              <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                {formatDateTime(position.openedAt)}
              </td>
              <td className="px-3 py-3">
                <Badge variant={position.side === "buy" ? "profit" : "loss"}>
                  {position.side === "buy" ? "Лонг" : "Шорт"}
                </Badge>
              </td>
              <PriceCell value={position.quantity} />
              <PriceCell value={position.entryPrice} />
              <PriceCell value={position.markPrice} />
              <PriceCell value={position.stopPrice} tone="loss" />
              <PriceCell value={position.takePrice} tone="profit" />
              <td
                className={cn(
                  "whitespace-nowrap px-3 py-3 text-right font-mono tabular-nums",
                  Number(position.unrealizedPnl) >= 0 ? "text-profit" : "text-loss",
                )}
              >
                {formatMoney(position.unrealizedPnl)}
              </td>
              <td className="max-w-[280px] px-4 py-3 text-muted-foreground">
                <span className="line-clamp-2">
                  {position.strategy.name} · v{position.strategy.version}
                </span>
                {position.trailingPrice ? (
                  <span className="mt-1 block font-mono text-[11px] text-warning">
                    Trailing {formatPrice(position.trailingPrice)}
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PriceCell({ value, tone }: { value: string | null; tone?: "profit" | "loss" }) {
  return (
    <td
      className={cn(
        "whitespace-nowrap px-3 py-3 text-right font-mono tabular-nums",
        tone === "profit" && "text-profit",
        tone === "loss" && "text-loss",
      )}
    >
      {formatPrice(value)}
    </td>
  );
}

function TradingContextSkeleton() {
  return (
    <div className="space-y-2 py-4">
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-10" />
      ))}
    </div>
  );
}

function NoData({ children }: { children: string }) {
  return <p className="py-12 text-center text-sm text-muted-foreground">{children}</p>;
}

function Unavailable() {
  return <p className="py-12 text-center text-sm text-loss">Торговый контекст недоступен.</p>;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
