import { z } from "zod";

export const failureStageValues = ["mcp_preflight", "settings_lock", "settings_enforcement", "provider_execution", "result_parse"];
export const providerCodeValues = [
  "resource_exhausted",
  "rate_limited",
  "unauthenticated",
  "permission_denied",
  "timeout",
  "output_limit",
  "executable_missing",
  "internal_error",
  "bad_gateway",
  "gateway_timeout",
  "unavailable",
  "connection_reset",
  "dns_failure",
  "fetch_failed",
  "network_error",
  "process_exit",
  "process_error",
  "invalid_model",
  "empty_output",
  "unclassified"
];
export const retryDecisionValues = ["retry", "stop", "not_applicable"];
export const retryStopReasonValues = [
  "mutation_state_unknown",
  "non_retryable_failure_class",
  "max_attempts_reached",
  "budget_exhausted",
  "budget_reserved",
  "schema_repair_exhausted"
];
export const processSignalValues = [
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGKILL",
  "SIGQUIT",
  "SIGSEGV",
  "SIGTERM",
  "SIGTRAP",
  "SIGXCPU",
  "SIGXFSZ"
];
export const outputSizeBucketValues = ["empty", "lte_1_kib", "lte_64_kib", "lte_1_mib", "gt_1_mib"];
export const capabilityStatusValues = ["not_probed", "available", "unavailable"];
export const capabilityNames = ["modelAccess", "toolFreeResponse", "workspaceRead", "webRead"];
export const capabilityFailureClassValues = [
  "timeout",
  "output_limit",
  "executable_missing",
  "permission_denied",
  "policy_violation",
  "rate_limited",
  "authentication_failure",
  "server",
  "network",
  "empty_output",
  "process_exit",
  "process_error",
  "invalid_model",
  "unclassified"
];

export const capabilityProbeSchema = z.object({
  modelAccess: z.enum(capabilityStatusValues),
  toolFreeResponse: z.enum(capabilityStatusValues),
  workspaceRead: z.enum(capabilityStatusValues),
  webRead: z.enum(capabilityStatusValues),
  failureClass: z.enum(capabilityFailureClassValues).nullable(),
  checkedAt: z.string().datetime().nullable()
}).strict();

export const attemptDiagnosticsSchema = z.object({
  failureStage: z.enum(failureStageValues).nullable(),
  providerCode: z.enum(providerCodeValues).nullable(),
  settingsLockWaitMs: z.number().int().min(0).nullable(),
  providerExecutionMs: z.number().int().min(0).nullable(),
  stdoutBytes: z.number().int().min(0).nullable(),
  stderrBytes: z.number().int().min(0).nullable()
}).strict();

export const healthResultSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  authValid: z.boolean().nullable(),
  executable: z.string(),
  probes: z.object({
    cli: z.enum(["available", "unavailable"]),
    modelAccess: z.enum(capabilityStatusValues),
    toolFreeResponse: z.enum(capabilityStatusValues),
    workspaceRead: z.enum(capabilityStatusValues),
    webRead: z.enum(capabilityStatusValues)
  }).strict().optional(),
  capabilityProbes: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), capabilityProbeSchema).optional(),
  error: z.string().optional()
}).strict();

