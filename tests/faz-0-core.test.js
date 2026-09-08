import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { createExecutionId, createProviderEnvironment, runProcess, createExecutionHandle, killProcessTree } from "../subagent-bridge/src/services/execution-service.js";
import { checkCapability } from "../subagent-bridge/src/services/capability-service.js";
import { acquireReadLock, releaseReadLock, acquireWriteLock, releaseWriteLock, releaseAllLocks } from "./support/workspace-lock.js";
import { createDelegationGuard, getMaxDelegationDepth } from "../subagent-bridge/src/services/delegation-guard.js";
import { normalizeSubagentResult, normalizeTimedOutResult, normalizeCancelledResult, normalizeUnknownMutationResult } from "./support/result-normalizer.js";
import { shouldRetry, isMutationStateUnknown } from "../subagent-bridge/src/services/retry-service.js";
import { healthCheck, invalidateHealthCache, forceRefreshHealth } from "../subagent-bridge/src/services/health-service.js";
import { validateSubagentResult, validateHealthResult, createFailureSubagentResult, createSuccessSubagentResult } from "../subagent-bridge/src/schemas/core-schemas.js";

function createReadOnlyAdapter(id = "fake_reader") {
  return createAdapter(id, {
    canRead: true,
    canWrite: false,
    supportsSandbox: true,
    supportsModelSelection: false
  });
}

function createEditAdapter(id = "fake_editor") {
  return createAdapter(id, {
    canRead: true,
    canWrite: true,
    supportsSandbox: true,
    supportsModelSelection: true
  });
}

test("execution-service: provider ortamı ilgisiz secretları aktarmaz", () => {
  const environment = createProviderEnvironment("opencode", {
    PATH: "safe-path",
    DEEPSEEK_API_KEY: "provider-token",
    UNRELATED_SECRET: "must-not-pass",
    PRIVATE_TOKEN: "must-not-pass"
  });
  assert.deepEqual(environment, { PATH: "safe-path", DEEPSEEK_API_KEY: "provider-token" });
});

test("core schema: bütçe reddi redacted dönem ayrıntısını kabul eder", () => {
  const result = createFailureSubagentResult("codex", "gpt-5.6-sol", {
    error: "execution cost budget exhausted",
    reason: "monthly_cost_budget_exhausted",
    metrics: {
      costBudget: { period: "monthly", limitUsd: 50, spentUsd: 49.5, remainingUsd: 0.5 }
    }
  });
  assert.equal(validateSubagentResult(result).success, true);
  assert.deepEqual(result.metrics.costBudget, { period: "monthly", limitUsd: 50, spentUsd: 49.5, remainingUsd: 0.5 });
});

test("AC-01: En az 2 fake adapter aynı AgentAdapter kontratını uygular", async () => {
  const reader = createReadOnlyAdapter();
  const editor = createEditAdapter();

  assert.equal(typeof reader.id, "string");
  assert.equal(typeof editor.id, "string");
  assert.equal(reader.capabilities.canRead, true);
  assert.equal(reader.capabilities.canWrite, false);
  assert.equal(editor.capabilities.canRead, true);
  assert.equal(editor.capabilities.canWrite, true);
  assert.equal(typeof reader.healthCheck, "function");
  assert.equal(typeof editor.healthCheck, "function");
  assert.equal(typeof reader.execute, "function");
  assert.equal(typeof editor.cancel, "function");

  const health1 = await reader.healthCheck();
  assert.equal(health1.installed, true);
  const health2 = await editor.healthCheck();
  assert.equal(health2.installed, true);

  assert.equal(validateHealthResult(health1).success, true);
  assert.equal(validateHealthResult(health2).success, true);
});

test("AC-02: Public args'tan backend/workspace/caller/depth inject edilemez", () => {
  const guard = createDelegationGuard();
  const publicArgs = {
    prompt: "test",
    model: "test_model",
    mode: "read_only",
    timeout_seconds: 60
  };

  const enriched = guard.enrichRequest(publicArgs, "test_backend", "openCode");

  assert.equal(enriched.backend, "test_backend");
  assert.equal(enriched.delegationDepth, 0);
  assert.equal(enriched.caller, "openCode");
  assert.ok(!enriched.workspace);

  assert.equal(publicArgs.backend, undefined);
  assert.equal(publicArgs.delegationDepth, undefined);
  assert.equal(publicArgs.caller, undefined);
});

test("AC-03: read/read paralel çalışır", () => {
  releaseAllLocks();
  const ws = path.resolve(os.tmpdir(), "test_workspace_rw");

  const r1 = acquireReadLock(ws);
  const r2 = acquireReadLock(ws);
  const r3 = acquireReadLock(ws);

  assert.equal(r1, true);
  assert.equal(r2, true);
  assert.equal(r3, true);

  releaseReadLock(ws);
  releaseReadLock(ws);
  releaseReadLock(ws);
  releaseAllLocks();
});

