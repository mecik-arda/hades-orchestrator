import { classifyProcessFailure, isRetryableFailure, calculateRetryDelayMs } from "../retry.js";

export function shouldRetry(failureClass, mode, attemptNumber, maxAttempts, budgetConstraints = {}) {
  if (mode === "edit" && ["timeout", "process_exit", "non_zero_exit", "process_crash", "network", "server", "rate_limited", "empty_output", "output_limit", "output_parse_invalid", "schema_invalid", "process_error"].includes(failureClass)) {
    return { retryable: false, reason: "mutation_state_unknown" };
  }

  if (!isRetryableFailure(failureClass)) {
    return { retryable: false, reason: "non_retryable_failure_class" };
  }

  if (attemptNumber >= maxAttempts) {
    return { retryable: false, reason: "max_attempts_reached" };
  }

  if (budgetConstraints.maxRetryCostUsd !== undefined && budgetConstraints.currentCost >= budgetConstraints.maxRetryCostUsd) {
    return { retryable: false, reason: "budget_exhausted" };
  }

  if (budgetConstraints.maxRetryCostUsd !== undefined
    && budgetConstraints.maxRetryCostReserveUsd !== undefined
    && budgetConstraints.currentCost + budgetConstraints.maxRetryCostReserveUsd > budgetConstraints.maxRetryCostUsd) {
    return { retryable: false, reason: "budget_reserved" };
  }

  const delayMs = calculateRetryDelayMs(attemptNumber, budgetConstraints.baseDelayMs ?? 750, budgetConstraints.maxDelayMs ?? 8000, Math.random(), failureClass);
  return { retryable: true, delayMs };
}

export function isMutationStateUnknown(mode, failureClass) {
  return mode === "edit" && ["timeout", "process_exit", "non_zero_exit", "process_crash", "network", "server", "rate_limited", "empty_output", "output_limit", "output_parse_invalid", "schema_invalid", "process_error"].includes(failureClass);
}

export {
  classifyProcessFailure,
  isRetryableFailure,
  calculateRetryDelayMs
};
