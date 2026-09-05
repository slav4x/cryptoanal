import { CircleOff } from "lucide-react";
import type { ReactNode } from "react";

type EmptyStateProps = {
  title: string;
  description: string;
  action?: ReactNode;
};

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center">
      <span className="mb-4 rounded-full bg-muted p-3 text-muted-foreground">
        <CircleOff className="size-5" aria-hidden="true" />
      </span>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
