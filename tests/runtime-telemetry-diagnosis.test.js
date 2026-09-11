import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";
import { readRecentRuns } from "../subagent-bridge/src/recent-runs.js";

function successResult(backend, model, result = "ok", metrics = {}) {
  return {
    ok: true,
    backend,
    model,
    result,
    error: null,
    retryable: false,
    timedOut: false,
    exitCode: 0,
    durationMs: 1,
    metrics: { retries: 0, totalCostUsd: 0, ...metrics }
  };
}

function failureResult(backend, model, error, reason, metrics = {}) {
  return {
    ok: false,
    backend,
    model,
    result: null,
    error,
    retryable: true,
    timedOut: reason === "timeout",
    exitCode: reason === "timeout" ? null : 1,
    durationMs: 1,
    reason,
    metrics: { retries: 0, totalCostUsd: 0, ...metrics }
  };
}

function createFakeAdapter(id, execute) {
  const adapter = createAdapter(id, {
    canRead: true,
    canWrite: true,
    supportsSandbox: true,
    supportsModelSelection: true
  });
  adapter.execute = execute;
  return adapter;
}

function createConfiguration(packageRoot, stateRoot) {
  return {
    packageRoot,
    statePaths: {
      logs: path.join(stateRoot, "logs"),
      state: path.join(stateRoot, "state"),
      cache: path.join(stateRoot, "cache")
    },
    antigravity: { timeoutMs: 30000, maxRetries: 1 },
    reliability: {},
    orchestration: {}
  };
}

function diagnostics(overrides = {}) {
  return {
    failureStage: "provider_execution",
    providerCode: "connection_reset",
    settingsLockWaitMs: null,
    providerExecutionMs: 25,
    stdoutBytes: 0,
    stderrBytes: 1500,
    ...overrides
  };
}