export const subagentResultSchema = z.object({
  ok: z.boolean(),
  backend: z.string().min(1),
  model: z.string().min(1),
  requestedModel: z.string().min(1).optional(),
  resolvedModel: z.string().min(1).nullable().optional(),
  accessMode: z.enum(["read_only", "edit"]).optional(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  retryable: z.boolean(),
  timedOut: z.boolean(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().min(0),
  reason: z.string().optional(),
  metrics: z.object({
    retries: z.number().int().min(0),
    adapterAttempts: z.number().int().min(0).optional(),
    queueWaitMs: z.number().int().min(0).optional(),
    cacheHit: z.boolean().optional(),
    totalCostUsd: z.number().min(0).nullable().optional(),
    signal: z.string().nullable().optional(),
    diagnostics: attemptDiagnosticsSchema.optional(),
    costBudget: z.object({
      period: z.enum(["daily", "monthly"]),
      limitUsd: z.number().min(0),
      spentUsd: z.number().min(0),
      remainingUsd: z.number().min(0)
    }).strict().optional(),
    attempts: z.array(z.object({
      number: z.number().int().min(1),
      failureClass: z.string().nullable(),
      failureStage: z.enum(failureStageValues).nullable().optional(),
      providerCode: z.enum(providerCodeValues).nullable().optional(),
      retryDecision: z.enum(retryDecisionValues).optional(),
      retryStopReason: z.enum(retryStopReasonValues).nullable().optional(),
      signal: z.string().nullable().optional(),
      settingsLockWaitMs: z.number().int().min(0).nullable().optional(),
      providerExecutionMs: z.number().int().min(0).nullable().optional(),
      stdoutBucket: z.enum(outputSizeBucketValues).nullable().optional(),
      stderrBucket: z.enum(outputSizeBucketValues).nullable().optional(),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().int().min(0),
      totalCostUsd: z.number().min(0).nullable()
    }).strict()).optional()
  }),
  artifacts: z.object({
    filesChanged: z.array(z.string()).optional(),
    summary: z.string().optional()
  }).optional()
}).strict();

export const controlledEditResultSchema = z.object({
  status: z.enum(["completed", "failed"]),
  backend: z.string().min(1),
  model: z.string().min(1),
  requestedModel: z.string().min(1).optional(),
  resolvedModel: z.string().min(1).nullable().optional(),
  accessMode: z.literal("edit"),
  summary: z.string(),
  failureClass: z.string().nullable(),
  filesChanged: z.array(z.string().min(1)),
  diff: z.string(),
  applied: z.boolean(),
  fallbacks: z.number().int().min(0),
  cleanupCompleted: z.boolean()
}).strict();

export const capabilitySchema = z.object({
  canRead: z.boolean(),
  canWrite: z.boolean(),
  supportsSandbox: z.boolean(),
  supportsModelSelection: z.boolean()
}).strict();

export const modeSchema = z.enum(["read_only", "edit"]);

export const subagentExecutionRequestSchema = z.object({
  executionId: z.string().min(1),
  backend: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  mode: modeSchema,
  workspace: z.string().min(1),
  delegationDepth: z.number().int().min(0),
  caller: z.string().min(1),
  timeoutMs: z.number().int().min(1000)
}).strict();

export function validateHealthResult(value) {
  return healthResultSchema.safeParse(value);
}

export function validateSubagentResult(value) {
  return subagentResultSchema.safeParse(value);
}

export function validateControlledEditResult(value) {
  return controlledEditResultSchema.safeParse(value);
}

export function validateCapability(value) {
  return capabilitySchema.safeParse(value);
}

export function createFailureSubagentResult(backend, model, overrides = {}) {
  return {
    ok: false,
    backend,
    model,
    ...(overrides.requestedModel ? { requestedModel: overrides.requestedModel } : {}),
    ...(Object.hasOwn(overrides, "resolvedModel") ? { resolvedModel: overrides.resolvedModel } : {}),
    result: null,
    error: overrides.error || "execution failed",
    retryable: overrides.retryable ?? false,
    timedOut: overrides.timedOut ?? false,
    exitCode: "exitCode" in overrides ? overrides.exitCode : 1,
    durationMs: overrides.durationMs ?? 0,
    reason: overrides.reason,
    metrics: { retries: overrides.retries ?? 0, ...(overrides.metrics || {}) }
  };
}

export function createSuccessSubagentResult(backend, model, overrides = {}) {
  return {
    ok: true,
    backend,
    model,
    ...(overrides.requestedModel ? { requestedModel: overrides.requestedModel } : {}),
    ...(Object.hasOwn(overrides, "resolvedModel") ? { resolvedModel: overrides.resolvedModel } : {}),
    result: overrides.result || "",
    error: null,
    retryable: false,
    timedOut: false,
    exitCode: 0,
    durationMs: overrides.durationMs ?? 0,
    metrics: { retries: overrides.retries ?? 0, ...(overrides.metrics || {}) },
    artifacts: overrides.artifacts
  };
}
