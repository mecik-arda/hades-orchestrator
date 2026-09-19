import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { ANTIGRAVITY_MODEL_MAP, createAntigravityAdapter } from "../adapters/antigravity-adapter.js";
import { CLAUDE_MODEL_MAP, createClaudeCodeAdapter } from "../adapters/claude-code-adapter.js";
import { createCodexAdapter } from "../adapters/codex-adapter.js";
import { createOpenCodeAdapter } from "../adapters/opencode-adapter.js";
import { buildDeepSeekEditPrompt, checkDeepSeek, createDeepSeekCheckpoint, createDeepSeekEditCheckpoint, createDeepSeekRuntimeRequest, resolveDeepSeekModel, writeDeepSeekCheckpoint } from "../deepseek.js";
import { buildGlmEditPrompt, buildGlmProfileReadOnlyPrompt, buildGlmSchemaRepairPrompt, checkGlm, createGlmCheckpoint, createGlmRuntimeRequest, normalizeOpenCodeGlmResult, resolveGlmModel, writeGlmCheckpoint } from "../glm.js";
import { buildCatalogEditPrompt, buildCatalogReadOnlyPrompt, checkCatalogProvider, resolveCatalogModel } from "../catalog-provider.js";
import { capabilityFailureClassValues, capabilityProbeSchema, capabilityStatusValues, createFailureSubagentResult, healthResultSchema, subagentExecutionRequestSchema, validateControlledEditResult, validateSubagentResult } from "../schemas/core-schemas.js";
import { checkCapability } from "../services/capability-service.js";
import { createDelegationGuard } from "../services/delegation-guard.js";
import { createExecutionId } from "../services/execution-service.js";
import { createHealthCache } from "../services/health-service.js";
import { checkModePolicy, resolveAllowedModes } from "../services/mode-policy.js";
import { containsSecretLikeAddedValue, containsSecretLikeValue, applyPreparedChanges, detectRecoveryArtifacts, provisionDisposableWorkspace } from "../services/disposable-workspace.js";
import { calculateChangeSetHash, classifyChangeSet, isOrchestratorApprovableClass } from "../services/approval-boundary.js";
import { createPreparedEditRegistry } from "../services/prepared-edit-registry.js";
import { containsHttpUrl, containsSensitiveWebValue, containsWebMarkup, detectWebIntent, normalizeUntrustedWebEvidence, providerWebEvidenceCarrierSchema } from "../web-evidence.js";
import { createProviderCircuitBreaker } from "../services/provider-circuit-breaker.js";
import { createReadOnlyResultCache } from "../services/read-only-cache.js";
import { remainingDurationMs, resolveReliabilityBudget } from "../services/reliability-budget.js";
import { shouldRetry } from "../services/retry-service.js";
import { createWorkspaceCoordinator } from "../services/workspace-coordinator.js";
import { classifyProcessFailure, isRetryableFailure } from "../retry.js";
import {
  appendRedactedRunMetric,
  createRedactedExecutionMetric,
  getCostBudgetSnapshot,
  normalizeFailureStage,
  normalizeProcessSignal,
  normalizeProviderCode,
  outputSizeBucket,
  reserveCostBudget,
  settleCostBudget
} from "../metrics.js";
import { resolveRuntimeRoute } from "./router.js";

const runtimeRunRequestSchema = z.object({
  target: z.string().min(1),
  prompt: z.string().min(1).max(60000),
  model: z.string().min(1).optional(),
  mode: z.enum(["read_only", "edit"]),
  trustedWorkspace: z.string().min(1),
  caller: z.string().min(1),
  delegationDepth: z.number().int().min(0),
  timeoutMs: z.number().int().min(1000).optional(),
  profile: z.string().min(1).max(64).optional(),
  executionId: z.string().min(1).optional(),
  abortSignal: z.any().optional(),
  webEvidenceRequired: z.boolean().optional(),
  metricBackend: z.enum(["glm", "kimi", "qwen"]).optional(),
  resultValidator: z.function().optional(),
  schemaRepairPrompt: z.string().min(1).max(70000).optional(),
  maxSchemaRepairAttempts: z.number().int().min(0).optional(),
  webEvidenceRepairPrompt: z.string().min(1).max(70000).optional(),
  maxWebEvidenceRepairAttempts: z.number().int().min(0).max(2).optional()
}).strict();

function createProductionAdapters(configuration) {
  return {
    antigravity: createAntigravityAdapter(configuration),
    claude_code: createClaudeCodeAdapter(configuration),
    codex: createCodexAdapter(configuration),
    opencode: createOpenCodeAdapter(configuration)
  };
}

function configuredModels(configuration, backend) {
  if (backend === "antigravity") {
    return Object.entries(ANTIGRAVITY_MODEL_MAP).map(([requestedModel, resolvedModel]) => ({ requestedModel, resolvedModel }));
  }
  if (backend === "claude_code") {
    return Object.keys(CLAUDE_MODEL_MAP).map((requestedModel) => ({ requestedModel, resolvedModel: null }));
  }
  if (backend === "opencode") {
    return (configuration.opencode?.allowedModels || []).map((model) => ({ requestedModel: model, resolvedModel: model }));
  }
  if (backend === "codex") {
    const models = Object.values(configuration.orchestration?.taskProfiles || {})
      .filter((profile) => profile.target === "codex" && profile.model)
      .map((profile) => profile.model);
    return [
      { requestedModel: "default", resolvedModel: null },
      ...[...new Set(models)].map((model) => ({ requestedModel: model, resolvedModel: model }))
    ];
  }
  return [];
}

function circuitKey(route) {
  if (route.backend === "opencode") return `${route.backend}:${route.model}`;
  return route.backend === "antigravity"
    ? `${route.backend}:${ANTIGRAVITY_MODEL_MAP[route.model] || route.model}`
    : route.backend;
}

function isContentValidationFailure(failureClass) {
  return ["schema_invalid", "output_parse_invalid"].includes(failureClass);
}

function capabilityFailureClass(failureClass) {
  if (!failureClass) return null;
  const mapping = {
    auth_invalid: "authentication_failure",
    model_access_denied: "invalid_model",
    model_unavailable: "invalid_model",
    invalid_model: "invalid_model",
    provider_circuit_open: "server",
    non_zero_exit: "process_exit",
    schema_invalid: "process_error",
    output_parse_invalid: "empty_output",
    queue_unavailable: "server"
  };
  const normalized = mapping[failureClass] || failureClass;
  return capabilityFailureClassValues.includes(normalized) ? normalized : "unclassified";
}

function normalizeCapabilityProbe(probe) {
  const source = probe && typeof probe === "object" ? probe : {};
  const projected = {
    modelAccess: capabilityStatusValues.includes(source.modelAccess) ? source.modelAccess : "not_probed",
    toolFreeResponse: capabilityStatusValues.includes(source.toolFreeResponse) ? source.toolFreeResponse : "not_probed",
    workspaceRead: capabilityStatusValues.includes(source.workspaceRead) ? source.workspaceRead : "not_probed",
    webRead: capabilityStatusValues.includes(source.webRead) ? source.webRead : "not_probed",
    failureClass: source.failureClass === null || source.failureClass === undefined
      ? null
      : (capabilityFailureClassValues.includes(source.failureClass) ? source.failureClass : "unclassified"),
    checkedAt: capabilityProbeSchema.shape.checkedAt.safeParse(source.checkedAt ?? null).success ? source.checkedAt ?? null : null
  };
  return capabilityProbeSchema.parse(projected);
}

function normalizeHealthResult(health) {
  const source = health && typeof health === "object" ? health : {};
  const sourceProbes = source.probes && typeof source.probes === "object" ? source.probes : {};
  const probes = {
    ...(sourceProbes.cli === "available" || sourceProbes.cli === "unavailable" ? { cli: sourceProbes.cli } : {}),
    ...Object.fromEntries(["modelAccess", "toolFreeResponse", "workspaceRead", "webRead"]
      .filter((key) => capabilityStatusValues.includes(sourceProbes[key]))
      .map((key) => [key, sourceProbes[key]]))
  };
  const sourceCapabilityProbes = source.capabilityProbes && typeof source.capabilityProbes === "object" ? source.capabilityProbes : {};
  const capabilityProbes = Object.fromEntries(Object.entries(sourceCapabilityProbes)
    .filter(([model]) => /^[a-z][a-z0-9._-]{0,63}$/.test(model))
    .map(([model, probe]) => [model, normalizeCapabilityProbe(probe)]));
  const versionMatch = typeof source.version === "string" ? /\b[vV]?\d+(?:\.\d+){1,3}\b/.exec(source.version) : null;
  return healthResultSchema.parse({
    installed: source.installed === true,
    version: versionMatch ? versionMatch[0] : null,
    authValid: typeof source.authValid === "boolean" ? source.authValid : null,
    executable: source.executable ? "configured" : "unavailable",
    ...(Object.keys(probes).length > 0 ? { probes } : {}),
    ...(Object.keys(capabilityProbes).length > 0 ? { capabilityProbes } : {}),
    ...(source.error ? { error: "unavailable" } : {})
  });
}

export function canonicalizeTrustedWorkspace(trustedWorkspace) {
  if (!path.isAbsolute(trustedWorkspace)) {
    throw new Error("trusted workspace must be an absolute path");
  }
  const resolved = path.resolve(trustedWorkspace);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`trusted workspace not found: ${resolved}`);
  }
  return fs.realpathSync(resolved);
}

