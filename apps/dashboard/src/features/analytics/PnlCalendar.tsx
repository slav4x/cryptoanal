import type { AnalyticsDto, AnalyticsPeriod } from "@cryptoanal/contracts";
import { cn } from "@cryptoanal/ui";

type PnlCalendarProps = {
  days: AnalyticsDto["dailyPnl"];
  period: AnalyticsPeriod;
};

export function PnlCalendar({ days, period }: PnlCalendarProps) {
  const pnlByDate = new Map(days.map((day) => [day.date, day]));
  const visibleDates = createVisibleDates(period, days);
  const maximumAbsolutePnl = Math.max(...days.map((day) => Math.abs(Number(day.netPnl))), 1);

  return (
    <div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] uppercase tracking-[0.08em] text-stale">
        {weekdays.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-7 gap-1">
        {visibleDates.map((date) => {
          const day = pnlByDate.get(toDateKey(date));
          const pnl = Number(day?.netPnl ?? 0);
          const strength = Math.max(0.08, Math.abs(pnl) / maximumAbsolutePnl);
          return (
            <div
              key={date.toISOString()}
              className={cn(
                "group relative grid aspect-square min-h-8 place-items-center rounded-[6px] border border-row-border text-[10px] text-stale",
                day && pnl >= 0 && "text-profit",
                day && pnl < 0 && "text-loss",
              )}
              style={
                day
                  ? {
                      backgroundColor: `color-mix(in oklab, var(--${pnl >= 0 ? "profit" : "loss"}) ${Math.round(8 + strength * 24)}%, transparent)`,
                    }
                  : undefined
              }
              title={`${date.toLocaleDateString("ru-RU")}: ${pnl.toFixed(2)} USDT · ${day?.trades ?? 0} сделок`}
            >
              {date.getUTCDate()}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-stale">
        Последние {visibleDates.length} календарных дней · UTC
      </p>
    </div>
  );
}

const weekdays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function createVisibleDates(period: AnalyticsPeriod, days: AnalyticsDto["dailyPnl"]): Date[] {
  const maximumDays = period === "24h" || period === "7d" ? 7 : period === "30d" ? 35 : 91;
  const latestDataDate = days.at(-1)?.date;
  const end = latestDataDate ? new Date(`${latestDataDate}T00:00:00.000Z`) : startOfTodayUtc();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - maximumDays + 1);
  const mondayOffset = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - mondayOffset);

  const dates: Date[] = [];
  for (
    const current = new Date(start);
    current <= end;
    current.setUTCDate(current.getUTCDate() + 1)
  ) {
    dates.push(new Date(current));
  }
  return dates;
}

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
