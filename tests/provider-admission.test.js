import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";
import { readRecentRuns } from "../subagent-bridge/src/recent-runs.js";
import { createProviderAdmission, resolveProviderAdmissionProfile } from "../subagent-bridge/src/services/provider-admission.js";
import { createWorkspaceCoordinator } from "../subagent-bridge/src/services/workspace-coordinator.js";

function createAdmission(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-admission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDirectory = path.join(root, "locks");
  const firstCoordinator = createWorkspaceCoordinator({ lockDirectory, staleLockMs: 5000, leaseHeartbeatMs: 250 });
  const secondCoordinator = createWorkspaceCoordinator({ lockDirectory, staleLockMs: 5000, leaseHeartbeatMs: 250 });
  const defaults = { defaultConcurrency: 1, profileConcurrency: {}, maxQueuedPerProfile: 10, pollIntervalMs: 10, maxWaitMs: 1000 };
  return {
    first: createProviderAdmission({ workspaceCoordinator: firstCoordinator, ...defaults, ...options }),
    second: createProviderAdmission({ workspaceCoordinator: secondCoordinator, ...defaults, ...options })
  };
}

test("PROVIDER-ADMISSION-01: aynı profile ve farklı model rotaları ortak provider grubuna yönlenir", () => {
  assert.equal(resolveProviderAdmissionProfile({ backend: "opencode", model: "deepseek/deepseek-v4-pro" }), "opencode:deepseek");
  assert.equal(resolveProviderAdmissionProfile({ backend: "opencode", model: "deepseek/deepseek-flash" }), "opencode:deepseek");
  assert.equal(resolveProviderAdmissionProfile({ backend: "opencode", model: "deepseek_pro" }), "opencode:deepseek");
  assert.equal(resolveProviderAdmissionProfile({ backend: "opencode", model: "deepseek_pro" }, {
    profileByRoute: { "opencode:deepseek_pro": "shared-primary" }
  }), "shared-primary");
  assert.equal(resolveProviderAdmissionProfile({ backend: "codex", model: "gpt-6.1-sol" }), "codex:codex");
  assert.equal(resolveProviderAdmissionProfile({ backend: "opencode", model: "deepseek/deepseek-v4-pro" }, {
    profileByRoute: { "opencode:deepseek/deepseek-v4-pro": "shared-primary" }
  }), "shared-primary");
});

