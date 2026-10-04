export async function processRuntimeSymbols(
  symbols: string[],
  handlers: {
    process: (symbol: string) => Promise<void>;
    isConflict: (error: unknown) => boolean;
    onConflict: (symbol: string, attempt: number, exhausted: boolean) => void;
    onFailure: (symbol: string, error: unknown) => Promise<void>;
  },
) {
  const maximumAttempts = 3;
  for (const symbol of symbols) {
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        // Each attempt reloads state and rebuilds its decision in the caller.
        await handlers.process(symbol);
        break;
      } catch (error) {
        if (handlers.isConflict(error)) {
          const exhausted = attempt === maximumAttempts;
          handlers.onConflict(symbol, attempt, exhausted);
          if (!exhausted) continue;
        } else {
          await handlers.onFailure(symbol, error);
        }
        break;
      }
    }
  }
}
