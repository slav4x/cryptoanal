export function formatMoney(value: string | null, currency = "USDT"): string {
  if (value === null) return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  const formatted = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(parsed);
  return `${formatted} ${currency}`;
}

export function formatPrice(value: string | null): string {
  if (value === null) return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: parsed < 1 ? 4 : 2,
    maximumFractionDigits: parsed < 1 ? 8 : 2,
  }).format(parsed);
}

export function formatPercent(value: string | null): string {
  if (value === null) return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return `${parsed > 0 ? "+" : ""}${parsed.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}