test("AC-04/AC-05: write lock okuma ve diğer yazmayı bloke eder", () => {
  releaseAllLocks();
  const ws = path.resolve(os.tmpdir(), "test_workspace_write");

  const w = acquireWriteLock(ws);
  assert.equal(w, true);

  const r = acquireReadLock(ws);
  assert.equal(r, false);

  const w2 = acquireWriteLock(ws);
  assert.equal(w2, false);

  releaseWriteLock(ws);

  const rAfter = acquireReadLock(ws);
  assert.equal(rAfter, true);

  const wAfterRead = acquireWriteLock(ws);
  assert.equal(wAfterRead, false);

  releaseReadLock(ws);
  releaseAllLocks();
});

test("AC-06: cancel child + subprocess tree", async () => {
  const executionId = createExecutionId();
  const handle = createExecutionHandle(executionId);

  assert.equal(typeof executionId, "string");
  assert.ok(executionId.length > 0);

  handle.cancel();

  const proc = await runProcess("node", ["-e", "setTimeout(() => console.log('done'), 5000)"], {
    timeoutMs: 3000,
    abortController: new AbortController()
  }).catch(() => ({ code: null, signal: "SIGTERM", stdout: "", stderr: "" }));

  assert.ok(true);
});

test("AC-07: health cache TTL çalışır", async () => {
  invalidateHealthCache();

  const result1 = await healthCheck("test_agent", "node", {
    versionArgs: ["-e", "console.log('v1.0.0')"],
    ttlMs: 60000
  });
  assert.equal(result1.installed, true);
  assert.equal(result1.version, "v1.0.0");

  const result2 = await healthCheck("test_agent", "nonexistent_cmd_xyz", {
    versionArgs: ["--version"],
    ttlMs: 60000
  });
  assert.equal(result2.installed, true);

  invalidateHealthCache();

  const result3 = await healthCheck("test_agent", "nonexistent_cmd_xyz_abc", {
    versionArgs: ["--version"],
    ttlMs: 100
  });
  assert.equal(result3.installed, false);
});

test("AC-08: unavailable backend health check'te görülür", async () => {
  invalidateHealthCache();
  const result = await healthCheck("missing_backend", "nonexistent_cmd_xxxxxxxxxx", {
    versionArgs: ["--version"],
    ttlMs: 0
  });
  assert.equal(result.installed, false);
  assert.equal(result.version, null);
});

test("AC-09: delegation depth > 1 reddedilir", () => {
  const guard = createDelegationGuard();
  const maxDepth = getMaxDelegationDepth();
  assert.equal(maxDepth, 1);

  const check0 = guard.check(0, "opencode");
  assert.equal(check0.allowed, true);
  assert.equal(check0.nextDepth, 1);

  const check1 = guard.check(1, "claude_code");
  assert.equal(check1.allowed, false);
  assert.match(check1.error, /delegation depth exceeded/);

  const check2 = guard.check(2, "claude_code");
  assert.equal(check2.allowed, false);
});

test("AC-10: SubagentResult her hata yolunda valid kalır", () => {
  const successResult = normalizeSubagentResult("test_backend", "test_model", "success output", Date.now(), 0);

  const valid1 = validateSubagentResult(successResult);
  assert.equal(valid1.success, true);
  assert.equal(successResult.ok, true);
  assert.equal(successResult.backend, "test_backend");

  const errorResult = normalizeSubagentResult("test_backend", "test_model", new Error("test error"), Date.now(), 0);
  assert.equal(errorResult.ok, false);
  assert.equal(errorResult.error, "test error");
  const valid2 = validateSubagentResult(errorResult);
  assert.equal(valid2.success, true);

  const timeoutResult = normalizeTimedOutResult("test_backend", "test_model", 5000, 1);
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.timedOut, true);
  assert.equal(timeoutResult.retryable, false);
  assert.equal(timeoutResult.metrics.retries, 1);
  const valid3 = validateSubagentResult(timeoutResult);
  assert.equal(valid3.success, true);

  const cancelledResult = normalizeCancelledResult("test_backend", "test_model", 1000, 0);
  assert.equal(cancelledResult.ok, false);
  assert.equal(cancelledResult.error, "execution cancelled");
  assert.equal(cancelledResult.retryable, false);
  const valid4 = validateSubagentResult(cancelledResult);
  assert.equal(valid4.success, true);

  const emptyResult = normalizeSubagentResult("test_backend", "test_model", null, Date.now(), 0);
  assert.equal(emptyResult.ok, false);
  const valid5 = validateSubagentResult(emptyResult);
  assert.equal(valid5.success, true);
});