export function fingerprintTrustedWorkspace(trustedWorkspace) {
  return crypto.createHash("sha256").update(canonicalizeTrustedWorkspace(trustedWorkspace)).digest("hex");
}

export function captureSourceState(trustedWorkspace, relativePaths) {
  const sourceWorkspace = canonicalizeTrustedWorkspace(trustedWorkspace);
  return [...new Set(relativePaths)].map((relativePath) => {
    const normalizedPath = relativePath.replaceAll("\\", "/");
    const candidatePath = path.resolve(sourceWorkspace, ...normalizedPath.split("/"));
    const relativeCandidate = path.relative(sourceWorkspace, candidatePath);
    if (!normalizedPath || relativeCandidate.startsWith("..") || path.isAbsolute(relativeCandidate)) throw new Error("approval source path rejected");
    if (!fs.existsSync(candidatePath)) return { relativePath: normalizedPath, state: "absent" };
    const status = fs.lstatSync(candidatePath);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) throw new Error("approval source file rejected");
    return { relativePath: normalizedPath, state: "present", sha256: crypto.createHash("sha256").update(fs.readFileSync(candidatePath)).digest("hex") };
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function hashSourceState(sourceStateEntries) {
  return crypto.createHash("sha256").update(JSON.stringify(sourceStateEntries)).digest("hex");
}

export function fingerprintSourceState(trustedWorkspace, relativePaths) {
  return hashSourceState(captureSourceState(trustedWorkspace, relativePaths));
}

function createRuntimeFailure(backend, model, error, overrides = {}) {
  const result = createFailureSubagentResult(backend, model, {
    error,
    exitCode: "exitCode" in overrides ? overrides.exitCode : null,
    retryable: overrides.retryable ?? false,
    timedOut: overrides.timedOut ?? false,
    durationMs: overrides.durationMs ?? 0,
    retries: overrides.retries ?? 0,
    reason: overrides.reason,
    metrics: overrides.metrics,
    requestedModel: model,
    resolvedModel: null
  });
  result.metrics.adapterAttempts = overrides.adapterAttempts ?? 0;
  return result;
}

function classifyReturnedFailure(result) {
  const failureClass = result.reason || classifyProcessFailure({
    code: result.exitCode,
    stderr: result.error || "",
    stdout: ""
  }) || "process_exit";
  return failureClass === "non_zero_exit" ? "process_exit" : failureClass;
}

function withRuntimeMetrics(result, retries, extras = {}) {
  return {
    ...result,
    metrics: {
      ...(result.metrics || {}),
      retries,
      ...extras
    }
  };
}

function withModelIdentity(result, requestedModel) {
  const resolvedModel = Object.hasOwn(result, "resolvedModel")
    ? result.resolvedModel
    : (result.model === "default" ? null : result.model);
  return {
    ...result,
    requestedModel,
    resolvedModel
  };
}

function normalizeProviderResult(result, { requireCarrier = false, allowPlainRepair = false, rejectRestricted = false, webIntentHeuristics = false, webIntentPrompt = null } = {}) {
  if (!result || typeof result !== "object") return result;
  let evidenceCandidate = Object.hasOwn(result, "webEvidence") ? result.webEvidence : undefined;
  let resultText = result.result;
  let plainRepaired = false;
  if (requireCarrier && result.ok === true && evidenceCandidate === undefined && Object.hasOwn(result, "result")) {
    try {
      if (typeof resultText !== "string") throw new Error("web evidence result wrapper is invalid");
      const parsed = JSON.parse(resultText);
      const carrierValidation = providerWebEvidenceCarrierSchema.safeParse(parsed);
      if (!carrierValidation.success) throw new Error("web evidence result wrapper is invalid");
      evidenceCandidate = carrierValidation.data.webEvidence;
      resultText = carrierValidation.data.result;
    } catch (error) {
      const repairable = allowPlainRepair
        && typeof resultText === "string"
        && resultText.trim().length > 0
        && !containsHttpUrl(resultText)
        && !containsSensitiveWebValue(resultText)
        && !containsWebMarkup(resultText)
        && !(webIntentHeuristics && detectWebIntent(webIntentPrompt, resultText));
      if (!repairable) {
        throw error.message === "web evidence result wrapper is invalid"
          ? error
          : new Error("web evidence result wrapper is invalid");
      }
      evidenceCandidate = null;
      plainRepaired = true;
    }
  }
  if ((rejectRestricted && (containsHttpUrl(resultText) || containsSensitiveWebValue(resultText) || containsWebMarkup(resultText))) || (evidenceCandidate !== undefined && containsSensitiveWebValue(resultText))) throw new Error("provider result contains restricted content");
  if (evidenceCandidate === undefined) return result;
  return {
    ...result,
    result: resultText,
    webEvidence: evidenceCandidate === null ? null : normalizeUntrustedWebEvidence(evidenceCandidate),
    ...(plainRepaired ? { metrics: { ...(result.metrics || {}), webEvidenceRepair: true } } : {})
  };
}

export function createBridgeRuntime({ configuration, statePaths, host = {}, adapters, sleep, legacyHealthChecker } = {}) {
  if (!configuration) {
    throw new Error("runtime configuration is required");
  }
  const runtimeConfiguration = {
    ...configuration,
    statePaths: statePaths || configuration.statePaths
  };
  const runtimeAdapters = adapters || createProductionAdapters(runtimeConfiguration);
  const wait = sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const checkLegacy = legacyHealthChecker || checkDeepSeek;
  const activeExecutions = new Map();
  const healthCache = createHealthCache();
  const scheduler = runtimeConfiguration.orchestration?.scheduler || {};
  const coordinator = createWorkspaceCoordinator({
    lockDirectory: path.join(runtimeConfiguration.statePaths.cache, "locks"),
    staleLockMs: scheduler.staleLockMs,
    leaseHeartbeatMs: scheduler.leaseHeartbeatMs,
    maxQueuedPerWorkspace: scheduler.maxQueuedPerWorkspace
  });
  const preparedEditRegistry = createPreparedEditRegistry({
    ttlMs: runtimeConfiguration.approval?.ttlMs,
    maxEntries: runtimeConfiguration.approval?.maxEntries,
    maxTotalBytes: runtimeConfiguration.approval?.maxTotalBytes
  });
  const readOnlyCache = createReadOnlyResultCache({
    ...runtimeConfiguration.orchestration?.readOnlyCache
  });
  const circuitBreaker = createProviderCircuitBreaker({
    stateDirectory: path.join(runtimeConfiguration.statePaths.state, "provider-circuits"),
    ...runtimeConfiguration.orchestration?.circuitBreaker
  });

  async function cancel(executionId) {
    const execution = activeExecutions.get(executionId);
    if (!execution) return false;
    execution.cancelled = true;
    coordinator.cancel(executionId);
    await execution.adapter.cancel(executionId);
    return true;
  }

  async function runSingle(rawRequest, executionId) {
    let route = null;
    try {
      route = resolveRuntimeRoute(rawRequest, runtimeConfiguration);
    } catch {
    }
    const providerCircuitKey = route ? circuitKey(route) : null;
    const admission = providerCircuitKey ? await circuitBreaker.beforeCall(providerCircuitKey) : { allowed: true, state: "unavailable" };
    if (!admission.allowed) {
      return createRuntimeFailure(route.backend, route.model, "provider circuit is open", { reason: "provider_circuit_open" });
    }
    const result = await runInternal({ ...rawRequest, executionId });
    if (route?.glm) result.metricBackend = "glm";
    const routeAdapters = route ? runtimeAdapters[route.backend] : null;
    if (routeAdapters?.capabilities) {
      result.metrics = { ...(result.metrics || {}), capability: routeAdapters.capabilities };
    }
    if (route) {
      const attemptRecords = Array.isArray(result.metrics?.attempts) ? result.metrics.attempts : [];
      const failureClass = attemptRecords.at(-1)?.failureClass || result.reason;
      if (result.ok || (admission.probe && !isRetryableFailure(failureClass))) {
        await circuitBreaker.recordSuccess(providerCircuitKey);
      } else if (isContentValidationFailure(failureClass)) {
        await circuitBreaker.recordNeutral(providerCircuitKey);
      } else if (isRetryableFailure(failureClass)) {
        await circuitBreaker.recordFailure(providerCircuitKey);
      }
    }
    if (result.reason !== "duplicate_execution_id") {
      try {
        const attempts = Array.isArray(result.metrics?.attempts) ? result.metrics.attempts : [];
        const knownAttemptCosts = attempts.length > 0 && attempts.every((attempt) => Number.isFinite(attempt.totalCostUsd));
        const actualCostUsd = result.metrics?.cacheHit || (attempts.length === 0 && ["queue_unavailable", "cancelled"].includes(result.reason))
          ? 0
          : knownAttemptCosts ? attempts.reduce((total, attempt) => total + attempt.totalCostUsd, 0) : null;
        await settleCostBudget(runtimeConfiguration, executionId, actualCostUsd);
      } catch {
      }
    }
    return result;
  }

  async function run(rawRequest) {
    const executionId = rawRequest.executionId || createExecutionId();
    const profile = rawRequest.profile ? runtimeConfiguration.orchestration?.taskProfiles?.[rawRequest.profile] : null;
    const fallbacks = rawRequest.target === "profile" && rawRequest.mode === "read_only" && Array.isArray(profile?.fallbackTargets)
      ? profile.fallbackTargets
      : [];
    let result = await runSingle({ ...rawRequest, executionId }, executionId);
    let fallbackCount = 0;
    for (const fallback of fallbacks) {
      if (result.ok) break;
      const attemptRecords = Array.isArray(result.metrics?.attempts) ? result.metrics.attempts : [];
      const failureClass = attemptRecords.at(-1)?.failureClass || result.reason;
      if (result.reason !== "provider_circuit_open" && !isRetryableFailure(failureClass)) break;
      fallbackCount += 1;
      const fallbackExecutionId = createExecutionId();
      result = await runSingle({
        ...rawRequest,
        target: fallback.target,
        model: fallback.model,
        profile: undefined,
        ...(profile?.webEvidenceRequired === true ? { webEvidenceRequired: true } : {}),
        executionId: fallbackExecutionId
      }, fallbackExecutionId);
    }
    if (fallbackCount > 0) {
      result = withRuntimeMetrics(result, result.metrics?.retries || 0, { fallbacks: fallbackCount });
    }
    result = { ...result, accessMode: rawRequest.mode };
    try {
      await appendRedactedRunMetric(runtimeConfiguration, createRedactedExecutionMetric({
        executionId,
        workspace: rawRequest.trustedWorkspace || "unavailable",
        mode: rawRequest.mode || "read_only",
        profile: rawRequest.profile,
        metricBackend: rawRequest.metricBackend || result.metricBackend,
        result
      }), { workspace: rawRequest.trustedWorkspace });
    } catch {
    }
    return result;
  }

  async function runInternal(rawRequest) {
    const parsed = runtimeRunRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new Error(`invalid runtime request: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    const input = parsed.data;
    let route;
    try {
      route = resolveRuntimeRoute(input, runtimeConfiguration);
    } catch (error) {
      return createRuntimeFailure(input.target, input.model || "default", error.message);
    }
    let webEvidenceMode = input.webEvidenceRequired === true
      ? "strict"
      : (route.backend === "antigravity" && input.mode === "read_only" ? "repair" : "off");
    if (route.glm) {
      input.caller = input.mode === "edit" ? "glm_edit" : "glm_opencode";
      input.metricBackend = "glm";
      try {
        input.model = resolveGlmModel(runtimeConfiguration, route.model);
      } catch (error) {
        return createRuntimeFailure(route.backend, route.model, error.message, { reason: "invalid_model" });
      }
      route.model = input.model;
      if (input.mode === "read_only") {
        input.prompt = buildGlmProfileReadOnlyPrompt(input.prompt);
        input.resultValidator = normalizeOpenCodeGlmResult;
        input.schemaRepairPrompt = buildGlmSchemaRepairPrompt({
          objective: input.prompt,
          files: [],
          contextFiles: [],
          acceptanceCriteria: ["Return a concise, evidence-based result."]
        });
        input.maxSchemaRepairAttempts = runtimeConfiguration.reliability?.maxSchemaRepairAttempts;
      }
    }
    if (route.catalogProvider) {
      input.caller = input.mode === "edit" ? `${route.catalogProvider}_edit` : `${route.catalogProvider}_opencode`;
      input.metricBackend = route.catalogProvider;
      try {
        input.model = resolveCatalogModel(runtimeConfiguration, route.catalogProvider, route.model);
      } catch (error) {
        return createRuntimeFailure(route.backend, route.model, error.message, { reason: "invalid_model" });
      }
      route.model = input.model;
      if (input.mode === "read_only") input.prompt = buildCatalogReadOnlyPrompt({ objective: input.prompt, files: [], contextFiles: [], acceptanceCriteria: ["Return a concise, evidence-based result."] }, route.catalogProvider);
    }
    const adapter = runtimeAdapters[route.backend];
    if (!adapter) {
      return createRuntimeFailure(route.backend, route.model, `adapter unavailable: ${route.backend}`);
    }
    const profile = input.profile ? runtimeConfiguration.orchestration?.taskProfiles?.[input.profile] : null;
    if (profile?.webEvidenceRequired === true && webEvidenceMode === "repair") webEvidenceMode = "strict";
    if (input.target === "profile" && (!profile || profile.mode !== input.mode)) {
      return createRuntimeFailure(route.backend, route.model, "task profile mode does not match request");
    }
    const controlledEditPilot = ["deepseek_edit_pilot", "glm_edit_pilot", "kimi_edit_pilot", "qwen_edit_pilot"].includes(input.caller) && route.backend === "opencode" && input.mode === "edit";
    const controlledEditExecution = ["codex_edit", "controlled_edit", "deepseek_edit", "deepseek_edit_pilot", "glm_edit", "glm_edit_pilot", "kimi_edit", "kimi_edit_pilot", "qwen_edit", "qwen_edit_pilot"].includes(input.caller) && input.mode === "edit";
    if (input.mode === "edit" && !controlledEditExecution) return createRuntimeFailure(route.backend, route.model, "edit mode requires a controlled edit caller", { reason: "mode_not_allowed" });
    const providerModeConfiguration = controlledEditPilot
      ? { ...runtimeConfiguration[route.backend], defaultMode: "edit", allowedModes: ["edit"] }
      : runtimeConfiguration[route.backend];
    const modePolicy = checkModePolicy(providerModeConfiguration, adapter.capabilities, input.mode);
    if (!modePolicy.allowed) {
      return createRuntimeFailure(route.backend, route.model, modePolicy.error, { reason: "mode_not_allowed" });
    }
    let trustedWorkspace;
    try {
      trustedWorkspace = canonicalizeTrustedWorkspace(input.trustedWorkspace);
    } catch (error) {
      return createRuntimeFailure(route.backend, route.model, error.message);
    }
    const delegationGuard = createDelegationGuard();
    const guardCheck = delegationGuard.check(input.delegationDepth, input.caller);
    if (!guardCheck.allowed) {
      return createRuntimeFailure(route.backend, route.model, guardCheck.error);
    }
    const capabilityCheck = checkCapability(adapter, input.mode);
    if (!capabilityCheck.allowed) {
      return createRuntimeFailure(route.backend, route.model, capabilityCheck.error);
    }
    const executionId = input.executionId || createExecutionId();
    const resolvedBudget = resolveReliabilityBudget(runtimeConfiguration, route.backend, input.timeoutMs);
    const budget = controlledEditExecution
      ? { ...resolvedBudget, maxAttempts: 1, timeoutMs: Number.isFinite(input.timeoutMs) ? input.timeoutMs : resolvedBudget.timeoutMs }
      : resolvedBudget;
    const timeoutMs = budget.timeoutMs;
    const request = {
      executionId,
      backend: route.backend,
      prompt: input.prompt,
      model: route.model,
      mode: input.mode,
      workspace: trustedWorkspace,
      delegationDepth: input.delegationDepth,
      caller: input.caller,
      timeoutMs
    };
    const requestValidation = subagentExecutionRequestSchema.safeParse(request);
    if (!requestValidation.success) {
      return createRuntimeFailure(route.backend, route.model, `internal schema validation failed: ${requestValidation.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    if (activeExecutions.has(executionId)) {
      return createRuntimeFailure(route.backend, route.model, "duplicate active execution ID", { reason: "duplicate_execution_id" });
    }
    if (input.abortSignal?.aborted) {
      return createRuntimeFailure(route.backend, route.model, "execution cancelled", { reason: "cancelled" });
    }
    const activeExecution = { adapter, cancelled: false };
    activeExecutions.set(executionId, activeExecution);
    let costBudget;
    try {
      costBudget = await reserveCostBudget(runtimeConfiguration, executionId, (budget.maxUnknownAttemptCostUsd || 0) * budget.maxAttempts);
    } catch (error) {
      activeExecutions.delete(executionId);
      throw error;
    }
    if (!costBudget.allowed) {
      activeExecutions.delete(executionId);
      return createRuntimeFailure(route.backend, route.model, "execution cost budget exhausted", {
        reason: costBudget.reason,
        metrics: costBudget.budget ? { costBudget: costBudget.budget } : undefined
      });
    }
    const startedAt = Date.now();
    let attemptNumber = 0;
    let lastResult = null;
    let totalCostUsd = 0;
    let reservedCostUsd = 0;
    let schemaRepairAttempts = 0;
    let schemaValidationIssues = [];
    let webEvidenceRepairAttempts = 0;
    const attemptRecords = [];
    let cacheKey = null;
    const abortListener = () => {
      void cancel(executionId).catch(() => {});
    };
    input.abortSignal?.addEventListener?.("abort", abortListener, { once: true });
    const grant = await coordinator.acquire(trustedWorkspace, input.mode, executionId, profile?.priority || 0);
    if (!grant) {
      activeExecutions.delete(executionId);
      input.abortSignal?.removeEventListener?.("abort", abortListener);
      return createRuntimeFailure(route.backend, route.model, activeExecution.cancelled ? "execution cancelled" : "workspace execution queue unavailable", {
        reason: activeExecution.cancelled ? "cancelled" : "queue_unavailable"
      });
    }
    try {
      cacheKey = input.mode === "read_only" && profile?.cacheable === true
        ? await readOnlyCache.keyFor({ workspace: trustedWorkspace, backend: route.backend, model: route.model, profile: input.profile, prompt: input.prompt })
        : null;
      const cachedResult = readOnlyCache.get(cacheKey);
      if (cachedResult) {
        const verifiedKey = await readOnlyCache.keyFor({ workspace: trustedWorkspace, backend: route.backend, model: route.model, profile: input.profile, prompt: input.prompt });
        if (verifiedKey === cacheKey) {
          return withRuntimeMetrics(withModelIdentity({ ...cachedResult, metrics: { ...(cachedResult.metrics || {}), attempts: [] } }, route.model), 0, {
            cacheHit: true,
            queueWaitMs: grant.queueWaitMs,
            adapterAttempts: 0
          });
        }
      }
      while (attemptNumber < budget.maxAttempts) {
        if (activeExecution.cancelled || input.abortSignal?.aborted) {
          return createRuntimeFailure(route.backend, route.model, "execution cancelled", {
            durationMs: Date.now() - startedAt,
            retries: Math.max(0, attemptNumber - 1),
            adapterAttempts: attemptNumber,
            reason: "cancelled"
          });
        }
        const remainingMs = remainingDurationMs(budget, startedAt);
        if (remainingMs <= 0) {
          return createRuntimeFailure(route.backend, route.model, "execution duration budget exhausted", {
            durationMs: Date.now() - startedAt,
            retries: Math.max(0, attemptNumber - 1),
            adapterAttempts: attemptNumber,
            reason: "total_duration_budget_exhausted"
          });
        }
        attemptNumber += 1;
        try {
          const repairDetails = schemaValidationIssues.slice(0, 20).map((issue) => {
            const issuePath = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join(".") : "root";
            return `- ${issuePath}: ${issue.message || issue.code || "invalid value"}`;
          });
          const prompt = ["schema_invalid", "output_parse_invalid"].includes(lastResult?.reason) && input.schemaRepairPrompt
            ? [
              input.schemaRepairPrompt,
              `This is schema repair attempt ${schemaRepairAttempts + 1}.`,
              ...(repairDetails.length > 0 ? ["Validation issues:", ...repairDetails] : ["The previous response was not parseable as the required JSON object."])
            ].join("\n")
            : lastResult?.reason === "web_evidence_invalid" && input.webEvidenceRepairPrompt
              ? [
                input.webEvidenceRepairPrompt,
                `This is carrier repair attempt ${webEvidenceRepairAttempts + 1}.`,
                "Return exactly one JSON object with result and webEvidence fields and nothing else.",
                "Answer the original task inside the result field. The original task follows.",
                "--- ORIGINAL TASK ---",
                request.prompt
              ].join("\n")
              : request.prompt;
          let result = await adapter.execute({ ...requestValidation.data, prompt, timeoutMs: Math.min(timeoutMs, remainingMs) });
          try {
            result = normalizeProviderResult(result, {
              requireCarrier: webEvidenceMode === "strict" || webEvidenceMode === "repair",
              allowPlainRepair: webEvidenceMode === "repair",
              rejectRestricted: webEvidenceMode !== "off",
              webIntentHeuristics: runtimeConfiguration.orchestration?.webIntentHeuristics === true,
              webIntentPrompt: request.prompt
            });
            if ((webEvidenceMode === "strict" || webEvidenceMode === "repair") && result.ok === true && Object.hasOwn(result, "result") && !Object.hasOwn(result, "webEvidence")) {
              throw new Error("web evidence carrier is required");
            }
          } catch {
            result = createRuntimeFailure(route.backend, route.model, "provider returned invalid web evidence", {
              durationMs: Date.now() - startedAt,
              retries: attemptNumber - 1,
              adapterAttempts: attemptNumber,
              reason: "web_evidence_invalid",
              metrics: {
                totalCostUsd: result?.metrics?.totalCostUsd ?? null,
                diagnostics: { failureStage: "result_parse", providerCode: null, settingsLockWaitMs: null, providerExecutionMs: null, stdoutBytes: null, stderrBytes: null }
              }
            });
          }
          const resultValidation = validateSubagentResult(result);
          if (!resultValidation.success) {
            result = createRuntimeFailure(route.backend, route.model, "adapter returned an invalid result", {
              durationMs: Date.now() - startedAt,
              retries: attemptNumber - 1,
              adapterAttempts: attemptNumber,
              reason: "schema_invalid"
            });
          } else {
            result = withModelIdentity(resultValidation.data, route.model);
          }
          if (result.ok && input.resultValidator) {
            const validation = input.resultValidator(result.result);
            if (!validation.ok) {
              schemaValidationIssues = Array.isArray(validation.validationIssues) ? validation.validationIssues : [];
              const adapterDiagnostics = result.metrics?.diagnostics;
              result = createRuntimeFailure(route.backend, route.model, "adapter returned an invalid structured result", {
                durationMs: Date.now() - startedAt,
                retries: attemptNumber - 1,
                adapterAttempts: attemptNumber,
                reason: validation.errorClass,
                metrics: {
                totalCostUsd: result?.metrics?.totalCostUsd ?? null,
                  diagnostics: { ...(adapterDiagnostics || {}), failureStage: "result_parse" }
                }
              });
            }
          }
          if (activeExecution.cancelled || input.abortSignal?.aborted) {
            return createRuntimeFailure(route.backend, route.model, "execution cancelled", {
              durationMs: Date.now() - startedAt,
              retries: attemptNumber - 1,
              adapterAttempts: attemptNumber,
              reason: "cancelled"
            });
          }
          const costKnown = Number.isFinite(result.metrics?.totalCostUsd);
          const attemptCostUsd = costKnown ? result.metrics.totalCostUsd : 0;
          totalCostUsd += attemptCostUsd;
          if (!costKnown) reservedCostUsd += budget.maxUnknownAttemptCostUsd || 0;
          const failureClass = result.ok ? null : classifyReturnedFailure(result);
          const diagnostics = result.metrics?.diagnostics || null;
          const attemptRecord = {
            number: attemptNumber,
            failureClass,
            failureStage: ["schema_invalid", "output_parse_invalid"].includes(failureClass)
              ? "result_parse"
              : normalizeFailureStage(diagnostics?.failureStage),
            providerCode: normalizeProviderCode(diagnostics?.providerCode),
            exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
            signal: normalizeProcessSignal(result.metrics?.signal),
            retryDecision: "not_applicable",
            retryStopReason: null,
            settingsLockWaitMs: Number.isInteger(diagnostics?.settingsLockWaitMs) ? diagnostics.settingsLockWaitMs : null,
            providerExecutionMs: Number.isInteger(diagnostics?.providerExecutionMs) ? diagnostics.providerExecutionMs : null,
            stdoutBucket: outputSizeBucket(diagnostics?.stdoutBytes),
            stderrBucket: outputSizeBucket(diagnostics?.stderrBytes),
            durationMs: Number.isInteger(result.durationMs) ? result.durationMs : 0,
            totalCostUsd: costKnown ? attemptCostUsd : null
          };
          attemptRecords.push(attemptRecord);
          const knownAttemptCosts = attemptRecords.length > 0 && attemptRecords.every((attempt) => Number.isFinite(attempt.totalCostUsd));
          lastResult = withRuntimeMetrics(result, attemptNumber - 1, {
            queueWaitMs: grant.queueWaitMs,
            cacheHit: false,
            totalCostUsd: knownAttemptCosts ? totalCostUsd : null,
            adapterAttempts: attemptNumber,
            attempts: attemptRecords
          });
           if (result.ok) {
             if (cacheKey) {
               const currentKey = await readOnlyCache.keyFor({ workspace: trustedWorkspace, backend: route.backend, model: route.model, profile: input.profile, prompt: input.prompt });
               if (currentKey === cacheKey) readOnlyCache.set(cacheKey, lastResult);
             }
             return lastResult;
           }
          if (failureClass === "web_evidence_invalid" && input.webEvidenceRepairPrompt && input.maxWebEvidenceRepairAttempts !== undefined) {
            const repairCurrentCost = totalCostUsd + reservedCostUsd;
            const repairBudgetExhausted = (budget.maxRetryCostUsd !== undefined && repairCurrentCost >= budget.maxRetryCostUsd)
              || (budget.maxRetryCostUsd !== undefined && budget.maxRetryCostReserveUsd !== undefined && repairCurrentCost + budget.maxRetryCostReserveUsd > budget.maxRetryCostUsd);
            if (webEvidenceRepairAttempts >= input.maxWebEvidenceRepairAttempts) {
              attemptRecord.retryDecision = "stop";
              attemptRecord.retryStopReason = "web_evidence_repair_exhausted";
              return lastResult;
            }
            if (attemptNumber >= budget.maxAttempts || repairBudgetExhausted) {
              attemptRecord.retryDecision = "stop";
              attemptRecord.retryStopReason = "web_evidence_repair_budget_exhausted";
              return lastResult;
            }
            webEvidenceRepairAttempts += 1;
            attemptRecord.retryDecision = "retry";
            attemptRecord.retryStopReason = null;
            await wait(0);
            continue;
          }
          if (["schema_invalid", "output_parse_invalid"].includes(failureClass) && input.maxSchemaRepairAttempts !== undefined) {
            if (schemaRepairAttempts >= input.maxSchemaRepairAttempts) {
              attemptRecord.retryDecision = "stop";
              attemptRecord.retryStopReason = "schema_repair_exhausted";
              return lastResult;
            }
            schemaRepairAttempts += 1;
          }
          const retryDecision = shouldRetry(failureClass, input.mode, attemptNumber, budget.maxAttempts, {
            maxRetryCostUsd: budget.maxRetryCostUsd,
            currentCost: totalCostUsd + reservedCostUsd,
            maxRetryCostReserveUsd: budget.maxRetryCostReserveUsd,
            baseDelayMs: budget.baseRetryDelayMs,
            maxDelayMs: budget.maxRetryDelayMs
          });
          attemptRecord.retryDecision = retryDecision.retryable ? "retry" : "stop";
          attemptRecord.retryStopReason = retryDecision.retryable ? null : retryDecision.reason;
          if (!retryDecision.retryable) {
            if (retryDecision.reason === "mutation_state_unknown") {
              return { ...lastResult, retryable: false, reason: "mutation_state_unknown" };
            }
            return lastResult;
          }
          await wait(retryDecision.delayMs || 0);
        } catch (error) {
          if (error.name === "AbortError" || activeExecution.cancelled || input.abortSignal?.aborted || /abort/i.test(String(error.message))) {
            return createRuntimeFailure(route.backend, route.model, "execution cancelled", {
              durationMs: Date.now() - startedAt,
              retries: attemptNumber - 1,
              adapterAttempts: attemptNumber,
              reason: "cancelled"
            });
          }
          const failureClass = classifyProcessFailure({ error, stderr: "", stdout: "", code: null }) || "process_error";
          reservedCostUsd += budget.maxUnknownAttemptCostUsd || 0;
          const retryPolicy = shouldRetry(failureClass, input.mode, attemptNumber, budget.maxAttempts, {
            maxRetryCostUsd: budget.maxRetryCostUsd,
            currentCost: totalCostUsd + reservedCostUsd,
            maxRetryCostReserveUsd: budget.maxRetryCostReserveUsd,
            baseDelayMs: budget.baseRetryDelayMs,
            maxDelayMs: budget.maxRetryDelayMs
          });
          attemptRecords.push({
            number: attemptNumber,
            failureClass,
            failureStage: null,
            providerCode: null,
            exitCode: null,
            signal: null,
            retryDecision: retryPolicy.retryable ? "retry" : "stop",
            retryStopReason: retryPolicy.retryable ? null : retryPolicy.reason,
            settingsLockWaitMs: null,
            providerExecutionMs: null,
            stdoutBucket: null,
            stderrBucket: null,
            durationMs: Date.now() - startedAt,
            totalCostUsd: null
          });
          const retryDecision = retryPolicy;
          lastResult = createRuntimeFailure(route.backend, route.model, error.message, {
            durationMs: Date.now() - startedAt,
            retries: attemptNumber - 1,
            adapterAttempts: attemptNumber,
            timedOut: failureClass === "timeout",
            reason: retryDecision.reason === "mutation_state_unknown" ? "mutation_state_unknown" : failureClass,
            metrics: { totalCostUsd: attemptRecords.every((attempt) => Number.isFinite(attempt.totalCostUsd)) ? totalCostUsd : null, attempts: attemptRecords }
          });
          if (!retryDecision.retryable) return lastResult;
          await wait(retryDecision.delayMs || 0);
        }
      }
      return lastResult || createRuntimeFailure(route.backend, route.model, "retry exhausted", {
        durationMs: Date.now() - startedAt,
        retries: attemptNumber,
        adapterAttempts: attemptNumber
      });
    } finally {
      if (activeExecutions.get(executionId) === activeExecution) activeExecutions.delete(executionId);
      input.abortSignal?.removeEventListener?.("abort", abortListener);
      coordinator.release(executionId);
    }
  }

  async function health(backendIds = Object.keys(runtimeAdapters), options = {}) {
    const selectedIds = [...new Set(backendIds)].sort();
    const cacheKey = selectedIds.join(",");
    const probeModels = Array.isArray(options.probeModels) ? [...new Set(options.probeModels)] : [];
    const probeCapabilities = Array.isArray(options.probeCapabilities) ? [...new Set(options.probeCapabilities)] : [];
    if ((probeModels.length > 0) !== (probeCapabilities.length > 0)) {
      throw new Error("probeModels and probeCapabilities must be provided together");
    }
    const build = async () => {
      const selectedAdapters = selectedIds.map((backendId) => runtimeAdapters[backendId]).filter(Boolean);
      const entries = await Promise.all(selectedAdapters.map(async (adapter) => {
        try {
          const agentConfiguration = runtimeConfiguration[adapter.id];
          return [adapter.id, {
            id: adapter.id,
            capabilities: adapter.capabilities,
            modePolicy: {
              defaultMode: agentConfiguration?.defaultMode || agentConfiguration?.mode || "read_only",
              allowedModes: resolveAllowedModes(agentConfiguration, adapter.capabilities)
            },
            configuredModels: configuredModels(runtimeConfiguration, adapter.id),
            health: normalizeHealthResult(await adapter.healthCheck(probeModels.length > 0 ? { recoverStaleSettings: false } : undefined))
          }];
        } catch (error) {
          return [adapter.id, {
            id: adapter.id,
            capabilities: adapter.capabilities,
            modePolicy: {
              defaultMode: runtimeConfiguration[adapter.id]?.defaultMode || runtimeConfiguration[adapter.id]?.mode || "read_only",
              allowedModes: resolveAllowedModes(runtimeConfiguration[adapter.id], adapter.capabilities)
            },
            configuredModels: configuredModels(runtimeConfiguration, adapter.id),
            health: normalizeHealthResult({ installed: false, version: null, authValid: null, executable: "unavailable", error: "unavailable" })
          }];
        }
      }));
      if (probeModels.length > 0) {
        const entry = entries.find(([adapterId]) => adapterId === "antigravity");
        const probeAdapter = runtimeAdapters.antigravity;
        if (entry && typeof probeAdapter?.probeCapabilities === "function") {
          const capabilityProbes = {};
          for (const model of probeModels) {
            const probe = normalizeCapabilityProbe(await probeAdapter.probeCapabilities({ model, capabilities: probeCapabilities }));
            capabilityProbes[model] = probe;
            try {
              await appendRedactedRunMetric(runtimeConfiguration, {
                recordType: "live_observation",
                recordedAt: new Date().toISOString(),
                backend: "antigravity",
                model,
                capabilities: {
                  modelAccess: probe.modelAccess,
                  toolFreeResponse: probe.toolFreeResponse,
                  workspaceRead: probe.workspaceRead,
                  webRead: probe.webRead
                },
                failureClass: probe.failureClass,
                checkedAt: probe.checkedAt
              });
            } catch {
            }
          }
          entry[1] = { ...entry[1], health: { ...entry[1].health, capabilityProbes } };
        }
      }
      const circuitIds = selectedAdapters.flatMap((adapter) => ["antigravity", "opencode"].includes(adapter.id)
        ? [adapter.id, ...new Set(configuredModels(runtimeConfiguration, adapter.id).map(({ resolvedModel }) => `${adapter.id}:${resolvedModel}`))]
        : [adapter.id]);
      const circuits = await circuitBreaker.snapshot(circuitIds);
      const costBudget = await getCostBudgetSnapshot(runtimeConfiguration);
      const result = {
        services: {
          capability: true,
          workspaceLock: true,
          delegationGuard: true,
          coreSchemas: true
        },
        adapters: Object.fromEntries(entries),
        circuits,
        costBudget: {
          ...costBudget,
          circuitBreakerOpen: Object.values(circuits).some((circuit) => circuit.state === "open")
        }
      };
      try {
        await appendRedactedRunMetric(runtimeConfiguration, {
          recordType: "health_snapshot",
          recordedAt: new Date().toISOString(),
          backend: "bridge-health",
          adapters: Object.fromEntries(entries.map(([adapterId, entry]) => [adapterId, {
            installed: entry.health.installed === true,
            version: entry.health.version || null,
            authValid: typeof entry.health.authValid === "boolean" ? entry.health.authValid : null,
            probes: entry.health.probes,
            capabilityProbes: entry.health.capabilityProbes,
            error: entry.health.error ? "unavailable" : null
          }]))
        });
      } catch {
      }
      return result;
    };
    if (probeModels.length > 0) return build();
    return healthCache.check(cacheKey, build);
  }

  async function runDeepSeek(input, trustedWorkspace, abortSignal) {
    if (input.mode === "edit") {
      const result = await executeControlledOpenCodeEdit(input, trustedWorkspace, abortSignal, {
        promote: true,
        resolvedModel: resolveDeepSeekModel(runtimeConfiguration, input.model),
        caller: "deepseek_edit",
        editAgentName: runtimeConfiguration.opencode?.deepSeekEditAgent || "deepseek-edit",
        providerLabel: "DeepSeek",
        timeoutMs: runtimeConfiguration.deepseek.timeoutMs
      });
      try {
        writeDeepSeekCheckpoint(runtimeConfiguration, createDeepSeekEditCheckpoint(input, result));
      } catch {
      }
      return result;
    }
    const request = createDeepSeekRuntimeRequest(runtimeConfiguration, input, canonicalizeTrustedWorkspace(trustedWorkspace), abortSignal);
    const checkpoint = createDeepSeekCheckpoint(input, await run(request));
    return writeDeepSeekCheckpoint(runtimeConfiguration, checkpoint);
  }

  async function runDeepSeekEditPilot(input, trustedWorkspace, abortSignal) {
    const result = await executeControlledOpenCodeEdit(input, trustedWorkspace, abortSignal, {
      promote: false,
      resolvedModel: resolveDeepSeekModel(runtimeConfiguration, input.model),
      caller: "deepseek_edit_pilot",
      editAgentName: runtimeConfiguration.opencode?.deepSeekEditAgent || "deepseek-edit",
      providerLabel: "DeepSeek",
      timeoutMs: runtimeConfiguration.deepseek.timeoutMs
    });
    try {
      writeDeepSeekCheckpoint(runtimeConfiguration, createDeepSeekEditCheckpoint({ ...input, role: "implementer" }, result));
    } catch {
    }
    return result;
  }

  async function runGlm(input, trustedWorkspace, abortSignal) {
    const resolvedModel = resolveGlmModel(runtimeConfiguration, input.model);
    if (input.mode === "edit") {
      return executeControlledOpenCodeEdit(input, trustedWorkspace, abortSignal, {
        promote: true,
        resolvedModel,
        caller: "glm_edit",
        editAgentName: runtimeConfiguration.opencode?.glmEditAgent || "glm-edit",
        providerLabel: "GLM",
        metricBackend: "glm",
        timeoutMs: runtimeConfiguration.glm?.timeoutMs || runtimeConfiguration.opencode?.timeoutMs
      });
    }
    const request = createGlmRuntimeRequest(runtimeConfiguration, input, canonicalizeTrustedWorkspace(trustedWorkspace), abortSignal);
    const checkpoint = createGlmCheckpoint(input, await run(request));
    return writeGlmCheckpoint(runtimeConfiguration, checkpoint);
  }

  async function runGlmEditPilot(input, trustedWorkspace, abortSignal) {
    return executeControlledOpenCodeEdit(input, trustedWorkspace, abortSignal, {
      promote: false,
      resolvedModel: resolveGlmModel(runtimeConfiguration, input.model),
      caller: "glm_edit_pilot",
      editAgentName: runtimeConfiguration.opencode?.glmEditAgent || "glm-edit",
      providerLabel: "GLM",
      metricBackend: "glm",
      timeoutMs: runtimeConfiguration.glm?.timeoutMs || runtimeConfiguration.opencode?.timeoutMs
    });
  }

  async function runCatalogProvider(provider, input, trustedWorkspace, abortSignal) {
    const resolvedModel = resolveCatalogModel(runtimeConfiguration, provider, input.model);
    const providerHealth = await checkCatalogProvider(runtimeConfiguration, provider);
    if (!providerHealth.models.some((entry) => entry.resolvedModel === resolvedModel && entry.available)) {
      if (input.mode === "edit") {
        return validateControlledEditResult({
          status: "failed",
          backend: "opencode",
          model: resolvedModel,
          requestedModel: input.model,
          resolvedModel,
          accessMode: "edit",
          summary: `${provider} model is not available in the OpenCode catalog`,
          failureClass: "model_unavailable",
          filesChanged: [],
          diff: "",
          applied: false,
          fallbacks: 0,
          cleanupCompleted: true
        }).data;
      }
      return createFailureSubagentResult("opencode", resolvedModel, {
        error: `${provider} model is not available in the OpenCode catalog`,
        reason: "model_unavailable",
        requestedModel: input.model,
        resolvedModel
      });
    }
    if (input.mode === "edit") {
      return executeControlledEdit(input, trustedWorkspace, abortSignal, {
        promote: true,
        attempts: [createControlledEditAttempt(provider, input.model)],
        prompt: buildCatalogEditPrompt(input, provider),
        providerLabel: provider === "kimi" ? "Kimi" : "Qwen",
        riskSignals: input.riskSignals
      });
    }
    return run({
      target: provider,
      prompt: input.objective,
      model: input.model,
      mode: "read_only",
      trustedWorkspace: canonicalizeTrustedWorkspace(trustedWorkspace),
      caller: `${provider}_opencode`,
      delegationDepth: 0,
      metricBackend: provider,
      timeoutMs: input.timeout_seconds ? input.timeout_seconds * 1000 : runtimeConfiguration[provider]?.timeoutMs,
      abortSignal
    });
  }

  function createControlledEditAttempt(target, model) {
    if (target === "codex") return { target, model, caller: "codex_edit", editAgentName: "codex-edit", providerLabel: "Codex" };
    if (target === "glm") return { target: "opencode", model: resolveGlmModel(runtimeConfiguration, model), caller: "glm_edit", editAgentName: runtimeConfiguration.opencode?.glmEditAgent || "glm-edit", metricBackend: "glm", providerLabel: "GLM" };
    if (target === "kimi") return { target: "opencode", model: resolveCatalogModel(runtimeConfiguration, "kimi", model), caller: "kimi_edit", editAgentName: runtimeConfiguration.opencode?.kimiEditAgent || "kimi-edit", metricBackend: "kimi", providerLabel: "Kimi" };
    if (target === "qwen") return { target: "opencode", model: resolveCatalogModel(runtimeConfiguration, "qwen", model), caller: "qwen_edit", editAgentName: runtimeConfiguration.opencode?.qwenEditAgent || "qwen-edit", metricBackend: "qwen", providerLabel: "Qwen" };
    if (target === "opencode") return { target, model, caller: String(model).startsWith("deepseek/") ? "deepseek_edit" : "controlled_edit", editAgentName: String(model).startsWith("deepseek/") ? runtimeConfiguration.opencode?.deepSeekEditAgent || "deepseek-edit" : runtimeConfiguration.opencode?.editAgent || "build", providerLabel: "OpenCode" };
    return { target, model, caller: "controlled_edit", editAgentName: "controlled-edit", providerLabel: target };
  }

  function controlledFallbackAllowed(failureClass) {
    return new Set(["rate_limited", "network", "timeout", "process_exit", "process_error", "provider_temporary_error", "provider_circuit_open", "mutation_state_unknown", "auth_invalid", "model_unavailable", "model_access_denied", "executable_missing"]).has(failureClass);
  }

  function buildProfileEditPrompt(input) {
    return [input.objective, `Düzenlenebilecek dosyalar: ${input.files.join(", ")}`, `Salt-okunur bağlam dosyaları: ${(input.contextFiles || []).join(", ") || "yok"}`, "Kabul kriterleri:", ...input.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`), "Yalnız seçilmiş dosyaları düzenle. Seçilmiş dosyaları ve bağlam dosyalarını incelemek için salt-okunur dosya komutları kullanabilirsin. Test, build, script, paket yöneticisi veya dosya mutasyonu yapan shell komutu çalıştırma; doğrulamayı ana orkestratör yapacak. Dış dizin, secret veya başka subagent kullanma."].join("\n");
  }

  async function runProfileEdit(input, trustedWorkspace, abortSignal) {
    const profile = runtimeConfiguration.orchestration?.taskProfiles?.[input.profile];
    if (!profile || profile.mode !== "edit") throw new Error("edit task profile is required");
    const targets = [{ target: profile.target, model: profile.model }, ...(profile.fallbackTargets || [])];
    return executeControlledEdit(input, trustedWorkspace, abortSignal, {
      promote: true,
      attempts: targets.map((target) => createControlledEditAttempt(target.target, target.model)),
      prompt: buildProfileEditPrompt(input),
      providerLabel: input.profile,
      riskSignals: input.riskSignals
    });
  }

  async function runProfileEditPilot(input, trustedWorkspace, abortSignal) {
    const profile = runtimeConfiguration.orchestration?.taskProfiles?.[input.profile];
    if (!profile || profile.mode !== "edit") throw new Error("edit task profile is required");
    if (profile.target !== "codex") throw new Error("edit pilot profile target must be codex");
    if (input.model !== undefined && profile.model !== input.model) throw new Error("edit pilot model does not match profile");
    return executeControlledEdit(input, trustedWorkspace, abortSignal, {
      promote: false,
      attempts: [createControlledEditAttempt(profile.target, profile.model)],
      prompt: buildProfileEditPrompt(input),
      providerLabel: input.profile,
      riskSignals: input.riskSignals
    });
  }

  async function executeControlledEdit(input, trustedWorkspace, abortSignal, options) {
    const { promote, attempts, prompt, providerLabel } = options;
    const sourceWorkspace = canonicalizeTrustedWorkspace(trustedWorkspace);
    const executionId = createExecutionId();
    const executionIdHash = crypto.createHash("sha256").update(executionId).digest("hex");
    const sourceLockId = promote ? executionId : null;
    if (sourceLockId && !await coordinator.acquire(sourceWorkspace, "edit", sourceLockId)) return { status: "failed", backend: "bridge", model: attempts[0].model, requestedModel: input.model, resolvedModel: attempts[0].model, accessMode: "edit", summary: `${providerLabel} edit source workspace lock unavailable`, failureClass: "workspace_lock_unavailable", filesChanged: [], diff: "", applied: false, fallbacks: 0, cleanupCompleted: true };
    let finalPayload;
    let allCleanupCompleted = true;
    let fallbackCount = 0;
    let completed = false;
    let terminalFailure = false;
    let observedCostUsd = 0;
    let costObserved = true;
    try {
      for (let index = 0; index < attempts.length; index += 1) {
        const attempt = attempts[index];
        let disposable;
        try {
          const contextFiles = input.contextFiles || [];
          disposable = provisionDisposableWorkspace(runtimeConfiguration, sourceWorkspace, [...input.files, ...contextFiles], input.files, attempt.editAgentName);
          const runtimeResult = await run({ target: attempt.target, prompt, model: attempt.model, mode: "edit", trustedWorkspace: disposable.workspace, caller: attempt.caller, delegationDepth: 0, metricBackend: attempt.metricBackend, timeoutMs: input.timeout_seconds ? input.timeout_seconds * 1000 : attempt.timeoutMs || runtimeConfiguration[attempt.target]?.timeoutMs || runtimeConfiguration.opencode?.timeoutMs, maxSchemaRepairAttempts: 0, abortSignal });
          const attemptCostUsd = runtimeResult.metrics?.totalCostUsd;
          if (Number.isFinite(attemptCostUsd)) observedCostUsd += attemptCostUsd;
          else if (runtimeResult.metrics?.cacheHit !== true) costObserved = false;
          let changes = disposable.collectChanges();
          const changeSetHash = calculateChangeSetHash(changes.changes);
          const approvalClass = classifyChangeSet(changes.changes, options.riskSignals);
          const approvalRequired = approvalClass !== "low_impact";
          const summary = runtimeResult.ok ? runtimeResult.result || `${attempt.providerLabel} edit completed` : runtimeResult.error || `${attempt.providerLabel} edit failed`;
          const secretDetected = containsSecretLikeValue(summary) || containsSecretLikeAddedValue(changes.diff);
          const noChanges = runtimeResult.ok && changes.filesChanged.length === 0;
          if (secretDetected) {
            finalPayload = { status: "failed", backend: runtimeResult.backend, model: runtimeResult.model, requestedModel: input.model, resolvedModel: runtimeResult.resolvedModel, accessMode: "edit", summary: `${attempt.providerLabel} edit output rejected by secret policy`, failureClass: "secret_detected", filesChanged: [], diff: "", applied: false, fallbacks: fallbackCount };
            terminalFailure = true;
          } else if (runtimeResult.ok && !noChanges) {
            if (promote && approvalRequired) {
              const orchestratorApprovable = isOrchestratorApprovableClass(approvalClass);
              let approvalRequestId;
              let approvalExpiresAt;
              let classificationStable = true;
              if (orchestratorApprovable) {
                const prepared = disposable.capturePreparedChanges();
                classificationStable = calculateChangeSetHash(prepared.changes) === changeSetHash && classifyChangeSet(prepared.changes, options.riskSignals) === approvalClass;
                if (classificationStable) {
                  const sourceStateEntries = captureSourceState(sourceWorkspace, prepared.filesChanged);
                  const stored = preparedEditRegistry.store({
                    executionIdHash,
                    changeSetHash,
                    approvalClass,
                    workspaceHash: fingerprintTrustedWorkspace(sourceWorkspace),
                    sourceStateHash: hashSourceState(sourceStateEntries),
                    changedPaths: prepared.filesChanged,
                    sourceStateEntries,
                    changes: prepared.changes,
                    filesChanged: prepared.filesChanged,
                    diff: prepared.diff,
                    backend: runtimeResult.backend,
                    model: runtimeResult.model,
                    requestedModel: input.model,
                    resolvedModel: runtimeResult.resolvedModel,
                    providerLabel: attempt.providerLabel
                  });
                  approvalRequestId = stored.approvalRequestId;
                  approvalExpiresAt = stored.expiresAt;
                }
              }
              if (!classificationStable) {
                finalPayload = { status: "failed", backend: runtimeResult.backend, model: runtimeResult.model, requestedModel: input.model, resolvedModel: runtimeResult.resolvedModel, accessMode: "edit", summary: `${attempt.providerLabel} edit workspace changed during classification`, failureClass: "pilot_failed", filesChanged: [], diff: "", applied: false, fallbacks: fallbackCount, executionIdHash };
              } else {
                finalPayload = { status: "failed", backend: runtimeResult.backend, model: runtimeResult.model, requestedModel: input.model, resolvedModel: runtimeResult.resolvedModel, accessMode: "edit", summary: orchestratorApprovable ? `${attempt.providerLabel} edit requires explicit approval` : `${attempt.providerLabel} edit requires operator approval outside the orchestrator channel`, failureClass: "approval_required", filesChanged: changes.filesChanged, diff: changes.diff, applied: false, fallbacks: fallbackCount, executionIdHash, changeSetHash, approvalClass, approvalRequired: true, ...(approvalRequestId ? { approvalRequestId, approvalExpiresAt } : {}) };
              }
              terminalFailure = true;
            } else if (promote) {
              const prepared = disposable.capturePreparedChanges();
              const stable = calculateChangeSetHash(prepared.changes) === changeSetHash && classifyChangeSet(prepared.changes, options.riskSignals) === approvalClass;
              if (!stable) {
                finalPayload = { status: "failed", backend: runtimeResult.backend, model: runtimeResult.model, requestedModel: input.model, resolvedModel: runtimeResult.resolvedModel, accessMode: "edit", summary: `${attempt.providerLabel} edit workspace changed during classification`, failureClass: "pilot_failed", filesChanged: [], diff: "", applied: false, fallbacks: fallbackCount, executionIdHash };
                terminalFailure = true;
              } else {
                const outcome = applyPreparedChanges(sourceWorkspace, prepared.changes, prepared.expectedStates);
                if (outcome.cleanupFailed === true) allCleanupCompleted = false;
                finalPayload = { status: "completed", backend: runtimeResult.backend, model: runtimeResult.model, requestedModel: input.model, resolvedModel: runtimeResult.resolvedModel, accessMode: "edit", summary, failureClass: null, filesChanged: prepared.filesChanged, diff: prepared.diff, applied: true, fallbacks: fallbackCount, executionIdHash, changeSetHash, approvalClass, approvalRequired: false, preview: false };
                completed = true;
              }
            } else {
              finalPayload = { status: "completed", backend: runtimeResult.backend, model: runtimeResult.model, requestedModel: input.model, resolvedModel: runtimeResult.resolvedModel, accessMode: "edit", summary, failureClass: null, filesChanged: changes.filesChanged, diff: changes.diff, applied: false, fallbacks: fallbackCount, executionIdHash, changeSetHash, approvalClass, approvalRequired, preview: true };
              completed = true;
            }
          } else {
            const failureClass = noChanges ? "no_changes" : runtimeResult.reason || "execution_failed";
            finalPayload = { status: "failed", backend: runtimeResult.backend, model: runtimeResult.model, requestedModel: input.model, resolvedModel: runtimeResult.resolvedModel, accessMode: "edit", summary: noChanges ? `${attempt.providerLabel} edit completed without file changes` : summary, failureClass, filesChanged: changes.filesChanged, diff: changes.diff, applied: false, fallbacks: fallbackCount, executionIdHash, changeSetHash, approvalClass, approvalRequired: false };
            if (!controlledFallbackAllowed(failureClass) || index === attempts.length - 1) terminalFailure = true;
            else fallbackCount += 1;
          }
        } catch (error) {
          if (error.cleanupIncomplete === true) allCleanupCompleted = false;
          costObserved = false;
          finalPayload = { status: "failed", backend: attempt.target, model: attempt.model, requestedModel: input.model, resolvedModel: attempt.model, accessMode: "edit", summary: error.message, failureClass: error.failureClass || "pilot_failed", filesChanged: [], diff: "", applied: false, fallbacks: fallbackCount, executionIdHash };
          break;
        } finally {
          try {
            if (disposable && !disposable.cleanup()) allCleanupCompleted = false;
          } catch {
            allCleanupCompleted = false;
          }
        }
        if (completed || terminalFailure) break;
      }
    } finally {
      if (sourceLockId) coordinator.release(sourceLockId);
    }
    let completedPayload;
    if (allCleanupCompleted) {
      completedPayload = { ...finalPayload, cleanupCompleted: true };
    } else if (finalPayload.status === "completed" && finalPayload.preview !== true) {
      completedPayload = { ...finalPayload, status: "failed", failureClass: "cleanup_failed", summary: `${finalPayload.summary}; ${providerLabel} edit cleanup failed`, cleanupCompleted: false };
    } else {
      const primaryFailureClass = finalPayload.status === "failed" && finalPayload.failureClass === null ? "cleanup_failed" : finalPayload.failureClass;
      completedPayload = { ...finalPayload, failureClass: primaryFailureClass, summary: `${finalPayload.summary}; ${providerLabel} edit cleanup failed`, cleanupCompleted: false };
    }
    if (costObserved) completedPayload = { ...completedPayload, metrics: { totalCostUsd: Number(observedCostUsd.toFixed(6)) } };
    const validation = validateControlledEditResult(completedPayload);
    if (validation.success) return validation.data;
    return {
      status: "failed",
      backend: "bridge",
      model: attempts[0].model,
      requestedModel: input.model,
      resolvedModel: attempts[0].model,
      accessMode: "edit",
      summary: `${providerLabel} edit result schema validation failed`,
      failureClass: "schema_invalid",
      filesChanged: [],
      diff: "",
      applied: false,
      fallbacks: fallbackCount,
      cleanupCompleted: allCleanupCompleted
    };
  }

  async function executeControlledOpenCodeEdit(input, trustedWorkspace, abortSignal, options) {
    const { promote, resolvedModel, caller, editAgentName, providerLabel, timeoutMs, metricBackend } = options;
    return executeControlledEdit(input, trustedWorkspace, abortSignal, { promote, attempts: [{ target: "opencode", model: resolvedModel, caller, editAgentName, providerLabel, metricBackend, timeoutMs }], prompt: providerLabel === "GLM" ? buildGlmEditPrompt(input) : buildDeepSeekEditPrompt(input), providerLabel, riskSignals: input.riskSignals });
  }

  function approvalInvalidResult(summary, request = {}) {
    return validateControlledEditResult({
      status: "failed",
      backend: request.backend || "bridge",
      model: request.model || "unknown",
      ...(request.requestedModel ? { requestedModel: request.requestedModel } : {}),
      ...(request.resolvedModel !== undefined ? { resolvedModel: request.resolvedModel } : {}),
      accessMode: "edit",
      summary,
      failureClass: "approval_invalid",
      filesChanged: [],
      diff: "",
      applied: false,
      fallbacks: 0,
      cleanupCompleted: true,
      approvalRequired: false
    }).data;
  }

  async function approvePreparedEdit(input, trustedWorkspace) {
    const sourceWorkspace = canonicalizeTrustedWorkspace(trustedWorkspace);
    const request = preparedEditRegistry.peek(input.approvalRequestId);
    if (!request) return approvalInvalidResult("prepared edit approval request is unknown or expired");
    if (!isOrchestratorApprovableClass(request.approvalClass)) return approvalInvalidResult("prepared edit approval class is not available in the orchestrator channel", request);
    const lockId = createExecutionId();
    if (!await coordinator.acquire(sourceWorkspace, "edit", lockId)) return validateControlledEditResult({
      status: "failed",
      backend: request.backend,
      model: request.model,
      requestedModel: request.requestedModel,
      resolvedModel: request.resolvedModel,
      accessMode: "edit",
      summary: "prepared edit approval source workspace lock unavailable",
      failureClass: "workspace_lock_unavailable",
      filesChanged: [],
      diff: "",
      applied: false,
      fallbacks: 0,
      cleanupCompleted: true,
      approvalRequired: false
    }).data;
    try {
      let workspaceHash;
      try {
        workspaceHash = fingerprintTrustedWorkspace(sourceWorkspace);
      } catch {
        return approvalInvalidResult("prepared edit approval source binding could not be verified", request);
      }
      if (workspaceHash !== request.workspaceHash) return approvalInvalidResult("prepared edit approval source binding does not match", request);
      let sourceStateEntries;
      try {
        sourceStateEntries = captureSourceState(sourceWorkspace, request.changedPaths);
      } catch {
        preparedEditRegistry.invalidate(input.approvalRequestId);
        return approvalInvalidResult("prepared edit approval source binding could not be verified", request);
      }
      const recoveryScan = detectRecoveryArtifacts(sourceWorkspace, request.changedPaths);
      if (recoveryScan.affectedPaths.length > 0 || recoveryScan.scanFailed) {
        return validateControlledEditResult({
          status: "failed",
          backend: request.backend,
          model: request.model,
          requestedModel: request.requestedModel,
          resolvedModel: request.resolvedModel,
          accessMode: "edit",
          summary: recoveryScan.scanFailed ? "prepared edit approval recovery scan could not complete" : "prepared edit approval requires manual recovery of interrupted promotion artifacts",
          failureClass: "recovery_required",
          filesChanged: [],
          diff: "",
          applied: false,
          fallbacks: 0,
          cleanupCompleted: true,
          approvalRequired: false
        }).data;
      }
      const consumed = preparedEditRegistry.consume(input.approvalRequestId, {
        executionIdHash: request.executionIdHash,
        changeSetHash: request.changeSetHash,
        approvalClass: request.approvalClass,
        workspaceHash,
        sourceStateHash: hashSourceState(sourceStateEntries)
      });
      if (!consumed) {
        preparedEditRegistry.invalidate(input.approvalRequestId);
        return approvalInvalidResult("prepared edit approval source binding does not match", request);
      }
      let releasedForRecovery = false;
      try {
        if (calculateChangeSetHash(consumed.changes) !== consumed.changeSetHash) return approvalInvalidResult("prepared edit approval record integrity check failed", request);
        const outcome = applyPreparedChanges(sourceWorkspace, consumed.changes, consumed.sourceStateEntries);
        if (outcome.cleanupFailed === true) {
          return validateControlledEditResult({
            status: "failed",
            backend: consumed.backend,
            model: consumed.model,
            requestedModel: consumed.requestedModel,
            resolvedModel: consumed.resolvedModel,
            accessMode: "edit",
            summary: `${consumed.providerLabel} approved edit applied but cleanup failed`,
            failureClass: "cleanup_failed",
            filesChanged: consumed.filesChanged,
            diff: consumed.diff,
            applied: true,
            fallbacks: 0,
            cleanupCompleted: false,
            executionIdHash: consumed.executionIdHash,
            changeSetHash: consumed.changeSetHash,
            approvalClass: consumed.approvalClass,
            approvalRequired: false
          }).data;
        }
        return validateControlledEditResult({
          status: "completed",
          backend: consumed.backend,
          model: consumed.model,
          requestedModel: consumed.requestedModel,
          resolvedModel: consumed.resolvedModel,
          accessMode: "edit",
          summary: `${consumed.providerLabel} approved edit applied`,
          failureClass: null,
          filesChanged: consumed.filesChanged,
          diff: consumed.diff,
          applied: true,
          fallbacks: 0,
          cleanupCompleted: true,
          executionIdHash: consumed.executionIdHash,
          changeSetHash: consumed.changeSetHash,
          approvalClass: consumed.approvalClass,
          approvalRequired: false,
          preview: false
        }).data;
      } catch (error) {
        if (error.failureClass === "recovery_required") {
          preparedEditRegistry.release(input.approvalRequestId);
          releasedForRecovery = true;
        }
        return validateControlledEditResult({
          status: "failed",
          backend: consumed.backend,
          model: consumed.model,
          requestedModel: consumed.requestedModel,
          resolvedModel: consumed.resolvedModel,
          accessMode: "edit",
          summary: error.message,
          failureClass: error.failureClass || (error.sourceStateChanged === true ? "approval_invalid" : "approval_apply_failed"),
          filesChanged: [],
          diff: "",
          applied: false,
          fallbacks: 0,
          cleanupCompleted: error.cleanupIncomplete !== true,
          executionIdHash: consumed.executionIdHash,
          changeSetHash: consumed.changeSetHash,
          approvalClass: consumed.approvalClass,
          approvalRequired: false
        }).data;
      } finally {
        if (!releasedForRecovery) preparedEditRegistry.settle(input.approvalRequestId);
      }
    } finally {
      coordinator.release(lockId);
    }
  }

  async function probeCapability({ target, model, trustedWorkspace }) {
    const probeTarget = typeof target === "string" && target.length > 0 ? target : "";
    if (!probeTarget) throw new Error("capability probe target is required");
    const result = await run({
      target: probeTarget,
      prompt: "Return only the exact token BRIDGE-PROBE-OK.",
      ...(model ? { model } : {}),
      mode: "read_only",
      trustedWorkspace,
      caller: "capability_probe",
      delegationDepth: 0,
      webEvidenceRequired: false
    });
    const normalizedProbeOutput = typeof result.result === "string" ? result.result.trim().normalize("NFC") : "";
    const tokenObserved = result.ok && normalizedProbeOutput === "BRIDGE-PROBE-OK";
    const probe = {
      provider: probeTarget,
      model: result.resolvedModel || result.model || model || null,
      capabilities: {
        modelAccess: result.ok ? "available" : "unavailable",
        toolFreeResponse: result.ok ? (tokenObserved ? "available" : "unavailable") : "not_probed",
        workspaceRead: "not_probed",
        webRead: "not_probed"
      },
      failureClass: result.ok ? null : capabilityFailureClass(classifyReturnedFailure(result)),
      checkedAt: new Date().toISOString()
    };
    let backend = probeTarget;
    try {
      backend = resolveRuntimeRoute({ target: probeTarget, model, mode: "read_only", trustedWorkspace, caller: "capability_probe", delegationDepth: 0 }, runtimeConfiguration).backend;
    } catch {
    }
    try {
      await appendRedactedRunMetric(runtimeConfiguration, {
        recordType: "live_observation",
        recordedAt: probe.checkedAt,
        backend,
        model: probe.model,
        capabilities: probe.capabilities,
        failureClass: probe.failureClass,
        checkedAt: probe.checkedAt
      });
    } catch {
    }
    return probe;
  }

  return {
    run,
    health,
    cancel,
    runDeepSeek,
    runDeepSeekEditPilot,
    runGlm,
    runGlmEditPilot,
    runCatalogProvider,
    runProfileEdit,
    runProfileEditPilot,
    approvePreparedEdit,
    probeCapability,
    checkLegacyDeepSeek: () => checkLegacy(runtimeConfiguration),
    checkGlm: () => checkGlm(runtimeConfiguration),
    checkCatalogProvider: (provider) => checkCatalogProvider(runtimeConfiguration, provider),
    workspaceLockSnapshot: () => coordinator.snapshot(),
    inspectTrustedWorkspace: (trustedWorkspace) => ({ fingerprint: fingerprintTrustedWorkspace(trustedWorkspace) }),
    configuration: runtimeConfiguration,
    host: Object.freeze({ ...host })
  };
}