test("PROVIDER-ADMISSION-02: direct/service örnekleri aynı profile limitini paylaşır", async (t) => {
  const admission = createAdmission(t, { defaultConcurrency: 2, maxQueuedPerProfile: 10 });
  const profileId = "opencode:deepseek";
  const firstPromise = admission.first.acquire(profileId, "direct-one", { timeoutMs: 1000 });
  const secondPromise = admission.second.acquire(profileId, "batch-two", { timeoutMs: 1000 });
  const first = await firstPromise;
  const second = await secondPromise;
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const waitingPromise = admission.first.acquire(profileId, "direct-three", { timeoutMs: 1000 });
  let waitingResolved = false;
  waitingPromise.then(() => { waitingResolved = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(waitingResolved, false);
  first.release();
  const waiting = await waitingPromise;
  assert.equal(waiting.ok, true);
  assert.ok(waiting.queueWaitMs >= 10);
  waiting.release();
  second.release();
});

test("PROVIDER-ADMISSION-03: cancellation, queue limit and timeout are bounded", async (t) => {
  const admission = createAdmission(t, { defaultConcurrency: 1, maxQueuedPerProfile: 1, pollIntervalMs: 10 });
  const profileId = "codex:codex";
  const holder = await admission.first.acquire(profileId, "holder", { timeoutMs: 1000 });
  assert.equal(holder.ok, true);

  const abortController = new AbortController();
  const cancelledPromise = admission.second.acquire(profileId, "cancelled-waiter", { signal: abortController.signal, timeoutMs: 1000 });
  const full = await admission.second.acquire(profileId, "overflow-waiter", { timeoutMs: 1000 });
  assert.equal(full.ok, false);
  assert.equal(full.reason, "provider_queue_full");
  abortController.abort();
  const cancelled = await cancelledPromise;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.reason, "cancelled");

  const timeoutPromise = admission.second.acquire(profileId, "timed-waiter", { timeoutMs: 30 });
  const timed = await timeoutPromise;
  assert.equal(timed.ok, false);
  assert.equal(timed.reason, "provider_queue_timeout");
  holder.release();
});

test("PROVIDER-ADMISSION-04: direct ve batch runtime çağrıları aynı host profil limitini paylaşır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-admission-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstWorkspace = path.join(root, "first");
  const secondWorkspace = path.join(root, "second");
  fs.mkdirSync(firstWorkspace);
  fs.mkdirSync(secondWorkspace);
  let active = 0;
  let maximumActive = 0;
  const providerTimeouts = [];
  const adapter = createAdapter("antigravity", {
    canRead: true,
    canWrite: true,
    supportsSandbox: true,
    supportsModelSelection: true
  });
  adapter.execute = async (request) => {
    providerTimeouts.push(request.timeoutMs);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 50));
    active -= 1;
    return {
      ok: true,
      backend: "antigravity",
      model: request.model,
      result: "ok",
      error: null,
      retryable: false,
      timedOut: false,
      exitCode: 0,
      durationMs: 50,
      metrics: { retries: 0, totalCostUsd: 0 }
    };
  };
  const configuration = {
    packageRoot: root,
    statePaths: {
      logs: path.join(root, "logs"),
      state: path.join(root, "state"),
      cache: path.join(root, "cache")
    },
    allowedRoots: [root],
    antigravity: { timeoutMs: 10000 },
    reliability: {
      maxAttempts: 1,
      maxTotalDurationMs: 10000,
      maxRetryCostUsd: 1,
      maxRetryCostReserveUsd: 0.1,
      maxUnknownAttemptCostUsd: 0.1
    },
    orchestration: {
      scheduler: { maxQueuedPerWorkspace: 10, staleLockMs: 60000, leaseHeartbeatMs: 1000 },
      readOnlyCache: { enabled: false, ttlMs: 1000, maxEntryBytes: 1024 },
      providerAdmission: { defaultConcurrency: 2, profileConcurrency: { "antigravity:antigravity": 1 }, maxQueuedPerProfile: 10, pollIntervalMs: 10, maxWaitMs: 5000 }
    },
    observability: { maxMetricFileBytes: 1048576, maxMetricRetentionDays: 10 }
  };
  const runtime = createBridgeRuntime({ configuration, adapters: { antigravity: adapter }, sleep: async () => {} });
  const direct = runtime.run({
    target: "gemini_flash_3_8",
    prompt: "Inspect workspace A",
    mode: "read_only",
    caller: "direct_test",
    delegationDepth: 0,
    trustedWorkspace: firstWorkspace,
    timeoutMs: 10000
  });
  const batch = runtime.run({
    target: "gemini_flash_3_8",
    prompt: "Inspect workspace B",
    mode: "read_only",
    caller: "parallel_batch",
    delegationDepth: 0,
    trustedWorkspace: secondWorkspace,
    timeoutMs: 10000
  });
  const [directResult, batchResult] = await Promise.all([direct, batch]);
  assert.equal(directResult.ok, true);
  assert.equal(batchResult.ok, true);
  assert.equal(maximumActive, 1);
  assert.ok(Math.max(directResult.metrics.queueWaitMs, batchResult.metrics.queueWaitMs) >= 20);
  assert.ok(providerTimeouts.some((timeoutMs) => timeoutMs < 10000));
  assert.equal(directResult.metrics.attempts.every((attempt) => Number.isInteger(attempt.providerAdmissionLeaseMs)), true);
  assert.equal(batchResult.metrics.attempts.every((attempt) => Number.isInteger(attempt.providerAdmissionLeaseMs)), true);
  const recentRuns = readRecentRuns(configuration);
  assert.equal(recentRuns.runCount, 2);
  assert.equal(recentRuns.runs.every((run) => Number.isInteger(run.providerAdmissionLeaseMs)), true, JSON.stringify(recentRuns.runs));
});

