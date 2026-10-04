export type RuntimeEntryWaitReason =
  | "ENTRY_CONNECTION_UNAVAILABLE"
  | "INSTRUMENT_UNAVAILABLE"
  | "ENTRY_STREAM_UNAVAILABLE"
  | "ENTRY_JOURNAL_UNAVAILABLE"
  | "ENTRY_QUOTE_MISSING"
  | "ENTRY_QUOTE_STREAM_MISMATCH"
  | "STALE_ENTRY_QUOTE"
  | "ENTRY_QUOTE_IN_FUTURE"
  | "ENTRY_QUOTE_BEFORE_SIGNAL_FINALITY"
  | "ENTRY_LIMIT_NOT_TOUCHED";

export function runtimeEntryQuoteWaitReason(input: {
  streamConnected: boolean;
  journalHealthy: boolean;
  streamId: string;
  quote?: { streamId: string; observedAt: Date } | undefined;
  now: number;
  maximumQuoteAgeMs: number;
}): RuntimeEntryWaitReason | null {
  if (!input.streamConnected) return "ENTRY_STREAM_UNAVAILABLE";
  if (!input.journalHealthy) return "ENTRY_JOURNAL_UNAVAILABLE";
  if (!input.quote) return "ENTRY_QUOTE_MISSING";
  if (input.quote.streamId !== input.streamId) return "ENTRY_QUOTE_STREAM_MISMATCH";
  const at = +input.quote.observedAt;
  if (!Number.isFinite(at) || input.now - at > input.maximumQuoteAgeMs) return "STALE_ENTRY_QUOTE";
  if (at > input.now + 1000) return "ENTRY_QUOTE_IN_FUTURE";
  return null;
}

export function runtimeEntryWaitSummary(reason: RuntimeEntryWaitReason): string {
  const messages: Record<RuntimeEntryWaitReason, string> = {
    ENTRY_CONNECTION_UNAVAILABLE: "Вход ожидает восстановления биржевого подключения",
    INSTRUMENT_UNAVAILABLE: "Вход ожидает доступности инструмента для торговли",
    ENTRY_STREAM_UNAVAILABLE: "Вход ожидает подключения потока цен",
    ENTRY_JOURNAL_UNAVAILABLE: "Вход ожидает восстановления записи ценового журнала",
    ENTRY_QUOTE_MISSING: "Вход ожидает первой котировки",
    ENTRY_QUOTE_STREAM_MISMATCH: "Вход ожидает котировки из текущего потока",
    STALE_ENTRY_QUOTE: "Вход ожидает свежей котировки",
    ENTRY_QUOTE_IN_FUTURE: "Вход ожидает котировки с допустимым временем",
    ENTRY_QUOTE_BEFORE_SIGNAL_FINALITY: "Вход ожидает котировки после подтверждения сигнала",
    ENTRY_LIMIT_NOT_TOUCHED: "Вход ожидает касания лимитной цены",
  };
  return messages[reason];
}
