export type HealthLevel = "healthy" | "degraded" | "critical" | "unknown";
export type IncidentSeverity = "warning" | "critical";

export type HealthCondition = {
  fingerprint: string;
  domain: string;
  code: string;
  severity: IncidentSeverity;
  title: string;
  description: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, string | number | boolean | null>;
};

export type HealthMonitorInput = {
  now: Date;
  initialCapital: number;
  thresholds: {
    workerStaleMs: number;
    marketStaleMs: number;
    accountStaleMs: number;
    queueLagMs: number;
    outboxLagMs: number;
  };
  workerLastSeenAt: Date | null;
  markets: Array<{ symbol: string; observedAt: Date | null }>;
  accountObservedAt: Date | null;
  failedJobs24h: number;
  oldestQueuedJobAt: Date | null;
  rejectedOrders24h: number;
  runtimeFailures: Array<{
    executionRunId: string;
    symbol: string;
    code: string | null;
    message: string | null;
    consecutiveFailures: number;
    updatedAt: Date;
  }>;
  pendingOutbox: number;
  oldestPendingOutboxAt: Date | null;
  riskStops24h: number;
  driftCandidates: Array<{
    deploymentId: string;
    executionRunId: string;
    strategyId: string;
    strategyName: string;
    strategyVersion: number;
    environment: "dry-run" | "demo" | "live";
    validationRunId: string;
    baseline: {
      trades: number;
      winRatePercent: number;
      expectancy: number;
      profitFactor: number | null;
      maxDrawdownPercent: number;
    };
    runtimeTrades: Array<{ netPnl: number; closedAt: Date }>;
  }>;
};

