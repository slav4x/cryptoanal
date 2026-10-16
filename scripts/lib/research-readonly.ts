export function researchReadOnlyUrl(value: string) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("PostgreSQL is required");
  url.searchParams.set(
    "options",
    `${url.searchParams.get("options") ?? ""} -c default_transaction_read_only=on`.trim(),
  );
  return url.toString();
}
