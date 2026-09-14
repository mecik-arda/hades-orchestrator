import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";
import { readRecentRuns } from "../subagent-bridge/src/recent-runs.js";
import {
  createFailureSubagentResult,
  createSuccessSubagentResult,
  validateSubagentResult
} from "../subagent-bridge/src/schemas/core-schemas.js";
import { readMetricsDirectory, summarizeMetrics } from "../scripts/report-metrics.js";

const promptSentinel = "DRILL_PROMPT_SENTINEL";
const secretSentinel = "DRILL_SECRET_SENTINEL";

function createFakeAdapter(execute) {
  const adapter = createAdapter("codex", {
    canRead: true,
    canWrite: true,
    supportsSandbox: true,
    supportsModelSelection: true
  });
  adapter.execute = execute;
  return adapter;
}

function createConfiguration(root, overrides = {}) {
  return {
    packageRoot: root,
    statePaths: {
      logs: path.join(root, "logs"),
      state: path.join(root, "state"),
      cache: path.join(root, "cache")
    },
    codex: { timeoutMs: 30000, maxRetries: 1 },
    antigravity: { timeoutMs: 30000, maxRetries: 1 },
    reliability: {
      maxAttempts: 2,
      maxTotalDurationMs: 60000,
      maxRetryCostUsd: 1,
      maxRetryCostReserveUsd: 0.1,
      maxUnknownAttemptCostUsd: 0.1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 2
    },
    orchestration: {
      scheduler: { maxQueuedPerWorkspace: 10, staleLockMs: 60000, leaseHeartbeatMs: 1000 },
      circuitBreaker: { failureThreshold: 1, windowMs: 60000, openMs: 30000 },
      readOnlyCache: { enabled: false, ttlMs: 1000, maxEntryBytes: 1024 }
    },
    observability: { maxMetricFileBytes: 16 * 1024 * 1024 },
    ...overrides
  };
}