test("PROVIDER-ADMISSION-05: queue reddi half-open circuit probe'unu success saymaz", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-admission-circuit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePaths = {
    logs: path.join(root, "logs"),
    state: path.join(root, "state"),
    cache: path.join(root, "cache")
  };
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  let providerCalls = 0;
  const adapter = createAdapter("antigravity", {
    canRead: true,
    canWrite: true,
    supportsSandbox: true,
    supportsModelSelection: true
  });
  adapter.execute = async (request) => {
    providerCalls += 1;
    return {
      ok: false,
      backend: "antigravity",
      model: request.model,
      result: null,
      error: "network down",
      retryable: true,
      timedOut: false,
      exitCode: 1,
      durationMs: 1,
      reason: "network",
      metrics: { retries: 0, totalCostUsd: 0 }
    };
  };
  const runtime = createBridgeRuntime({
    configuration: {
      packageRoot: root,
      statePaths,
      allowedRoots: [root],
      antigravity: { timeoutMs: 1000 },
      reliability: { maxAttempts: 1, maxTotalDurationMs: 2000, maxRetryCostUsd: 1, maxRetryCostReserveUsd: 0.1, maxUnknownAttemptCostUsd: 0.1 },
      orchestration: {
        circuitBreaker: { failureThreshold: 1, windowMs: 60000, openMs: 10 },
        scheduler: { maxQueuedPerWorkspace: 10, staleLockMs: 60000, leaseHeartbeatMs: 1000 },
        readOnlyCache: { enabled: false, ttlMs: 1000, maxEntryBytes: 1024 },
        providerAdmission: { defaultConcurrency: 1, profileConcurrency: {}, profileByRoute: {}, maxQueuedPerProfile: 10, pollIntervalMs: 10, maxWaitMs: 40 }
      },
      observability: { maxMetricFileBytes: 1048576, maxMetricRetentionDays: 10 }
    },
    adapters: { antigravity: adapter },
    sleep: async () => {}
  });
  const request = {
    target: "gemini_flash_3_8",
    prompt: "inspect",
    mode: "read_only",
    caller: "test",
    delegationDepth: 0,
    trustedWorkspace: workspace
  };
  const initialFailure = await runtime.run(request);
  assert.equal(initialFailure.reason, "network");
  await new Promise((resolve) => setTimeout(resolve, 15));
  const coordinator = createWorkspaceCoordinator({ lockDirectory: path.join(statePaths.cache, "provider-admission-locks") });
  const profileId = resolveProviderAdmissionProfile({ backend: "antigravity", model: "gemini-3.8-flash-high" });
  const heldProviderSlot = coordinator.tryAcquire(`provider-admission:${profileId}:slot:0`, "external-provider-slot-holder");
  assert.ok(heldProviderSlot);
  const queueFailure = await runtime.run(request);
  assert.equal(queueFailure.reason, "provider_admission_unavailable");
  assert.equal(queueFailure.timedOut, true);
  assert.equal(queueFailure.metrics.diagnostics.failureStage, "provider_admission");
  assert.ok(queueFailure.metrics.queueWaitMs >= 30);
  assert.equal(providerCalls, 1);
  const health = await runtime.health(["antigravity"]);
  assert.equal(health.circuits["antigravity:gemini-3.8-flash-high"].state, "half_open");
  assert.equal(health.costBudget.activeReservations, 0);
  coordinator.release("external-provider-slot-holder");
});
