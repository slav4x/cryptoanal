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
    <div className="grid gap-3 xl:grid-cols-2">
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Открытая позиция</CardTitle>
          <CardDescription>Активный торговый контекст по выбранной паре.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <TradingContextSkeleton /> : null}
          {unavailable ? <Unavailable /> : null}
          {!loading && !unavailable && positions.length === 0 ? (
            <NoData>Открытой позиции нет.</NoData>
          ) : null}
          {!loading
            ? positions.map((position) => (
                <div key={position.id} className="grid gap-x-8 sm:grid-cols-2">
                  <ContextRow
                    label="Сторона"
                    value={position.side === "buy" ? "Лонг" : "Шорт"}
                    badge={position.side === "buy" ? "profit" : "loss"}
                  />
                  <ContextRow label="Количество" value={formatPrice(position.quantity)} monospace />
                  <ContextRow label="Вход" value={formatPrice(position.entryPrice)} monospace />
                  <ContextRow label="Mark" value={formatPrice(position.markPrice)} monospace />
                  <ContextRow
                    label="Нереализованный PnL"
                    value={formatMoney(position.unrealizedPnl)}
                    tone={Number(position.unrealizedPnl) >= 0 ? "profit" : "loss"}
                  />
                  <ContextRow
                    label="Стратегия"
                    value={`${position.strategy.name} · v${position.strategy.version}`}
                  />
                </div>
              ))
            : null}
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

function TradingContextSkeleton() {
  return (
    <div className="space-y-2 py-4">
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-10" />
      ))}
    </div>
  );
}

function ContextRow({
  label,
  value,
  monospace = false,
  badge,
  tone,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  badge?: "profit" | "loss";
  tone?: "profit" | "loss";
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 border-b border-row-border last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      {badge ? (
        <Badge variant={badge}>{value}</Badge>
      ) : (
        <span
          className={cn(
            "text-right text-sm",
            monospace && "font-mono tabular-nums",
            tone === "profit" && "text-profit",
            tone === "loss" && "text-loss",
          )}
        >
          {value}
        </span>
      )}
    </div>
  );
}

function NoData({ children }: { children: string }) {
  return <p className="py-12 text-center text-sm text-muted-foreground">{children}</p>;
}

function Unavailable() {
  return <p className="py-12 text-center text-sm text-loss">Торговый контекст недоступен.</p>;
}
