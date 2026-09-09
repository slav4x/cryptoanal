import { TriangleAlert } from "lucide-react";
import { Button } from "./button";

type ErrorStateProps = {
  title?: string;
  description: string;
  requestId?: string | undefined;
  onRetry?: () => void;
};

export function ErrorState({
  title = "Не удалось загрузить данные",
  description,
  requestId,
  onRetry,
}: ErrorStateProps) {
  return (
    <div className="rounded-lg border border-loss/30 bg-loss/5 p-5">
      <div className="flex gap-3">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-loss" aria-hidden="true" />
        <div>
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p>
          {requestId ? (
            <p className="mt-2 font-mono text-xs text-muted-foreground">Request: {requestId}</p>
          ) : null}
          {onRetry ? (
            <Button className="mt-4" size="sm" variant="outline" onClick={onRetry}>
              Повторить
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