export function evaluateHealth(input: HealthMonitorInput) {
  const conditions: HealthCondition[] = [];
  const staleMarkets = input.markets.filter(
    (market) =>
      !market.observedAt || age(input.now, market.observedAt) > input.thresholds.marketStaleMs,
  );

  if (input.markets.length === 0) {
    conditions.push({
      fingerprint: "market-data:catalog-empty",
      domain: "market-data",
      code: "MARKET_CATALOG_EMPTY",
      severity: "critical",
      title: "Каталог рынков пуст",
      description: "Нет включённых инструментов для проверки рыночных данных.",
      resourceType: "market-instrument",
      resourceId: null,
      metadata: {},
    });
  }

  if (
    !input.workerLastSeenAt ||
    age(input.now, input.workerLastSeenAt) > input.thresholds.workerStaleMs
  ) {
    conditions.push({
      fingerprint: "worker:heartbeat-stale",
      domain: "worker",
      code: "WORKER_HEARTBEAT_STALE",
      severity: "critical",
      title: "Worker не отвечает",
      description: "Heartbeat worker отсутствует или превысил допустимый возраст.",
      resourceType: "worker",
      resourceId: null,
      metadata: { lastSeenAt: input.workerLastSeenAt?.toISOString() ?? null },
    });
  }
  if (staleMarkets.length > 0) {
    const allUnavailable = staleMarkets.length === input.markets.length;
    conditions.push({
      fingerprint: "market-data:freshness",
      domain: "market-data",
      code: "MARKET_DATA_STALE",
      severity: allUnavailable ? "critical" : "warning",
      title: allUnavailable ? "Рыночные данные недоступны" : "Часть рыночных данных устарела",
      description: `${staleMarkets.length} из ${input.markets.length} включённых инструментов не имеют свежего snapshot.`,
      resourceType: "market-snapshot",
      resourceId: null,
      metadata: { symbols: staleMarkets.map((market) => market.symbol).join(",") },
    });
  }
  if (
    !input.accountObservedAt ||
    age(input.now, input.accountObservedAt) > input.thresholds.accountStaleMs
  ) {
    conditions.push({
      fingerprint: "account:snapshot-stale",
      domain: "account",
      code: "ACCOUNT_SNAPSHOT_STALE",
      severity: "warning",
      title: "Account snapshot устарел",
      description: "Текущий капитал и доступный баланс могут быть неактуальны.",
      resourceType: "account-snapshot",
      resourceId: null,
      metadata: { observedAt: input.accountObservedAt?.toISOString() ?? null },
    });
  }
  if (
    input.oldestQueuedJobAt &&
    age(input.now, input.oldestQueuedJobAt) > input.thresholds.queueLagMs
  ) {
    conditions.push({
      fingerprint: "validation-queue:lag",
      domain: "queue",
      code: "VALIDATION_QUEUE_LAG",
      severity: "warning",
      title: "Очередь validation задерживается",
      description: "Самая старая задача ожидает обработки дольше допустимого порога.",
      resourceType: "job",
      resourceId: null,
      metadata: { queuedAt: input.oldestQueuedJobAt.toISOString() },
    });
  }
  if (input.failedJobs24h > 0) {
    conditions.push({
      fingerprint: "validation-jobs:failed",
      domain: "queue",
      code: "VALIDATION_JOBS_FAILED",
      severity: "warning",
      title: "Есть ошибки фоновых задач",
      description: `${input.failedJobs24h} задач завершились ошибкой за последние 24 часа.`,
      resourceType: "job",
      resourceId: null,
      metadata: { count: input.failedJobs24h },
    });
  }
  if (input.rejectedOrders24h > 0) {
    conditions.push({
      fingerprint: "execution:rejected-orders",
      domain: "execution",
      code: "ORDERS_REJECTED",
      severity: "critical",
      title: "Ордера отклонены",
      description: `${input.rejectedOrders24h} ордеров отклонены за последние 24 часа.`,
      resourceType: "order",
      resourceId: null,
      metadata: { count: input.rejectedOrders24h },
    });
  }
  for (const failure of input.runtimeFailures) {
    conditions.push({
      fingerprint: `runtime:${failure.executionRunId}:${failure.symbol}`,
      domain: "execution",
      code: failure.code ?? "RUNTIME_CYCLE_FAILED",
      severity: failure.consecutiveFailures >= 3 ? "critical" : "warning",
      title: `Runtime-ошибка ${failure.symbol}`,
      description: failure.message ?? "Последний runtime-цикл завершился ошибкой.",
      resourceType: "execution-run",
      resourceId: failure.executionRunId,
      metadata: {
        symbol: failure.symbol,
        consecutiveFailures: failure.consecutiveFailures,
        updatedAt: failure.updatedAt.toISOString(),
      },
    });
  }
  if (
    input.oldestPendingOutboxAt &&
    age(input.now, input.oldestPendingOutboxAt) > input.thresholds.outboxLagMs
  ) {
    conditions.push({
      fingerprint: "outbox:lag",
      domain: "outbox",
      code: "OUTBOX_LAG",
      severity: "warning",
      title: "Outbox не обработан",
      description: `${input.pendingOutbox} событий ожидают обработки дольше допустимого порога.`,
      resourceType: "outbox-event",
      resourceId: null,
      metadata: { count: input.pendingOutbox },
    });
  }

  const drift = input.driftCandidates.map((candidate) =>
    evaluateDrift(candidate, input.initialCapital),
  );
  for (const item of drift) {
    if (item.status !== "warning" && item.status !== "critical") continue;
    conditions.push({
      fingerprint: `drift:${item.executionRunId}`,
      domain: "drift",
      code: "RUNTIME_VALIDATION_DRIFT",
      severity: item.status,
      title: `Drift стратегии ${item.strategyName}`,
      description: "Runtime-метрики вышли за допустимое отклонение от validated baseline.",
      resourceType: "execution-run",
      resourceId: item.executionRunId,
      metadata: {
        trades: item.runtime.trades,
        winRateDeltaPp: item.delta.winRatePercentagePoints,
        expectancyDeltaPercent: item.delta.expectancyPercent,
      },
    });
  }

  const domains = [
    domain("api", "API", "healthy", "API отвечает и формирует health projection", input.now),
    domain("database", "База данных", "healthy", "Чтение operational state выполнено", input.now),
    domainFromConditions("worker", "Worker", conditions, input.workerLastSeenAt),
    domainFromConditions(
      "market-data",
      "Рыночные данные",
      conditions,
      latest(input.markets.map((market) => market.observedAt)),
    ),
    exchangeDomain(input.markets, staleMarkets),
    domainFromConditions("account", "Торговый счёт", conditions, input.accountObservedAt),
    domainFromConditions("queue", "Очередь задач", conditions, input.oldestQueuedJobAt),
    domainFromConditions(
      "execution",
      "Исполнение",
      conditions,
      latest(input.runtimeFailures.map((item) => item.updatedAt)),
    ),
    domainFromConditions("outbox", "Outbox", conditions, input.oldestPendingOutboxAt),
    driftDomain(drift, input.now),
  ];
  const overallStatus: "healthy" | "degraded" | "critical" = domains.some(
    (item) => item.status === "critical",
  )
    ? "critical"
    : domains.some((item) => item.status === "degraded")
      ? "degraded"
      : "healthy";

  return {
    overallStatus,
    domains,
    conditions,
    drift,
    notices: {
      riskStops24h: input.riskStops24h,
      rejectedOrders24h: input.rejectedOrders24h,
      failedJobs24h: input.failedJobs24h,
    },
  };
}