function readMetricRecords(configuration) {
  const metricsDirectory = path.join(configuration.statePaths.logs, "metrics");
  return fs.readdirSync(metricsDirectory)
    .filter((entry) => entry.endsWith(".jsonl"))
    .flatMap((entry) => fs.readFileSync(path.join(metricsDirectory, entry), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
}

function fixtureDirectory(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rtd-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function runRuntime(runtime, root, overrides = {}) {
  return runtime.run({
    target: "gemini_flash_3_8",
    prompt: "inspect",
    mode: "read_only",
    caller: "test",
    delegationDepth: 0,
    trustedWorkspace: root,
    ...overrides
  });
}

test("RTD-01: read-only geçici hata retry kaydı ve ardından başarı üretir", async (t) => {
  const root = fixtureDirectory(t, "retry-success");
  const configuration = createConfiguration(root, root);
  let calls = 0;
  const antigravity = createFakeAdapter("antigravity", async (request) => {
    calls += 1;
    if (calls === 1) return failureResult("antigravity", request.model, "network down", "network", { diagnostics: diagnostics({ providerCode: "connection_reset", stderrBytes: 1500 }) });
    return successResult("antigravity", request.model, "recovered", { diagnostics: diagnostics({ failureStage: null, providerCode: null, stderrBytes: 0, stdoutBytes: 12 }) });
  });
  const runtime = createBridgeRuntime({ configuration, adapters: { antigravity }, sleep: async () => {} });
  const result = await runRuntime(runtime, root);
  assert.equal(result.ok, true);
  const [first, second] = result.metrics.attempts;
  assert.equal(first.failureClass, "network");
  assert.equal(first.retryDecision, "retry");
  assert.equal(first.retryStopReason, null);
  assert.equal(first.providerCode, "connection_reset");
  assert.equal(first.stderrBucket, "lte_64_kib");
  assert.equal(second.failureClass, null);
  assert.equal(second.retryDecision, "not_applicable");
  assert.equal(second.failureStage, null);
  assert.equal(second.stdoutBucket, "lte_1_kib");
  assert.equal(calls, 2);
  const view = readRecentRuns(configuration);
  assert.equal(view.runCount, 1);
  assert.equal(view.runs[0].failureClass, null);
  assert.equal(view.runs[0].cacheHit, false);
});

test("RTD-02: edit mutation_state_unknown attempt kaydında kalır ve metric failureClass ezilmez", async (t) => {
  const root = fixtureDirectory(t, "edit-mutation");
  const configuration = createConfiguration(root, root);
  const antigravity = createFakeAdapter("antigravity", async (request) => failureResult("antigravity", request.model, "process failed", "process_exit", {
    diagnostics: diagnostics({ providerCode: "process_exit", stderrBytes: 10, stdoutBytes: 0 })
  }));
  const runtime = createBridgeRuntime({ configuration, adapters: { antigravity }, sleep: async () => {} });
  const result = await runRuntime(runtime, root, { mode: "edit", caller: "controlled_edit" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "mutation_state_unknown");
  const record = result.metrics.attempts.at(-1);
  assert.equal(record.failureClass, "process_exit");
  assert.equal(record.retryDecision, "stop");
  assert.equal(record.retryStopReason, "mutation_state_unknown");
  const [metric] = readMetricRecords(configuration).filter((entry) => entry.schemaVersion === 2);
  assert.equal(metric.failureClass, "process_exit");
  assert.equal(metric.failureStage, "provider_execution");
  assert.equal(metric.retryStopReason, "mutation_state_unknown");
  assert.equal(metric.mode, "edit");
});

test("RTD-03: maksimum denemede retry durur ve stop nedeni kaydedilir", async (t) => {
  const root = fixtureDirectory(t, "max-attempts");
  const configuration = createConfiguration(root, root);
  const antigravity = createFakeAdapter("antigravity", async (request) => failureResult("antigravity", request.model, "quota", "rate_limited", {
    diagnostics: diagnostics({ providerCode: "resource_exhausted", stderrBytes: 20 })
  }));
  const runtime = createBridgeRuntime({ configuration, adapters: { antigravity }, sleep: async () => {} });
  const result = await runRuntime(runtime, root);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "rate_limited");
  assert.equal(result.metrics.attempts.length, 2);
  assert.equal(result.metrics.attempts[0].retryDecision, "retry");
  assert.equal(result.metrics.attempts[1].retryDecision, "stop");
  assert.equal(result.metrics.attempts[1].retryStopReason, "max_attempts_reached");
  const [metric] = readMetricRecords(configuration).filter((entry) => entry.schemaVersion === 2);
  assert.equal(metric.retryStopReason, "max_attempts_reached");
  assert.equal(metric.failureClass, "rate_limited");
});

test("RTD-04: tanısız adaptör sonucu attempt alanlarını null bırakır", async (t) => {
  const root = fixtureDirectory(t, "no-diagnostics");
  const configuration = createConfiguration(root, root);
  configuration.antigravity.maxRetries = 0;
  const antigravity = createFakeAdapter("antigravity", async (request) => failureResult("antigravity", request.model, "network down", "network"));
  const runtime = createBridgeRuntime({ configuration, adapters: { antigravity }, sleep: async () => {} });
  const result = await runRuntime(runtime, root);
  const record = result.metrics.attempts.at(-1);
  assert.equal(record.failureClass, "network");
  assert.equal(record.failureStage, null);
  assert.equal(record.providerCode, null);
  assert.equal(record.signal, null);
  assert.equal(record.settingsLockWaitMs, null);
  assert.equal(record.providerExecutionMs, null);
  assert.equal(record.stdoutBucket, null);
  assert.equal(record.stderrBucket, null);
  assert.equal(record.retryDecision, "stop");
  assert.equal(record.retryStopReason, "max_attempts_reached");
});

test("RTD-05: şema dışı adaptör sonucu result_parse aşamasına yazılır", async (t) => {
  const root = fixtureDirectory(t, "schema-invalid");
  const configuration = createConfiguration(root, root);
  configuration.antigravity.maxRetries = 0;
  const antigravity = createFakeAdapter("antigravity", async () => ({ ok: true }));
  const runtime = createBridgeRuntime({ configuration, adapters: { antigravity }, sleep: async () => {} });
  const result = await runRuntime(runtime, root);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "schema_invalid");
  const record = result.metrics.attempts.at(-1);
  assert.equal(record.failureClass, "schema_invalid");
  assert.equal(record.failureStage, "result_parse");
  assert.equal(record.retryDecision, "stop");
  const [metric] = readMetricRecords(configuration).filter((entry) => entry.schemaVersion === 2);
  assert.equal(metric.failureStage, "result_parse");
  assert.equal(metric.failureClass, "schema_invalid");
});

test("RTD-06: adaptör istisnası process_error olarak kaydedilir", async (t) => {
  const root = fixtureDirectory(t, "thrown");
  const configuration = createConfiguration(root, root);
  configuration.antigravity.maxRetries = 0;
  const antigravity = createFakeAdapter("antigravity", async () => {
    throw new Error("boom");
  });
  const runtime = createBridgeRuntime({ configuration, adapters: { antigravity }, sleep: async () => {} });
  const result = await runRuntime(runtime, root);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "process_error");
  const record = result.metrics.attempts.at(-1);
  assert.equal(record.failureClass, "process_error");
  assert.equal(record.failureStage, null);
  assert.equal(record.retryDecision, "stop");
  assert.equal(record.retryStopReason, "non_retryable_failure_class");
});

test("RTD-07: bütçe sınırında retry durur", async (t) => {
  const root = fixtureDirectory(t, "budget");
  const configuration = createConfiguration(root, root);
  configuration.antigravity.maxRetries = 3;
  configuration.reliability = { maxAttempts: 3, maxRetryCostUsd: 0, baseRetryDelayMs: 0, maxRetryDelayMs: 0 };
  const antigravity = createFakeAdapter("antigravity", async (request) => failureResult("antigravity", request.model, "network down", "network", {
    diagnostics: diagnostics({ providerCode: "connection_reset" })
  }));
  const runtime = createBridgeRuntime({ configuration, adapters: { antigravity }, sleep: async () => {} });
  const result = await runRuntime(runtime, root);
  assert.equal(result.ok, false);
  assert.equal(result.metrics.attempts.length, 1);
  assert.equal(result.metrics.attempts[0].retryDecision, "stop");
  assert.equal(result.metrics.attempts[0].retryStopReason, "budget_exhausted");
  const [metric] = readMetricRecords(configuration).filter((entry) => entry.schemaVersion === 2);
  assert.equal(metric.retryStopReason, "budget_exhausted");
});

test("RTD-08: v2 metrik recent-runs görünümünde son-attempt tanısını taşır", async (t) => {
  const root = fixtureDirectory(t, "recent-view");
  const configuration = createConfiguration(root, root);
  const antigravity = createFakeAdapter("antigravity", async (request) => failureResult("antigravity", request.model, "unavailable", "server", {
    diagnostics: diagnostics({ providerCode: "unavailable", providerExecutionMs: 42, settingsLockWaitMs: 7 })
  }));
  const runtime = createBridgeRuntime({ configuration, adapters: { antigravity }, sleep: async () => {} });
  await runRuntime(runtime, root);
  const view = readRecentRuns(configuration);
  assert.equal(view.runCount, 1);
  const run = view.runs[0];
  assert.equal(run.failureClass, "server");
  assert.equal(run.failureStage, "provider_execution");
  assert.equal(run.providerCode, "unavailable");
  assert.equal(run.retryStopReason, "max_attempts_reached");
  assert.equal(Object.hasOwn(run, "attempts"), false);
});

test("RTD-09: tanı süreleri ve boyut kovaları attempt kaydına taşınır", async (t) => {
  const root = fixtureDirectory(t, "timings");
  const configuration = createConfiguration(root, root);
  configuration.antigravity.maxRetries = 0;
  const antigravity = createFakeAdapter("antigravity", async (request) => failureResult("antigravity", request.model, "process failed", "process_exit", {
    diagnostics: diagnostics({ providerCode: "process_exit", settingsLockWaitMs: 15, providerExecutionMs: 40, stdoutBytes: 0, stderrBytes: 1500 })
  }));
  const runtime = createBridgeRuntime({ configuration, adapters: { antigravity }, sleep: async () => {} });
  const result = await runRuntime(runtime, root);
  const record = result.metrics.attempts.at(-1);
  assert.equal(record.settingsLockWaitMs, 15);
  assert.equal(record.providerExecutionMs, 40);
  assert.equal(record.stdoutBucket, "empty");
  assert.equal(record.stderrBucket, "lte_64_kib");
  assert.equal(record.failureStage, "provider_execution");
  assert.equal(record.providerCode, "process_exit");
});