function fixtureDirectory(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `drill-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runRequest(root, overrides = {}) {
  return {
    target: "codex",
    model: "gpt-5.6-terra",
    prompt: `${promptSentinel} inspect`,
    mode: "read_only",
    caller: "test",
    delegationDepth: 0,
    trustedWorkspace: root,
    ...overrides
  };
}

function runRecords(configuration) {
  return readMetricsDirectory(path.join(configuration.statePaths.logs, "metrics")).filter((record) => !record.recordType);
}

function assertRedactedMetric(record, root) {
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes(promptSentinel), false);
  assert.equal(serialized.includes(secretSentinel), false);
  assert.equal(serialized.includes(path.basename(root)), false);
  assert.equal(Object.hasOwn(record, "prompt"), false);
  assert.equal(Object.hasOwn(record, "workspace"), false);
}

test("DRILL-01: auth hatası yeniden denenmez, circuit'e yazılmaz ve metric redakte edilir", async (t) => {
  const root = fixtureDirectory(t, "auth");
  const configuration = createConfiguration(root);
  let calls = 0;
  const adapter = createFakeAdapter(async (request) => {
    calls += 1;
    return createFailureSubagentResult("codex", request.model, {
      error: `not signed in ${secretSentinel}`,
      retryable: false,
      reason: "authentication_failure"
    });
  });
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: adapter }, sleep: async () => {} });

  const result = await runtime.run(runRequest(root));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "authentication_failure");
  assert.equal(validateSubagentResult(result).success, true);
  assert.equal(calls, 1);
  assert.equal(result.metrics.attempts.length, 1);
  assert.equal(result.metrics.attempts[0].retryDecision, "stop");
  assert.equal(result.metrics.attempts[0].retryStopReason, "non_retryable_failure_class");

  const health = await runtime.health(["codex"]);
  assert.equal(health.circuits.codex.state, "closed");
  assert.equal(health.circuits.codex.failureCount, 0);

  const [metric] = runRecords(configuration);
  assert.equal(metric.outcomeStatus, "failed");
  assert.equal(metric.failureClass, "authentication_failure");
  assertRedactedMetric(metric, root);
});

test("DRILL-02: quota hatası retry edilir, circuit açılır ve sonraki çağrı fail-fast olur", async (t) => {
  const root = fixtureDirectory(t, "quota");
  const configuration = createConfiguration(root);
  let calls = 0;
  const adapter = createFakeAdapter(async (request) => {
    calls += 1;
    return createFailureSubagentResult("codex", request.model, {
      error: "quota exceeded",
      retryable: true,
      reason: "rate_limited"
    });
  });
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: adapter }, sleep: async () => {} });

  const first = await runtime.run(runRequest(root));
  assert.equal(first.ok, false);
  assert.equal(first.reason, "rate_limited");
  assert.equal(validateSubagentResult(first).success, true);
  assert.equal(calls, 2);
  assert.equal(first.metrics.attempts.length, 2);
  assert.equal(first.metrics.attempts[0].retryDecision, "retry");
  assert.equal(first.metrics.attempts[1].retryDecision, "stop");
  assert.equal(first.metrics.attempts[1].retryStopReason, "max_attempts_reached");

  const health = await runtime.health(["codex"]);
  assert.equal(health.circuits.codex.state, "open");
  assert.equal(health.circuits.codex.failureCount, 1);

  const second = await runtime.run(runRequest(root));
  assert.equal(second.ok, false);
  assert.equal(second.reason, "provider_circuit_open");
  assert.equal(validateSubagentResult(second).success, true);
  assert.equal(calls, 2);

  const metrics = runRecords(configuration);
  assert.equal(metrics.length, 2);
  assert.equal(metrics[0].failureClass, "rate_limited");
  assert.equal(metrics[1].failureClass, "provider_circuit_open");
  for (const metric of metrics) assertRedactedMetric(metric, root);
});

test("DRILL-03: izin hatası yeniden denenmez ve circuit kapalı kalır", async (t) => {
  const root = fixtureDirectory(t, "permission");
  const configuration = createConfiguration(root);
  let calls = 0;
  const adapter = createFakeAdapter(async (request) => {
    calls += 1;
    return createFailureSubagentResult("codex", request.model, {
      error: "permission denied",
      retryable: false,
      reason: "permission_denied"
    });
  });
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: adapter }, sleep: async () => {} });

  const result = await runtime.run(runRequest(root));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "permission_denied");
  assert.equal(calls, 1);
  assert.equal(result.metrics.attempts[0].retryStopReason, "non_retryable_failure_class");

  const health = await runtime.health(["codex"]);
  assert.equal(health.circuits.codex.state, "closed");
  assert.equal(health.circuits.codex.failureCount, 0);

  const [metric] = runRecords(configuration);
  assert.equal(metric.failureClass, "permission_denied");
  assertRedactedMetric(metric, root);
});

test("DRILL-04: bozuk sonuç schema_invalid olarak sınıflanır ve result_parse aşamasında kalır", async (t) => {
  const root = fixtureDirectory(t, "malformed");
  const configuration = createConfiguration(root);
  let calls = 0;
  const adapter = createFakeAdapter(async () => {
    calls += 1;
    return { ok: true };
  });
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: adapter }, sleep: async () => {} });

  const result = await runtime.run(runRequest(root));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "schema_invalid");
  assert.equal(validateSubagentResult(result).success, true);
  assert.equal(calls, 2);
  assert.equal(result.metrics.attempts.length, 2);
  assert.equal(result.metrics.attempts[0].failureClass, "schema_invalid");
  assert.equal(result.metrics.attempts[0].failureStage, "result_parse");
  assert.equal(result.metrics.attempts[0].retryDecision, "retry");
  assert.equal(result.metrics.attempts[1].retryStopReason, "max_attempts_reached");

  const health = await runtime.health(["codex"]);
  assert.equal(health.circuits.codex.state, "closed");
  assert.equal(health.circuits.codex.failureCount, 0);

  const [metric] = runRecords(configuration);
  assert.equal(metric.failureClass, "schema_invalid");
  assert.equal(metric.failureStage, "result_parse");
  assertRedactedMetric(metric, root);
});

test("DRILL-05: timeout read-only'de retry edilir, edit'te mutation_state_unknown olur", async (t) => {
  const readRoot = fixtureDirectory(t, "timeout-read");
  const readConfiguration = createConfiguration(readRoot);
  let readCalls = 0;
  const readAdapter = createFakeAdapter(async (request) => {
    readCalls += 1;
    if (readCalls === 1) {
      return createFailureSubagentResult("codex", request.model, {
        error: "execution timed out",
        retryable: true,
        timedOut: true,
        exitCode: null,
        reason: "timeout"
      });
    }
    return createSuccessSubagentResult("codex", request.model, { result: "recovered" });
  });
  const readRuntime = createBridgeRuntime({ configuration: readConfiguration, adapters: { codex: readAdapter }, sleep: async () => {} });

  const recovered = await readRuntime.run(runRequest(readRoot));
  assert.equal(recovered.ok, true);
  assert.equal(recovered.result, "recovered");
  assert.equal(readCalls, 2);
  assert.equal(recovered.metrics.attempts[0].failureClass, "timeout");
  assert.equal(recovered.metrics.attempts[0].retryDecision, "retry");

  const readHealth = await readRuntime.health(["codex"]);
  assert.equal(readHealth.circuits.codex.state, "closed");
  assert.equal(readHealth.circuits.codex.failureCount, 0);

  const [readMetric] = runRecords(readConfiguration);
  assert.equal(readMetric.outcomeStatus, "completed");
  assertRedactedMetric(readMetric, readRoot);

  const editRoot = fixtureDirectory(t, "timeout-edit");
  const editConfiguration = createConfiguration(editRoot);
  let editCalls = 0;
  const editAdapter = createFakeAdapter(async (request) => {
    editCalls += 1;
    return createFailureSubagentResult("codex", request.model, {
      error: "execution timed out",
      retryable: true,
      timedOut: true,
      exitCode: null,
      reason: "timeout"
    });
  });
  const editRuntime = createBridgeRuntime({ configuration: editConfiguration, adapters: { codex: editAdapter }, sleep: async () => {} });

  const editResult = await editRuntime.run(runRequest(editRoot, { mode: "edit", caller: "controlled_edit" }));
  assert.equal(editResult.ok, false);
  assert.equal(editResult.reason, "mutation_state_unknown");
  assert.equal(editResult.retryable, false);
  assert.equal(validateSubagentResult(editResult).success, true);
  assert.equal(editCalls, 1);
  assert.equal(editResult.metrics.attempts.length, 1);
  assert.equal(editResult.metrics.attempts[0].retryDecision, "stop");
  assert.equal(editResult.metrics.attempts[0].retryStopReason, "mutation_state_unknown");

  const editHealth = await editRuntime.health(["codex"]);
  assert.equal(editHealth.circuits.codex.state, "open");
  assert.equal(editHealth.circuits.codex.failureCount, 1);

  const [editMetric] = runRecords(editConfiguration);
  assert.equal(editMetric.mode, "edit");
  assert.equal(editMetric.failureClass, "timeout");
  assert.equal(editMetric.retryStopReason, "mutation_state_unknown");
  assertRedactedMetric(editMetric, editRoot);
});

test("DRILL-06: bayat workspace kilidi temizlenir ve çalışma kesintisiz tamamlanır", async (t) => {
  const root = fixtureDirectory(t, "stale-lock");
  const configuration = createConfiguration(root, {
    orchestration: {
      scheduler: { maxQueuedPerWorkspace: 10, staleLockMs: 50, leaseHeartbeatMs: 1000 },
      circuitBreaker: { failureThreshold: 1, windowMs: 60000, openMs: 30000 },
      readOnlyCache: { enabled: false, ttlMs: 1000, maxEntryBytes: 1024 }
    }
  });
  const workspaceKey = crypto.createHash("sha256").update(fs.realpathSync(root)).digest("hex");
  const lockDirectory = path.join(configuration.statePaths.cache, "locks", workspaceKey);
  fs.mkdirSync(lockDirectory, { recursive: true });
  const staleLockPath = path.join(lockDirectory, "write.lock");
  fs.writeFileSync(staleLockPath, "stale-owner", "utf8");
  const staleTimestamp = new Date(Date.now() - 60000);
  fs.utimesSync(staleLockPath, staleTimestamp, staleTimestamp);

  let calls = 0;
  const adapter = createFakeAdapter(async (request) => {
    calls += 1;
    return createSuccessSubagentResult("codex", request.model, { result: "stale lock cleared" });
  });
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: adapter }, sleep: async () => {} });

  const result = await runtime.run(runRequest(root));

  assert.equal(result.ok, true);
  assert.equal(result.result, "stale lock cleared");
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(staleLockPath), false);

  const [metric] = runRecords(configuration);
  assert.equal(metric.outcomeStatus, "completed");
  assertRedactedMetric(metric, root);
});

test("DRILL-07: iptal retry yapmadan cancelled sonucu üretir", async (t) => {
  const root = fixtureDirectory(t, "cancel");
  const configuration = createConfiguration(root);
  let resolveExecution;
  let calls = 0;
  const adapter = createFakeAdapter(async (request) => {
    calls += 1;
    return new Promise((resolve) => {
      resolveExecution = () => resolve(createFailureSubagentResult("codex", request.model, {
        error: "execution cancelled",
        retryable: false,
        reason: "cancelled"
      }));
    });
  });
  let cancelledExecutionId = null;
  adapter.cancel = async (executionId) => {
    cancelledExecutionId = executionId;
    resolveExecution();
  };
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: adapter }, sleep: async () => {} });

  const executionId = "drill-cancel-execution";
  const running = runtime.run(runRequest(root, { executionId }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await runtime.cancel(executionId), true);
  const result = await running;

  assert.equal(cancelledExecutionId, executionId);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cancelled");
  assert.equal(result.retryable, false);
  assert.equal(validateSubagentResult(result).success, true);
  assert.equal(calls, 1);

  const health = await runtime.health(["codex"]);
  assert.equal(health.circuits.codex.state, "closed");
  assert.equal(health.circuits.codex.failureCount, 0);

  const [metric] = runRecords(configuration);
  assert.equal(metric.failureClass, "cancelled");
  assertRedactedMetric(metric, root);
});

test("DRILL-LIVE-01: canlı probe sonucu ayrı live_observation sınıfında tutulur ve run istatistiğine karışmaz", async (t) => {
  const root = fixtureDirectory(t, "live-observation");
  const configuration = createConfiguration(root);
  const adapter = createAdapter("antigravity", {
    canRead: true,
    canWrite: true,
    supportsSandbox: true,
    supportsModelSelection: true
  });
  adapter.healthCheck = async () => ({
    installed: true,
    version: "1.0",
    authValid: null,
    executable: "agy",
    probes: {
      cli: "available",
      modelAccess: "not_probed",
      toolFreeResponse: "not_probed",
      workspaceRead: "not_probed",
      webRead: "not_probed"
    }
  });
  adapter.execute = async (request) => createSuccessSubagentResult("antigravity", request.model, { result: "ok", webEvidence: null });
  adapter.probeCapabilities = async ({ model }) => ({
    modelAccess: "available",
    toolFreeResponse: "not_probed",
    workspaceRead: "unavailable",
    webRead: "not_probed",
    failureClass: "PERMISSION SENTINEL free text",
    checkedAt: new Date().toISOString(),
    prompt: promptSentinel,
    stdout: secretSentinel
  });
  const runtime = createBridgeRuntime({ configuration, adapters: { antigravity: adapter }, sleep: async () => {} });

  await runtime.health(["antigravity"], {
    probeModels: ["gemini_flash_3_8"],
    probeCapabilities: ["modelAccess", "workspaceRead"]
  });

  const serialized = fs.readFileSync(path.join(configuration.statePaths.logs, "metrics", "antigravity-runs.jsonl"), "utf8");
  assert.equal(serialized.includes(promptSentinel), false);
  assert.equal(serialized.includes(secretSentinel), false);
  assert.equal(serialized.includes("PERMISSION SENTINEL"), false);
  const observation = serialized.trim().split("\n").map((line) => JSON.parse(line)).find((record) => record.recordType === "live_observation");
  assert.equal(observation.backend, "antigravity");
  assert.equal(observation.model, "gemini_flash_3_8");
  assert.equal(observation.capabilities.modelAccess, "available");
  assert.equal(observation.capabilities.workspaceRead, "unavailable");
  assert.equal(observation.failureClass, "unclassified");
  assert.match(observation.checkedAt, /^\d{4}-\d{2}-\d{2}T/);

  const summary = summarizeMetrics(readMetricsDirectory(path.join(configuration.statePaths.logs, "metrics")));
  assert.equal(summary.runCount, 0);
  assert.equal(summary.health.observationCount, 1);
  assert.equal(summary.liveObservations.gemini_flash_3_8.observationCount, 1);
  assert.equal(summary.liveObservations.gemini_flash_3_8.modelAccess, "available");
  assert.equal(summary.liveObservations.gemini_flash_3_8.workspaceRead, "unavailable");
  assert.deepEqual(summary.failureClasses, {});
  assert.equal(readRecentRuns(configuration).runCount, 0);
});
