import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";
import { getCostBudgetSnapshot } from "../subagent-bridge/src/metrics.js";

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  for (const name of ["a", "b", "c", "d"]) fs.writeFileSync(path.join(workspace, "src", `${name}.txt`), `${name}\n`, "utf8");
  return { root, workspace };
}

function createConfiguration(root, overrides = {}) {
  const stateRoot = path.join(root, "runtime");
  return {
    packageRoot: root,
    statePaths: {
      logs: path.join(stateRoot, "logs"),
      state: path.join(stateRoot, "state"),
      cache: path.join(stateRoot, "cache")
    },
    reliability: { maxAttempts: 2, maxUnknownAttemptCostUsd: 0.1, dailyCostLimitUsd: 100, monthlyCostLimitUsd: 100, costBudgetEnforced: false },
    observability: { maxMetricFileBytes: 20971520, maxMetricRetentionDays: 45 },
    orchestration: {
      taskProfiles: {
        with_fallback: {
          target: "codex",
          model: "gpt-5.6-luna",
          mode: "read_only",
          priority: 10,
          cacheable: false,
          fallbackTargets: [{ target: "codex", model: "gpt-5.6-sol" }]
        }
      }
    },
    codex: { timeoutMs: 30000, maxRetries: 0 },
    parallelBatch: {
      enabled: true,
      editEnabled: false,
      maxWorkers: 5,
      providerConcurrency: { codex: 2 },
      defaultProviderConcurrency: 2,
      planTtlMs: 60000,
      maxSummaryCharacters: 4096,
      maxBatchSummaryBytes: 8192,
      maxReadablePathsPerTask: 10,
      maxContextFilesPerTask: 10,
      maxReadableSnapshotBytes: 1048576,
      artifactTtlMs: 60000,
      maxArtifactBytes: 65536,
      maxArtifactTotalBytes: 1048576,
      allowedTargets: ["codex", "opencode"],
      opencodeOutputCapability: "unavailable",
      codexNetworkOffCapability: "unavailable",
      worktreeRoot: path.join(stateRoot, "worktrees"),
      verificationCommands: [],
      orphanGraceMs: 1000,
      ...(overrides.parallelBatch || {})
    }
  };
}