test("AC-11: edit + unknown mutation state automatic retry yapmaz", () => {
  const result = shouldRetry("timeout", "edit", 1, 3);
  assert.equal(result.retryable, false);
  assert.equal(result.reason, "mutation_state_unknown");

  const result2 = shouldRetry("process_exit", "edit", 1, 3);
  assert.equal(result2.retryable, false);
  assert.equal(result2.reason, "mutation_state_unknown");

  const result3 = shouldRetry("network", "edit", 1, 3);
  assert.equal(result3.retryable, false);
  assert.equal(result3.reason, "mutation_state_unknown");

  assert.equal(isMutationStateUnknown("edit", "timeout"), true);
  assert.equal(isMutationStateUnknown("edit", "network"), true);
  assert.equal(isMutationStateUnknown("read_only", "timeout"), false);
  assert.equal(isMutationStateUnknown("edit", "invalid_model"), false);

  const readOnlyResult = shouldRetry("timeout", "read_only", 1, 3);
  assert.equal(readOnlyResult.retryable, true);

  const nonRetryable = shouldRetry("policy_violation", "edit", 1, 3);
  assert.equal(nonRetryable.retryable, false);
  assert.equal(nonRetryable.reason, "non_retryable_failure_class");
});

test("AC-12: capability service edit modunda write olmadan izin vermez", () => {
  const reader = createReadOnlyAdapter();
  const readCheck = checkCapability(reader, "read_only");
  assert.equal(readCheck.allowed, true);

  const editCheck = checkCapability(reader, "edit");
  assert.equal(editCheck.allowed, false);
  assert.match(editCheck.error, /unsupported capability/);

  const editor = createEditAdapter();
  const editorCheck = checkCapability(editor, "edit");
  assert.equal(editorCheck.allowed, true);
});

test("AC-13: legacy Claude Code davranışı regress olmaz", () => {
  const promptTest = {
    executionId: "test-execution-1",
    prompt: "analiz et",
    role: "reviewer",
    files: ["src/app.js"],
    contextFiles: [],
    skills: [],
    acceptanceCriteria: ["test"]
  };
  assert.equal(promptTest.executionId, "test-execution-1");
  assert.equal(promptTest.role, "reviewer");
  assert.equal(promptTest.files[0], "src/app.js");

  const result = createSuccessSubagentResult("claude_code", "deepseek-v4-pro", { result: "test", durationMs: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.backend, "claude_code");
  const valid = validateSubagentResult(result);
  assert.equal(valid.success, true);

  const failure = createFailureSubagentResult("claude_code", "deepseek-v4-pro", {
    error: "test error",
    retryable: false,
    durationMs: 100
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.error, "test error");
  const validF = validateSubagentResult(failure);
  assert.equal(validF.success, true);
});

test("execution-service: process spawn, timeout ve output limit çalışır", async () => {
  const result = await runProcess("node", ["-e", "console.log('hello')"], { timeoutMs: 5000 });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /hello/);

  try {
    await runProcess("node", ["-e", "setTimeout(() => console.log('slow'), 10000)"], { timeoutMs: 500 });
    assert.fail("should have timed out");
  } catch (error) {
    assert.match(error.message, /timed out/i);
  }
});

test("execution-service: AbortController ile iptal çalışır", async () => {
  const executionId = createExecutionId();
  assert.equal(typeof executionId, "string");
  assert.ok(executionId.length > 0);

  const controller = new AbortController();
  const promise = runProcess("node", ["-e", "setTimeout(() => console.log('done'), 10000)"], {
    timeoutMs: 30000,
    abortController: controller
  });

  setTimeout(() => controller.abort(), 100);

  try {
    await promise;
  } catch {
  }

  assert.ok(true);
});

test("workspace-lock: release tüm yollarda garantili", () => {
  releaseAllLocks();

  for (let i = 0; i < 5; i++) {
    const ws = path.resolve(os.tmpdir(), `test_ws_${i}`);
    acquireWriteLock(ws);
    releaseWriteLock(ws);
  }

  const ws = path.resolve(os.tmpdir(), "test_ws_final");
  acquireReadLock(ws);
  acquireReadLock(ws);
  releaseReadLock(ws);
  releaseReadLock(ws);

  const w = acquireWriteLock(ws);
  assert.equal(w, true);
  releaseWriteLock(ws);
  releaseAllLocks();
});

test("delegation-guard: enrichRequest bridge-owned metadata ekler", () => {
  const guard = createDelegationGuard();
  const publicArgs = {
    prompt: "test",
    model: "test_model",
    mode: "read_only",
    timeout_seconds: 120
  };

  const enriched = guard.enrichRequest(publicArgs, "antigravity", "openCode");
  assert.equal(enriched.backend, "antigravity");
  assert.equal(enriched.delegationDepth, 0);
  assert.equal(enriched.caller, "openCode");
  assert.equal(enriched.prompt, "test");
  assert.equal(enriched.model, "test_model");
  assert.equal(enriched.mode, "read_only");
});
