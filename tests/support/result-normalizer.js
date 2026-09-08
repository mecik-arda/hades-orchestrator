import { createFailureSubagentResult, createSuccessSubagentResult } from "../../subagent-bridge/src/schemas/core-schemas.js";

export function normalizeSubagentResult(adapterId, model, rawOutputOrError, startedAtMs, retries = 0) {
  const durationMs = Date.now() - startedAtMs;
  if (rawOutputOrError instanceof Error || rawOutputOrError?.isError) return createFailureSubagentResult(adapterId, model, { error: rawOutputOrError.message || String(rawOutputOrError), durationMs, retries });
  if (!rawOutputOrError) return createFailureSubagentResult(adapterId, model, { error: "empty output", durationMs, retries });
  return createSuccessSubagentResult(adapterId, model, { result: typeof rawOutputOrError === "string" ? rawOutputOrError : JSON.stringify(rawOutputOrError), durationMs, retries });
}

export function normalizeTimedOutResult(adapterId, model, durationMs, retries = 0) {
  return createFailureSubagentResult(adapterId, model, { error: "execution timed out", retryable: false, timedOut: true, exitCode: null, durationMs, retries });
}

export function normalizeCancelledResult(adapterId, model, durationMs, retries = 0) {
  return createFailureSubagentResult(adapterId, model, { error: "execution cancelled", retryable: false, timedOut: false, exitCode: null, durationMs, retries });
}

export function normalizeUnknownMutationResult(adapterId, model, durationMs, retries = 0) {
  return createFailureSubagentResult(adapterId, model, { error: "timeout during edit operation: mutation state unknown", retryable: false, timedOut: true, exitCode: null, durationMs, retries, reason: "mutation_state_unknown" });
}
