import type { AnalyticsDto } from "@cryptoanal/contracts";
import { cn } from "@cryptoanal/ui";
import { formatMetricMoney } from "../../shared/format";

export function PnlDistribution({ buckets }: { buckets: AnalyticsDto["distributions"]["pnl"] }) {
  if (buckets.length === 0) return <EmptyDistribution />;
  const maximumTrades = Math.max(...buckets.map((bucket) => bucket.trades), 1);

  return (
    <div className="space-y-3">
      {buckets.map((bucket, index) => {
        const negative = Number(bucket.netPnl) < 0;
        return (
          <div
            key={`${bucket.from}:${bucket.to}:${index}`}
            className="grid grid-cols-[112px_1fr_80px] items-center gap-3"
          >
            <span className="font-mono text-[10px] text-stale">
              {formatRange(bucket.from, bucket.to)}
            </span>
            <div className="h-2 overflow-hidden rounded-full bg-avatar">
              <div
                className={cn("h-full rounded-full", negative ? "bg-loss" : "bg-profit")}
                style={{
                  width: `${Math.max((bucket.trades / maximumTrades) * 100, bucket.trades > 0 ? 4 : 0)}%`,
                }}
              />
            </div>
            <span className="text-right font-mono text-[11px] text-secondary-foreground">
              {bucket.trades} · {formatMetricMoney(bucket.netPnl)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function HoldingTimeDistribution({
  buckets,
}: {
  buckets: AnalyticsDto["distributions"]["holdingTime"];
}) {
  if (buckets.every((bucket) => bucket.trades === 0)) return <EmptyDistribution />;
  const maximumTrades = Math.max(...buckets.map((bucket) => bucket.trades), 1);

  return (
    <div className="space-y-3">
      {buckets.map((bucket) => (
        <div key={bucket.key} className="grid grid-cols-[88px_1fr_96px] items-center gap-3">
          <span className="text-[11px] text-stale">{bucket.label}</span>
          <div className="h-2 overflow-hidden rounded-full bg-avatar">
            <div
              className={cn(
                "h-full rounded-full",
                Number(bucket.netPnl) >= 0 ? "bg-profit" : "bg-loss",
              )}
              style={{
                width: `${Math.max((bucket.trades / maximumTrades) * 100, bucket.trades > 0 ? 4 : 0)}%`,
              }}
            />
          </div>
          <span className="text-right font-mono text-[11px] text-secondary-foreground">
            {bucket.trades} ·{" "}
            {bucket.winRatePercent.toLocaleString("ru-RU", { maximumFractionDigits: 0 })}% WR
          </span>
        </div>
      ))}
    </div>
  );
}

function EmptyDistribution() {
  return (
    <div className="grid h-36 place-items-center text-sm text-muted-foreground">Нет данных.</div>
  );
}

function formatRange(from: string, to: string): string {
  if (from === to) return formatCompactMoney(from);
  return `${formatCompactMoney(from)}…${formatCompactMoney(to)}`;
}

function formatCompactMoney(value: string): string {
  return new Intl.NumberFormat("ru-RU", {
    notation: Math.abs(Number(value)) >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(Number(value));
}
