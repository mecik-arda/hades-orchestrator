const millisecondsPerDay = 86400000;

export const defaultSloPolicy = Object.freeze({
  windowDays: 7,
  minimumRuns: 20,
  availabilityTarget: 0.95,
  latencyP95Ms: 600000
});

export function normalizeSloPolicy(rawPolicy) {
  const policy = { ...defaultSloPolicy, ...(rawPolicy || {}) };
  const valid = Number.isInteger(policy.windowDays) && policy.windowDays > 0 && policy.windowDays <= 90
    && Number.isInteger(policy.minimumRuns) && policy.minimumRuns > 0
    && Number.isFinite(policy.availabilityTarget) && policy.availabilityTarget > 0 && policy.availabilityTarget <= 1
    && (policy.latencyP95Ms === undefined || (Number.isInteger(policy.latencyP95Ms) && policy.latencyP95Ms > 0));
  if (!valid) throw new Error("invalid SLO policy");
  return policy;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function summarizeSlo(records, rawPolicy, now = Date.now()) {
  const policy = normalizeSloPolicy(rawPolicy);
  const windowStart = now - policy.windowDays * millisecondsPerDay;
  const windowRecords = records.filter((record) => !record.recordType
    && typeof record.recordedAt === "string"
    && Number.isFinite(Date.parse(record.recordedAt))
    && Date.parse(record.recordedAt) >= windowStart
    && Date.parse(record.recordedAt) <= now);
  const observedRuns = windowRecords.length;
  const completedRuns = windowRecords.filter((record) => record.outcomeStatus === "completed").length;
  const failedRuns = observedRuns - completedRuns;
  const availabilityRate = observedRuns > 0 ? Number((completedRuns / observedRuns).toFixed(4)) : null;
  const durations = windowRecords.map((record) => record.usage?.durationMs).filter(Number.isFinite);
  const p95DurationMs = percentile(durations, 0.95);
  const allowedFailures = observedRuns > 0 ? Math.floor(observedRuns * (1 - policy.availabilityTarget) + 1e-9) : 0;
  const budgetExhausted = failedRuns > allowedFailures;
  const consumedRatio = allowedFailures > 0 ? Number((failedRuns / allowedFailures).toFixed(4)) : (failedRuns > 0 ? 1 : 0);
  const errorBudgetState = budgetExhausted
    ? "exhausted"
    : observedRuns < policy.minimumRuns
      ? "insufficient_data"
      : consumedRatio >= 0.8
        ? "warning"
        : "healthy";
  return {
    policy,
    observedRuns,
    completedRuns,
    failedRuns,
    availabilityRate,
    p95DurationMs,
    latencyTargetMet: policy.latencyP95Ms === undefined || durations.length === 0 ? null : p95DurationMs <= policy.latencyP95Ms,
    minimumRunsMet: observedRuns >= policy.minimumRuns,
    errorBudget: {
      allowedFailures,
      consumedFailures: failedRuns,
      remainingFailures: Math.max(0, allowedFailures - failedRuns),
      consumedRatio,
      state: errorBudgetState
    }
  };
}
