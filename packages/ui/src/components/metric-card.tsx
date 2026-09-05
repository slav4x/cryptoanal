import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { Card, CardContent, CardHeader, CardTitle } from "./card";

type MetricCardProps = {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
  compact?: boolean;
  tone?: "neutral" | "profit" | "loss";
};

export function MetricCard({
  label,
  value,
  hint,
  icon,
  compact = false,
  tone = "neutral",
}: MetricCardProps) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between px-4 pb-0 pt-[15px]">
        <CardTitle
          className={cn(
            "font-normal text-muted-foreground",
            compact ? "text-[11px] uppercase tracking-[0.1em]" : "text-[13px] tracking-normal",
          )}
        >
          {label}
        </CardTitle>
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      </CardHeader>
      <CardContent className="px-4 pb-[15px] pt-[9px]">
        <div
          className={cn(
            "font-mono font-medium leading-tight tabular-nums",
            compact ? "text-2xl" : "text-[27px]",
            tone === "profit" && "text-profit",
            tone === "loss" && "text-loss",
          )}
        >
          {value}
        </div>
        {hint ? <p className="mt-1 text-xs text-stale">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}