function createReadAdapter(costUsd) {
  const adapter = createAdapter("codex", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => ({
    ok: true,
    backend: "codex",
    model: request.model || "default",
    result: JSON.stringify({ status: "ok", summary: "done", action_required: "none" }),
    error: null,
    retryable: false,
    timedOut: false,
    exitCode: 0,
    durationMs: 5,
    metrics: { retries: 0, totalCostUsd: costUsd }
  });
  return adapter;
}

function task(taskId, readablePath, overrides = {}) {
  return {
    taskId,
    role: "analyst",
    mode: "read_only",
    target: "codex",
    objective: `Analyze ${taskId}`,
    readablePaths: [readablePath],
    ...overrides
  };
}

async function waitForBatch(runtime, workspace, batchId, statuses, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runtime.getParallelBatch({ batchId }, workspace);
    if (result.ok && statuses.includes(result.summary.status)) return result.summary;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for batch statuses: ${statuses.join(", ")}`);
}

test("V2-BUDGET: batch admission estimate must fit the user-approved ceiling", async (t) => {
  const { root, workspace } = createWorkspace(t);
  const configuration = createConfiguration(root);
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: createReadAdapter(0) }, sleep: async () => {} });
  const tooSmall = await runtime.prepareParallelBatch({
    objective: "x",
    batchMaxReservedCostUsd: 0.2,
    tasks: [task("task-one", "src/a.txt"), task("task-two", "src/b.txt"), task("task-three", "src/c.txt")]
  }, workspace);
  assert.equal(tooSmall.ok, false);
  assert.equal(tooSmall.reason, "batch_budget_insufficient");
  const fits = await runtime.prepareParallelBatch({
    objective: "x",
    batchMaxReservedCostUsd: 0.3,
    tasks: [task("task-one", "src/a.txt"), task("task-two", "src/b.txt"), task("task-three", "src/c.txt")]
  }, workspace);
  assert.equal(fits.ok, true);
  assert.equal(fits.allocation.estimatedUsd, 0.3);
});

test("V2-BUDGET: fallback chains draw down the batch pool", async (t) => {
  const { root, workspace } = createWorkspace(t);
  const configuration = createConfiguration(root);
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: createReadAdapter(0) }, sleep: async () => {} });
  const prepared = await runtime.prepareParallelBatch({
    objective: "x",
    batchMaxReservedCostUsd: 0.15,
    tasks: [{ taskId: "task-one", role: "analyst", mode: "read_only", profile: "with_fallback", objective: "Analyze", readablePaths: ["src/a.txt"] }]
  }, workspace);
  assert.equal(prepared.ok, false);
  assert.equal(prepared.reason, "batch_budget_insufficient");
});

test("V2-BUDGET: known cost settles once globally and does not double count the batch pool", async (t) => {
  const { root, workspace } = createWorkspace(t);
  const configuration = createConfiguration(root);
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: createReadAdapter(0.02) }, sleep: async () => {} });
  const prepared = await runtime.prepareParallelBatch({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [task("task-one", "src/a.txt")] }, workspace);
  const started = await runtime.startParallelBatch({ planId: prepared.planId, planHash: prepared.planHash }, workspace);
  const summary = await waitForBatch(runtime, workspace, started.batchId, ["result_ready"]);
  assert.equal(summary.budget.settledKnownUsd, 0.02);
  assert.equal(summary.budget.unknownReservedUsd, 0);
  assert.equal(summary.budget.remainingUsd, 0.98);
  const snapshot = await getCostBudgetSnapshot(configuration);
  assert.equal(snapshot.costAccounting.limitMode, "advisory_only");
  assert.equal(snapshot.dailySpentUsd, 0.02);
  assert.equal(snapshot.monthlySpentUsd, 0.02);
});

test("V2-BUDGET: completed work leaves active task allocations reserved", async (t) => {
  const { root, workspace } = createWorkspace(t);
  const configuration = createConfiguration(root);
  configuration.reliability.maxAttempts = 1;
  let releaseSecondTask;
  let secondTaskStarted;
  const secondTaskSignal = new Promise((resolve) => { secondTaskStarted = resolve; });
  const adapter = createAdapter("codex", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    const second = request.prompt.includes("Analyze task-two");
    if (second) {
      secondTaskStarted();
      await new Promise((resolve) => { releaseSecondTask = resolve; });
    }
    return {
      ok: true,
      backend: "codex",
      model: request.model || "default",
      result: JSON.stringify({ status: "ok", summary: second ? "second" : "first", action_required: "none" }),
      error: null,
      retryable: false,
      timedOut: false,
      exitCode: 0,
      durationMs: 5,
      metrics: { retries: 0, totalCostUsd: second ? 0.03 : 0.02 }
    };
  };
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: adapter }, sleep: async () => {} });
  const prepared = await runtime.prepareParallelBatch({
    objective: "Run two independently admitted tasks",
    batchMaxReservedCostUsd: 1,
    tasks: [task("task-one", "src/a.txt"), task("task-two", "src/b.txt")]
  }, workspace);
  const started = await runtime.startParallelBatch({ planId: prepared.planId, planHash: prepared.planHash }, workspace);
  await secondTaskSignal;
  const deadline = Date.now() + 5000;
  let interim;
  while (Date.now() < deadline) {
    interim = await runtime.getParallelBatch({ batchId: started.batchId }, workspace);
    if (interim.summary.tasks.some((entry) => entry.taskId === "task-one" && entry.status === "completed")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(interim.summary.tasks.find((entry) => entry.taskId === "task-one").status, "completed");
  assert.equal(interim.summary.tasks.find((entry) => entry.taskId === "task-two").status, "running");
  assert.equal(interim.summary.budget.settledKnownUsd, 0.02);
  assert.equal(interim.summary.budget.reservedUsd, 0.12);
  assert.equal(interim.summary.budget.remainingUsd, 0.88);
  releaseSecondTask();
  const completed = await waitForBatch(runtime, workspace, started.batchId, ["result_ready"]);
  assert.equal(completed.budget.settledKnownUsd, 0.05);
  assert.equal(completed.budget.reservedUsd, 0.05);
  assert.equal(completed.budget.remainingUsd, 0.95);
});

test("V2-BUDGET: unknown cost keeps the allocation reserved in both ledgers", async (t) => {
  const { root, workspace } = createWorkspace(t);
  const configuration = createConfiguration(root);
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: createReadAdapter(null) }, sleep: async () => {} });
  const prepared = await runtime.prepareParallelBatch({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [task("task-one", "src/a.txt")] }, workspace);
  const started = await runtime.startParallelBatch({ planId: prepared.planId, planHash: prepared.planHash }, workspace);
  const summary = await waitForBatch(runtime, workspace, started.batchId, ["result_ready"]);
  assert.equal(summary.budget.settledKnownUsd, 0);
  assert.equal(summary.budget.unknownReservedUsd, 0.1);
  assert.equal(summary.budget.remainingUsd, 0.9);
  const snapshot = await getCostBudgetSnapshot(configuration);
  assert.equal(snapshot.dailySpentUsd, 0.1);
  assert.equal(snapshot.costMeasurement.unknownCostRuns, 1);
});

test("V2-BUDGET: period folding keeps future UTC windows empty", async (t) => {
  const { root, workspace } = createWorkspace(t);
  const configuration = createConfiguration(root);
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: createReadAdapter(0.02) }, sleep: async () => {} });
  const prepared = await runtime.prepareParallelBatch({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [task("task-one", "src/a.txt")] }, workspace);
  const started = await runtime.startParallelBatch({ planId: prepared.planId, planHash: prepared.planHash }, workspace);
  await waitForBatch(runtime, workspace, started.batchId, ["result_ready"]);
  const future = new Date(Date.now() + 40 * 86400000);
  const snapshot = await getCostBudgetSnapshot(configuration, future);
  assert.equal(snapshot.dailySpentUsd, 0);
  assert.equal(snapshot.monthlySpentUsd, 0);
});
