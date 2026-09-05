import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./card";

type MetricCardProps = {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
};

export function MetricCard({ label, value, hint, icon }: MetricCardProps) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-1.5">
        <CardTitle className="text-[13px] font-normal text-muted-foreground">{label}</CardTitle>
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      </CardHeader>
      <CardContent>
        <div className="font-mono text-[27px] font-medium leading-tight tabular-nums">{value}</div>
        {hint ? <p className="mt-1 text-xs text-stale">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}
