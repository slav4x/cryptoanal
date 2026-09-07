import type * as React from "react";
import { cn } from "../lib/cn";

export function FieldLabel({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="field-label"
      className={cn("block text-[10px] uppercase tracking-[0.1em] text-stale", className)}
      {...props}
    />
  );
}