function evaluateDrift(
  candidate: HealthMonitorInput["driftCandidates"][number],
  initialCapital: number,
) {
  const runtime = calculateRuntimeMetrics(candidate.runtimeTrades, initialCapital);
  const winRateDelta = round(runtime.winRatePercent - candidate.baseline.winRatePercent);
  const expectancyDeltaPercent = percentDelta(runtime.expectancy, candidate.baseline.expectancy);
  const profitFactorDeltaPercent = percentDelta(
    runtime.profitFactor,
    candidate.baseline.profitFactor,
  );
  const drawdownDelta = round(runtime.maxDrawdownPercent - candidate.baseline.maxDrawdownPercent);

  let status: "insufficient-data" | "within-range" | "warning" | "critical" =
    runtime.trades < 20 ? "insufficient-data" : "within-range";
  if (runtime.trades >= 20) {
    if (
      winRateDelta <= -20 ||
      (expectancyDeltaPercent !== null && expectancyDeltaPercent <= -50) ||
      (profitFactorDeltaPercent !== null && profitFactorDeltaPercent <= -50) ||
      (runtime.expectancy < 0 && candidate.baseline.expectancy > 0)
    ) {
      status = "critical";
    } else if (
      winRateDelta <= -10 ||
      (expectancyDeltaPercent !== null && expectancyDeltaPercent <= -30) ||
      (profitFactorDeltaPercent !== null && profitFactorDeltaPercent <= -30) ||
      drawdownDelta >= 5
    ) {
      status = "warning";
    }
  }

  return {
    deploymentId: candidate.deploymentId,
    executionRunId: candidate.executionRunId,
    strategyId: candidate.strategyId,
    strategyName: candidate.strategyName,
    strategyVersion: candidate.strategyVersion,
    environment: candidate.environment,
    validationRunId: candidate.validationRunId,
    status,
    minimumSampleSize: 20,
    baseline: candidate.baseline,
    runtime,
    delta: {
      winRatePercentagePoints: winRateDelta,
      expectancyPercent: expectancyDeltaPercent,
      profitFactorPercent: profitFactorDeltaPercent,
      maxDrawdownPercentagePoints: drawdownDelta,
    },
  };
}

