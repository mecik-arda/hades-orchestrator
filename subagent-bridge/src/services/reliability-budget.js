export function resolveReliabilityBudget(configuration, backend, requestedTimeoutMs) {
  const reliability = configuration.reliability || {};
  const provider = configuration[backend] || {};
  const providerAttempts = Number.isInteger(provider.maxRetries) ? provider.maxRetries + 1 : 3;
  const policyAttempts = Number.isInteger(reliability.maxAttempts) ? reliability.maxAttempts : 3;
  const maxAttempts = Math.max(1, Math.min(providerAttempts, policyAttempts, 10));
  const configuredTimeoutMs = provider.timeoutMs || requestedTimeoutMs || 300000;
  const timeoutMs = Math.min(configuredTimeoutMs, requestedTimeoutMs || configuredTimeoutMs);
  return {
    maxAttempts,
    timeoutMs,
    maxTotalDurationMs: reliability.maxTotalDurationMs || Math.min(timeoutMs * maxAttempts, 1200000),
    maxRetryCostUsd: reliability.maxRetryCostUsd,
    maxRetryCostReserveUsd: reliability.maxRetryCostReserveUsd ?? reliability.maxRetryCostUsd,
    maxUnknownAttemptCostUsd: reliability.maxUnknownAttemptCostUsd ?? reliability.maxRetryCostReserveUsd ?? reliability.maxRetryCostUsd,
    baseRetryDelayMs: reliability.baseRetryDelayMs || 750,
    maxRetryDelayMs: reliability.maxRetryDelayMs || 8000
  };
}

export function remainingDurationMs(budget, startedAt) {
  return Math.max(0, budget.maxTotalDurationMs - (Date.now() - startedAt));
}
