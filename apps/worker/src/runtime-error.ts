export function runtimeErrorMessage(error: unknown, proxyUrl?: string): string {
  if (!(error instanceof Error)) return "Неизвестная ошибка";
  if (error.message !== "fetch failed") return error.message;
  const cause = error.cause;
  if (!cause || typeof cause !== "object" || !("code" in cause)) return error.message;
  const code = cause.code;
  if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return error.message;
  if (proxyUrl && code === "ECONNREFUSED") {
    try {
      const proxy = new URL(proxyUrl);
      return `Bybit REST: прокси ${proxy.hostname}:${proxy.port || (proxy.protocol === "https:" ? "443" : "80")} недоступен (${code}). Проверьте, что прокси запущен и доступен из Docker.`;
    } catch {
      // Preserve the network cause even if configuration could not be parsed.
    }
  }
  return `Bybit REST: ошибка соединения (${code}). Проверьте доступ к Bybit из worker.`;
}
