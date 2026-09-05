import { Skeleton } from "@cryptoanal/ui";

export function RouteFallback() {
  return (
    <div className="space-y-6" aria-label="Загрузка страницы">
      <Skeleton className="h-16 w-full" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-32" />
        ))}
      </div>
      <Skeleton className="h-80" />
    </div>
  );
}