function calculateRuntimeMetrics(
  trades: Array<{ netPnl: number; closedAt: Date }>,
  initialCapital: number,
) {
  const sorted = [...trades].sort(
    (left, right) => left.closedAt.getTime() - right.closedAt.getTime(),
  );
  const wins = sorted.filter((trade) => trade.netPnl > 0);
  const losses = sorted.filter((trade) => trade.netPnl < 0);
  const profit = sum(wins.map((trade) => trade.netPnl));
  const loss = Math.abs(sum(losses.map((trade) => trade.netPnl)));
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdownPercent = 0;
  for (const trade of sorted) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    maxDrawdownPercent = Math.max(
      maxDrawdownPercent,
      peak > 0 ? ((peak - equity) / peak) * 100 : 0,
    );
  }
  return {
    trades: sorted.length,
    winRatePercent: round(sorted.length > 0 ? (wins.length / sorted.length) * 100 : 0),
    expectancy: round(
      sorted.length > 0 ? sum(sorted.map((trade) => trade.netPnl)) / sorted.length : 0,
    ),
    profitFactor: loss > 0 ? round(profit / loss) : null,
    maxDrawdownPercent: round(maxDrawdownPercent),
  };
}

function domainFromConditions(
  id: string,
  label: string,
  conditions: HealthCondition[],
  observedAt: Date | null,
) {
  const matching = conditions.filter((condition) => condition.domain === id);
  const status: HealthLevel = matching.some((condition) => condition.severity === "critical")
    ? "critical"
    : matching.length > 0
      ? "degraded"
      : "healthy";
  return domain(
    id,
    label,
    status,
    matching.length > 0 ? matching[0]!.description : "Отклонений не обнаружено",
    observedAt,
  );
}

function driftDomain(
  drift: Array<{ status: "insufficient-data" | "within-range" | "warning" | "critical" }>,
  now: Date,
) {
  const status: HealthLevel = drift.some((item) => item.status === "critical")
    ? "critical"
    : drift.some((item) => item.status === "warning")
      ? "degraded"
      : drift.length === 0 || drift.every((item) => item.status === "insufficient-data")
        ? "unknown"
        : "healthy";
  const summary =
    drift.length === 0
      ? "Нет активного runtime с validated baseline"
      : drift.every((item) => item.status === "insufficient-data")
        ? "Недостаточно runtime-сделок для вывода"
        : status === "healthy"
          ? "Runtime находится в допустимом диапазоне"
          : "Обнаружено отклонение от validated baseline";
  return domain("drift", "Validation drift", status, summary, now);
}

function exchangeDomain(
  markets: HealthMonitorInput["markets"],
  staleMarkets: HealthMonitorInput["markets"],
) {
  const observedAt = latest(markets.map((market) => market.observedAt));
  if (markets.length === 0) {
    return domain(
      "exchange",
      "Bybit public connection",
      "unknown",
      "Нет инструментов для проверки соединения",
      observedAt,
    );
  }
  if (staleMarkets.length === markets.length) {
    return domain(
      "exchange",
      "Bybit public connection",
      "critical",
      "Новые market snapshots не поступают",
      observedAt,
    );
  }
  if (staleMarkets.length > 0) {
    return domain(
      "exchange",
      "Bybit public connection",
      "degraded",
      "Соединение отвечает не для всех инструментов",
      observedAt,
    );
  }
  return domain(
    "exchange",
    "Bybit public connection",
    "healthy",
    "Свежие market snapshots подтверждают соединение",
    observedAt,
  );
}

function domain(
  id: string,
  label: string,
  status: HealthLevel,
  summary: string,
  observedAt: Date | null,
) {
  return { id, label, status, summary, observedAt };
}

function percentDelta(value: number | null, baseline: number | null): number | null {
  if (value === null || baseline === null || baseline === 0) return null;
  return round(((value - baseline) / Math.abs(baseline)) * 100);
}

function latest(values: Array<Date | null>): Date | null {
  const dates = values.filter((value): value is Date => value !== null);
  return dates.length > 0 ? new Date(Math.max(...dates.map((date) => date.getTime()))) : null;
}

function age(now: Date, observedAt: Date): number {
  return Math.max(0, now.getTime() - observedAt.getTime());
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}
