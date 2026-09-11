import type { AnalyticsDto } from "@cryptoanal/contracts";
import { Button, cn } from "@cryptoanal/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

type PnlCalendarProps = {
  days: AnalyticsDto["dailyPnl"];
};

const monthFormatter = new Intl.DateTimeFormat("ru-RU", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const dayFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
});

export function PnlCalendar({ days }: PnlCalendarProps) {
  const [visibleMonth, setVisibleMonth] = useState(startOfCurrentMonthUtc);
  const pnlByDate = useMemo(() => new Map(days.map((day) => [day.date, day])), [days]);
  const calendarCells = useMemo(() => createMonthCells(visibleMonth), [visibleMonth]);
  const currentMonth = startOfCurrentMonthUtc();
  const isCurrentMonth = isSameMonth(visibleMonth, currentMonth);
  const monthDays = days.filter((day) => day.date.startsWith(toMonthKey(visibleMonth)));
  const maximumAbsolutePnl = Math.max(...monthDays.map((day) => Math.abs(Number(day.netPnl))), 1);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-8 shrink-0"
          aria-label="Предыдущий месяц"
          onClick={() => setVisibleMonth((month) => addMonths(month, -1))}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <p className="text-center text-[13px] font-medium capitalize text-foreground">
          {monthFormatter.format(visibleMonth)}
        </p>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-8 shrink-0"
          aria-label="Следующий месяц"
          disabled={isCurrentMonth}
          onClick={() => setVisibleMonth((month) => addMonths(month, 1))}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      <div className="grid grid-cols-7 gap-1.5 text-center text-[10px] uppercase tracking-[0.08em] text-stale">
        {weekdays.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>

      <div className="mt-2 grid grid-cols-7 gap-1.5" role="grid">
        {calendarCells.map((date, index) => {
          if (!date) {
            return (
              <div
                key={`empty-${index}`}
                className="min-h-[92px] rounded-[7px] border border-transparent"
                aria-hidden="true"
              />
            );
          }

          const day = pnlByDate.get(toDateKey(date));
          const pnl = Number(day?.netPnl ?? 0);
          const trades = day?.trades ?? 0;
          const strength = Math.min(1, Math.abs(pnl) / maximumAbsolutePnl);
          const hasResult = Boolean(day);
          const isToday = toDateKey(date) === toDateKey(new Date());

          return (
            <div
              key={date.toISOString()}
              className={cn(
                "flex min-h-[92px] min-w-0 flex-col justify-between rounded-[7px] border border-row-border p-2",
                isToday && "border-secondary-foreground",
              )}
              style={
                hasResult
                  ? {
                      backgroundColor: `color-mix(in oklab, var(--${pnl >= 0 ? "profit" : "loss"}) ${Math.round(5 + strength * 15)}%, transparent)`,
                    }
                  : undefined
              }
              role="gridcell"
              title={`${date.toLocaleDateString("ru-RU", { timeZone: "UTC" })}: ${formatSignedPnl(pnl)} · ${formatTradeCount(trades)}`}
            >
              <div className="min-w-0">
                <p className="truncate text-[11px] font-medium text-secondary-foreground">
                  {dayFormatter.format(date)}
                </p>
                <p className="mt-0.5 truncate text-[10px] text-stale">{formatTradeCount(trades)}</p>
              </div>
              <p
                className={cn(
                  "truncate font-mono text-[10px] tabular-nums text-stale",
                  hasResult && pnl >= 0 && "text-profit",
                  hasResult && pnl < 0 && "text-loss",
                )}
              >
                {formatSignedPnl(pnl)}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const weekdays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function startOfCurrentMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function createMonthCells(month: Date): Array<Date | null> {
  const year = month.getUTCFullYear();
  const monthIndex = month.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const firstWeekday = (new Date(Date.UTC(year, monthIndex, 1)).getUTCDay() + 6) % 7;
  const cells: Array<Date | null> = Array.from({ length: firstWeekday }, () => null);

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(Date.UTC(year, monthIndex, day)));
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function addMonths(month: Date, amount: number): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + amount, 1));
}

function isSameMonth(left: Date, right: Date): boolean {
  return (
    left.getUTCFullYear() === right.getUTCFullYear() && left.getUTCMonth() === right.getUTCMonth()
  );
}

function toMonthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatTradeCount(value: number): string {
  const lastTwo = value % 100;
  const last = value % 10;
  const suffix =
    lastTwo >= 11 && lastTwo <= 14
      ? "сделок"
      : last === 1
        ? "сделка"
        : last >= 2 && last <= 4
          ? "сделки"
          : "сделок";
  return `${value} ${suffix}`;
}

function formatSignedPnl(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USDT`;
}
