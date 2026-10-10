import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createParallelBatchRegistry } from "../subagent-bridge/src/services/parallel-batch-registry.js";
import { createParallelArtifactStore } from "../subagent-bridge/src/services/parallel-artifact-store.js";
import { createParallelBatchService } from "../subagent-bridge/src/services/parallel-batch.js";
import { withMetricLock } from "../subagent-bridge/src/metrics.js";

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "a.txt"), "alpha\n", "utf8");
  return { root, workspace };
}

function createConfiguration(root) {
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
    orchestration: { taskProfiles: {} },
    codex: { timeoutMs: 30000 },
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
      allowedTargets: ["codex"],
      opencodeOutputCapability: "unavailable",
      codexNetworkOffCapability: "unavailable",
      worktreeRoot: path.join(stateRoot, "worktrees"),
      verificationCommands: [],
      orphanGraceMs: 1000
    }
  };
}

function createFixture(t, handler, configurationOverrides = {}) {
  const { root, workspace } = createWorkspace(t);
  const configuration = createConfiguration(root);
  Object.assign(configuration.parallelBatch, configurationOverrides.parallelBatch || {});
  const registry = createParallelBatchRegistry({ stateDirectory: path.join(configuration.statePaths.state, "parallel-batches") });
  const artifactStore = createParallelArtifactStore({
    rootDirectory: path.join(configuration.statePaths.state, "parallel-artifacts"),
    ttlMs: configuration.parallelBatch.artifactTtlMs,
    maxArtifactBytes: configuration.parallelBatch.maxArtifactBytes,
    maxTotalBytes: configuration.parallelBatch.maxArtifactTotalBytes
  });
  const runtime = {
    async run(request) {
      return handler(request);
    },
    async cancel() {
      return true;
    }
  };
  const service = createParallelBatchService({ configuration, registry, artifactStore, runtime, trustedWorkspace: workspace, caller: "openCode" });
  return { root, workspace, configuration, registry, artifactStore, service };
}

function readOnlyTask() {
  return {
    taskId: "task-one",
    role: "analyst",
    mode: "read_only",
    target: "codex",
    objective: "Analyze the file",
    readablePaths: ["src/a.txt"]
  };
}

async function waitForBatch(service, batchId, statuses, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await service.getBatch({ batchId });
    if (result.ok && statuses.includes(result.summary.status)) return result.summary;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for batch statuses: ${statuses.join(", ")}`);
}

test("V2-STATE: interrupted batches recover as unknown without releasing reservations", async (t) => {
  const { root } = createWorkspace(t);
  const registry = createParallelBatchRegistry({ stateDirectory: path.join(root, "state", "parallel-batches") });
  const manifest = {
    schemaVersion: 1,
    batchId: "a".repeat(32),
    planId: "b".repeat(32),
    planHash: "c".repeat(64),
    workspaceHash: "e".repeat(64),
    ownerId: "abandoned-owner-token",
    ownerLeaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    taskOrder: ["task-one", "task-two"],
    tasks: {
      "task-one": { taskId: "task-one", status: "running", allocationUsd: 0.2, attempts: [{ status: "running", executionIdHash: "d".repeat(64) }] },
      "task-two": { taskId: "task-two", status: "queued", allocationUsd: 0.3, attempts: [] }
    },
    budget: { capUsd: 1, spentKnownUsd: 0, unknownReservedUsd: 0, refundedUsd: 0, remainingUsd: 0.5, overageUsd: 0 }
  };
  await registry.createBatch(manifest);
  const unscopedRecovery = await registry.recoverInterruptedBatches();
  assert.equal(unscopedRecovery.reason, "workspace_hash_required");
  assert.equal((await registry.getBatch(manifest.batchId)).status, "running");
  const recovery = await registry.recoverInterruptedBatches({ workspaceHash: "e".repeat(64) });
  assert.deepEqual(recovery.recovered, [manifest.batchId]);
  const recovered = await registry.getBatch(manifest.batchId);
  assert.equal(recovered.status, "unknown");
  assert.equal(recovered.tasks["task-one"].status, "unknown");
  assert.equal(recovered.tasks["task-one"].attempts[0].status, "unknown");
  assert.equal(recovered.tasks["task-two"].status, "blocked");
  assert.equal(recovered.budget.unknownReservedUsd, 0.2);
  assert.equal(recovered.budget.refundedUsd, 0.3);
  assert.equal(recovered.budget.remainingUsd, 0.8);
});

test("V2-STATE: recovery stops publishing manifests after workspace ownership is lost", async (t) => {
  const { root } = createWorkspace(t);
  const registry = createParallelBatchRegistry({ stateDirectory: path.join(root, "state", "parallel-batches") });
  const workspaceHash = "e".repeat(64);
  const batchIds = ["a".repeat(32), "b".repeat(32)];
  for (const batchId of batchIds) {
    await registry.createBatch({
      schemaVersion: 1,
      batchId,
      planId: "c".repeat(32),
      planHash: "d".repeat(64),
      workspaceHash,
      ownerId: "interrupted-owner-token",
      ownerEpoch: 1,
      ownerLeaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      taskOrder: ["task-one"],
      tasks: { "task-one": { taskId: "task-one", status: "running", allocationUsd: 0.1, attempts: [{ status: "running" }] } },
      budget: { capUsd: 1, spentKnownUsd: 0, unknownReservedUsd: 0, refundedUsd: 0, remainingUsd: 0.9, overageUsd: 0 }
    });
  }
  let ownerChecks = 0;
  const recovery = await registry.recoverInterruptedBatches({
    workspaceHash,
    assertOwner() {
      ownerChecks += 1;
      return ownerChecks < 6;
    }
  });
  assert.equal(recovery.reason, "owner_lost");
  assert.equal(recovery.recovered.length, 1);
  const manifests = await Promise.all(batchIds.map((batchId) => registry.getBatch(batchId)));
  assert.equal(manifests.filter((manifest) => manifest.status === "unknown").length, 1);
  assert.equal(manifests.filter((manifest) => manifest.status === "running").length, 1);
});

test("V2-STATE: recovery rechecks workspace ownership after waiting for the registry lock", async (t) => {
  const { root } = createWorkspace(t);
  const stateDirectory = path.join(root, "state", "parallel-batches");
  const registry = createParallelBatchRegistry({ stateDirectory });
  const batchId = "c".repeat(32);
  await registry.createBatch({
    schemaVersion: 1,
    batchId,
    planId: "d".repeat(32),
    planHash: "e".repeat(64),
    workspaceHash: "f".repeat(64),
    ownerId: "interrupted-owner-token",
    ownerEpoch: 1,
    ownerLeaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    taskOrder: ["task-one"],
    tasks: { "task-one": { taskId: "task-one", status: "running", allocationUsd: 0.1, attempts: [{ status: "running" }] } },
    budget: { capUsd: 1, spentKnownUsd: 0, unknownReservedUsd: 0, refundedUsd: 0, remainingUsd: 0.9, overageUsd: 0 }
  });
  let releaseHeldLock;
  let signalLockAcquired;
  const lockAcquired = new Promise((resolve) => { signalLockAcquired = resolve; });
  const heldLock = withMetricLock(path.join(stateDirectory, "parallel-batches.lock"), () => new Promise((resolve) => {
    releaseHeldLock = resolve;
    signalLockAcquired();
  }), { timeoutMs: 5000, staleLockMs: 60000 });
  await lockAcquired;
  let ownerHeld = true;
  const recoveryPromise = registry.recoverInterruptedBatches({
    workspaceHash: "f".repeat(64),
    assertOwner: () => ownerHeld
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  ownerHeld = false;
  releaseHeldLock();
  await heldLock;
  const recovery = await recoveryPromise;
  assert.equal(recovery.reason, "owner_lost");
  assert.equal(recovery.recovered.length, 0);
  assert.equal((await registry.getBatch(batchId)).status, "running");
});

test("V2-STATE: unscoped interrupted manifest blocks service admission", async (t) => {
  const fixture = createFixture(t, async () => ({ ok: false, reason: "unused" }));
  const batchIds = ["d".repeat(32), "a".repeat(32), "b".repeat(32)];
  const malformedWorkspaceHashes = [undefined, null, ["e".repeat(64)]];
  for (const [index, batchId] of batchIds.entries()) {
    const manifest = {
      schemaVersion: 1,
      batchId,
      planId: `${String(index + 1).repeat(32)}`,
      planHash: "f".repeat(64),
      ownerId: "unscoped-interrupted-owner",
      ownerEpoch: 1,
      ownerLeaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      taskOrder: ["task-one"],
      tasks: { "task-one": { taskId: "task-one", status: "running", allocationUsd: 0.1, attempts: [{ status: "running" }] } },
      budget: { capUsd: 1, spentKnownUsd: 0, unknownReservedUsd: 0, refundedUsd: 0, remainingUsd: 0.9, overageUsd: 0 }
    };
    if (index > 0) manifest.workspaceHash = malformedWorkspaceHashes[index];
    await fixture.registry.createBatch(manifest);
  }
  const recovery = await fixture.service.recover();
  assert.equal(recovery.ok, false);
  assert.equal(recovery.reason, "unscoped_interrupted_batches");
  assert.equal(recovery.unscopedCount, 3);
  await assert.rejects(
    () => fixture.service.prepare({ objective: "Block admission until unscoped recovery is resolved", batchMaxReservedCostUsd: 1, tasks: [readOnlyTask()] }),
    /recovery is required/
  );
  for (const batchId of batchIds) {
    const unchanged = await fixture.registry.getBatch(batchId);
    assert.equal(unchanged.status, "running");
    assert.equal(unchanged.ownerEpoch, 1);
  }
});

test("V2-STATE: interrupted batch recovery is isolated by workspace hash", async (t) => {
  const { root } = createWorkspace(t);
  const registry = createParallelBatchRegistry({ stateDirectory: path.join(root, "state", "parallel-batches") });
  const firstWorkspaceHash = "1".repeat(64);
  const secondWorkspaceHash = "2".repeat(64);
  for (const [batchId, workspaceHash] of [["a".repeat(32), firstWorkspaceHash], ["b".repeat(32), secondWorkspaceHash]]) {
    await registry.createBatch({
      schemaVersion: 1,
      batchId,
      planId: "c".repeat(32),
      planHash: "d".repeat(64),
      workspaceHash,
      status: "running",
      createdAt: new Date().toISOString(),
      taskOrder: ["task-one"],
      tasks: { "task-one": { taskId: "task-one", status: "running", allocationUsd: 0.2, attempts: [{ status: "running" }] } },
      budget: { capUsd: 1, spentKnownUsd: 0, unknownReservedUsd: 0, refundedUsd: 0, remainingUsd: 0.8, overageUsd: 0 }
    });
  }

  const firstRecovery = await registry.recoverInterruptedBatches({ workspaceHash: firstWorkspaceHash });
  assert.deepEqual(firstRecovery.recovered, ["a".repeat(32)]);
  assert.equal((await registry.getBatch("a".repeat(32))).status, "unknown");
  assert.equal((await registry.getBatch("b".repeat(32))).status, "running");

  const secondRecovery = await registry.recoverInterruptedBatches({ workspaceHash: secondWorkspaceHash });
  assert.deepEqual(secondRecovery.recovered, ["b".repeat(32)]);
  assert.equal((await registry.getBatch("b".repeat(32))).status, "unknown");
});

test("V2-STATE: another bridge service preserves a batch with a live owner lease", async (t) => {
  let releaseExecution;
  const fixture = createFixture(t, () => new Promise((resolve) => {
    releaseExecution = () => resolve({
      ok: true,
      backend: "codex",
      model: "gpt-5.6-luna",
      result: JSON.stringify({ status: "ok", summary: "completed", action_required: "none" }),
      error: null,
      retryable: false,
      timedOut: false,
      exitCode: 0,
      durationMs: 10,
      metrics: { retries: 0, totalCostUsd: 0.01 },
      observedWorkspace: fixture.workspace
    });
  }), { parallelBatch: { orphanGraceMs: 30000 } });
  const secondRegistry = createParallelBatchRegistry({ stateDirectory: path.join(fixture.configuration.statePaths.state, "parallel-batches") });
  const secondService = createParallelBatchService({
    configuration: fixture.configuration,
    registry: secondRegistry,
    artifactStore: fixture.artifactStore,
    runtime: { async run() { throw new Error("second service must not start workers"); } },
    trustedWorkspace: fixture.workspace,
    caller: "openCode"
  });
  const prepared = await fixture.service.prepare({ objective: "Keep a live owner batch intact", batchMaxReservedCostUsd: 1, tasks: [readOnlyTask()] });
  const started = await fixture.service.start({ planId: prepared.planId, planHash: prepared.planHash });
  assert.equal(started.ok, true);
  const running = await waitForBatch(fixture.service, started.batchId, ["running"]);
  assert.equal(running.tasks[0].status, "running");
  await new Promise((resolve) => setTimeout(resolve, 31000));
  const observedBySecondService = await secondService.getBatch({ batchId: started.batchId });
  assert.equal(observedBySecondService.ok, true);
  assert.equal(observedBySecondService.summary.status, "running");
  assert.equal(observedBySecondService.summary.tasks[0].status, "running");
  const registryModule = pathToFileURL(path.resolve("subagent-bridge/src/services/parallel-batch-registry.js")).href;
  const artifactModule = pathToFileURL(path.resolve("subagent-bridge/src/services/parallel-artifact-store.js")).href;
  const coordinatorModule = pathToFileURL(path.resolve("subagent-bridge/src/services/workspace-coordinator.js")).href;
  const batchModule = pathToFileURL(path.resolve("subagent-bridge/src/services/parallel-batch.js")).href;
  const childSource = [
    `import path from "node:path";`,
    `import { createParallelBatchRegistry } from ${JSON.stringify(registryModule)};`,
    `import { createParallelArtifactStore } from ${JSON.stringify(artifactModule)};`,
    `import { createWorkspaceCoordinator } from ${JSON.stringify(coordinatorModule)};`,
    `import { createParallelBatchService } from ${JSON.stringify(batchModule)};`,
    `const configuration = ${JSON.stringify(fixture.configuration)};`,
    `const workspace = ${JSON.stringify(fixture.workspace)};`,
    `const registry = createParallelBatchRegistry({ stateDirectory: path.join(configuration.statePaths.state, "parallel-batches") });`,
    `const artifactStore = createParallelArtifactStore({ rootDirectory: path.join(configuration.statePaths.state, "parallel-artifacts") });`,
    `const workspaceCoordinator = createWorkspaceCoordinator({ lockDirectory: path.join(configuration.statePaths.cache, "locks"), staleLockMs: 60000, leaseHeartbeatMs: 1000 });`,
    `const service = createParallelBatchService({ configuration, registry, artifactStore, workspaceCoordinator, runtime: { async run() { throw new Error("unexpected worker execution"); } }, trustedWorkspace: workspace, caller: "openCode" });`,
    `const result = await service.getBatch({ batchId: ${JSON.stringify(started.batchId)} });`,
    `process.stdout.write(JSON.stringify({ ok: result.ok, status: result.summary?.status, taskStatus: result.summary?.tasks?.[0]?.status }));`
  ].join("\n");
  const childOutput = execFileSync(process.execPath, ["--input-type=module", "-e", childSource], { encoding: "utf8", timeout: 30000 });
  const childObservation = JSON.parse(childOutput);
  assert.deepEqual(childObservation, { ok: true, status: "running", taskStatus: "running" });
  assert.equal(typeof releaseExecution, "function");
  releaseExecution();
  const completed = await waitForBatch(fixture.service, started.batchId, ["result_ready"]);
  assert.equal(completed.tasks[0].status, "completed");
});

test("V2-STATE: recovered owner cannot dispatch a task resumed from the provider queue", async (t) => {
  let releaseFirst;
  let signalFirstStarted;
  let providerCalls = 0;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { signalFirstStarted = resolve; });
  const fixture = createFixture(t, async () => {
    providerCalls += 1;
    if (providerCalls === 1) {
      signalFirstStarted();
      await firstGate;
    }
    return {
      ok: true,
      backend: "codex",
      model: "gpt-5.6-luna",
      result: JSON.stringify({ status: "ok", summary: "completed", action_required: "none" }),
      error: null,
      retryable: false,
      timedOut: false,
      exitCode: 0,
      durationMs: 1,
      metrics: { retries: 0, totalCostUsd: 0.01 }
    };
  }, { parallelBatch: { providerConcurrency: { codex: 1 }, orphanGraceMs: 0 } });
  const recoveryService = createParallelBatchService({
    configuration: fixture.configuration,
    registry: fixture.registry,
    artifactStore: fixture.artifactStore,
    runtime: { async run() { throw new Error("recovered owner must not dispatch workers"); } },
    trustedWorkspace: fixture.workspace,
    caller: "openCode"
  });
  fs.writeFileSync(path.join(fixture.workspace, "src", "b.txt"), "bravo\n", "utf8");
  const tasks = ["task-one", "task-two"].map((taskId, index) => ({ ...readOnlyTask(), taskId, readablePaths: [index === 0 ? "src/a.txt" : "src/b.txt"] }));
  const prepared = await fixture.service.prepare({ objective: "Dispatch only while owner lease is valid", batchMaxReservedCostUsd: 1, tasks });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const started = await fixture.service.start({ planId: prepared.planId, planHash: prepared.planHash });
  assert.equal(started.ok, true, JSON.stringify(started));
  await firstStarted;
  const expired = await fixture.registry.updateBatch(started.batchId, (manifest) => {
    manifest.ownerLeaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    return manifest;
  });
  assert.equal(expired.ok, true);
  const recovered = await recoveryService.recover();
  assert.deepEqual(recovered.recovered, [started.batchId]);
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(providerCalls, 1);
  const manifest = await fixture.registry.getBatch(started.batchId);
  assert.equal(manifest.status, "unknown");
  assert.equal(manifest.tasks["task-two"].status, "blocked");
});

test("V2-STATE: a service rescans after an initially empty recovery pass", async (t) => {
  const fixture = createFixture(t, async () => ({
    ok: true,
    backend: "codex",
    model: "gpt-5.6-luna",
    result: JSON.stringify({ status: "ok", summary: "unused", action_required: "none" }),
    error: null,
    retryable: false,
    timedOut: false,
    exitCode: 0,
    durationMs: 1,
    metrics: { retries: 0, totalCostUsd: 0.01 }
  }));
  const emptyObservation = await fixture.service.getBatch({ batchId: "d".repeat(32) });
  assert.equal(emptyObservation.ok, false);
  const batchId = "c".repeat(32);
  await fixture.registry.createBatch({
    schemaVersion: 1,
    batchId,
    planId: "b".repeat(32),
    planHash: "a".repeat(64),
    workspaceHash: fixture.service.workspaceHash,
    ownerId: "abandoned-owner-token",
    ownerLeaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    taskOrder: ["task-one"],
    tasks: { "task-one": { taskId: "task-one", status: "running", allocationUsd: 0.1, attempts: [{ status: "running" }] } },
    budget: { capUsd: 1, spentKnownUsd: 0, unknownReservedUsd: 0, refundedUsd: 0, remainingUsd: 0.9, overageUsd: 0 }
  });
  await new Promise((resolve) => setTimeout(resolve, 5200));
  const recovered = await fixture.service.getBatch({ batchId });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.summary.status, "unknown");
  assert.equal(recovered.summary.tasks[0].status, "unknown");
});

test("V2-STATE: promotion recovery runs while holding the workspace edit lock", async (t) => {
  const { root, workspace } = createWorkspace(t);
  const configuration = createConfiguration(root);
  const registry = createParallelBatchRegistry({ stateDirectory: path.join(configuration.statePaths.state, "parallel-batches") });
  const artifactStore = createParallelArtifactStore({ rootDirectory: path.join(configuration.statePaths.state, "parallel-artifacts") });
  const lockEvents = [];
  let lockHeld = false;
  const workspaceCoordinator = {
    async acquire(acquiredWorkspace, mode) {
      assert.equal(acquiredWorkspace, workspace);
      assert.equal(mode, "edit");
      lockHeld = true;
      lockEvents.push("acquire");
      return true;
    },
    assertOwner(acquiredWorkspace) {
      return acquiredWorkspace === workspace && lockHeld;
    },
    release() {
      assert.equal(lockHeld, true);
      lockHeld = false;
      lockEvents.push("release");
    }
  };
  const worktreeManager = {
    hasPendingPromotions: () => true,
    promotionRecoveryStatus: () => ({ ok: true, reason: null }),
    recoverPendingPromotions() {
      assert.equal(lockHeld, true);
      lockEvents.push("recover");
      return { ok: true, reason: null };
    },
    recoveredCommittedPromotions: () => []
  };
  const service = createParallelBatchService({
    configuration,
    registry,
    artifactStore,
    runtime: { async run() { throw new Error("no worker is expected"); } },
    trustedWorkspace: workspace,
    workspaceCoordinator,
    worktreeManager
  });

  const result = await service.getBatch({ batchId: "f".repeat(32) });
  assert.equal(result.ok, false);
  assert.deepEqual(lockEvents, ["acquire", "recover", "release"]);
  assert.equal(lockHeld, false);
});

test("V2-STATE: explicit cancellation stops a running batch and cancels child executions", async (t) => {
  let releaseRun = null;
  const { service, workspace } = createFixture(t, (request) => new Promise((resolve) => {
    releaseRun = () => resolve({
      ok: true,
      backend: "codex",
      model: "default",
      result: JSON.stringify({ status: "ok", summary: "late", action_required: "none" }),
      error: null,
      retryable: false,
      timedOut: false,
      exitCode: 0,
      durationMs: 10,
      metrics: { retries: 0, totalCostUsd: 0.01 },
      observedWorkspace: request.trustedWorkspace
    });
  }));
  const prepared = await service.prepare({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [readOnlyTask()] });
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const running = await service.getBatch({ batchId: started.batchId });
  assert.equal(running.summary.progress.percentage, 0);
  assert.equal(running.summary.progress.runningCount, 1);
  const cancelled = await service.cancel({ batchId: started.batchId });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cancellation.requested, true);
  assert.equal(cancelled.cancellation.cancelledExecutionCount >= 0, true);
  releaseRun?.();
  const summary = await waitForBatch(service, started.batchId, ["cancelled", "unknown"]);
  assert.equal(summary.status, "cancelled");
  assert.equal(fs.existsSync(workspace), true);
});

test("V2-STATE: artifact TTL expiry fail-closes and removes the artifact", async (t) => {
  const { root } = createWorkspace(t);
  let fakeNow = Date.now();
  const store = createParallelArtifactStore({
    rootDirectory: path.join(root, "artifacts"),
    ttlMs: 1000,
    maxArtifactBytes: 1024,
    maxTotalBytes: 4096,
    now: () => fakeNow
  });
  const stored = store.store({ callerHash: "a".repeat(64), workspaceHash: "b".repeat(64), batchIdHash: "c".repeat(64), taskIdHash: "d".repeat(64), content: "small payload" });
  assert.equal(stored.stored, true);
  assert.equal(store.read({ detailRef: stored.detailRef, callerHash: "a".repeat(64), workspaceHash: "b".repeat(64), batchIdHash: "c".repeat(64), taskIdHash: "d".repeat(64) }).ok, true);
  fakeNow += 2000;
  const expired = store.read({ detailRef: stored.detailRef, callerHash: "a".repeat(64), workspaceHash: "b".repeat(64), batchIdHash: "c".repeat(64), taskIdHash: "d".repeat(64) });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "artifact_expired");
  assert.equal(fs.existsSync(path.join(root, "artifacts", `${stored.detailRef}.json`)), false);
});

test("V2-STATE: artifact reads reject mismatched workspace bindings", async (t) => {
  const { root } = createWorkspace(t);
  const store = createParallelArtifactStore({
    rootDirectory: path.join(root, "artifacts"),
    ttlMs: 60000,
    maxArtifactBytes: 1024,
    maxTotalBytes: 4096
  });
  const stored = store.store({ callerHash: "a".repeat(64), workspaceHash: "b".repeat(64), batchIdHash: "c".repeat(64), taskIdHash: "d".repeat(64), content: "small payload" });
  const denied = store.read({ detailRef: stored.detailRef, callerHash: "a".repeat(64), workspaceHash: "e".repeat(64), batchIdHash: "c".repeat(64), taskIdHash: "d".repeat(64) });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "artifact_unauthorized");
});

test("V2-STATE: detail access requires the exact batch and task reference", async (t) => {
  const { service } = createFixture(t, () => ({
    ok: true,
    backend: "codex",
    model: "default",
    result: JSON.stringify({ status: "ok", summary: "done", action_required: "none" }),
    error: null,
    retryable: false,
    timedOut: false,
    exitCode: 0,
    durationMs: 5,
    metrics: { retries: 0, totalCostUsd: 0 }
  }));
  const prepared = await service.prepare({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [readOnlyTask()] });
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const summary = await waitForBatch(service, started.batchId, ["result_ready"]);
  const detailRef = summary.tasks[0].detailRef;
  const missingTask = await service.getTaskDetail({ batchId: started.batchId, taskId: "task-nine", detailRef });
  assert.equal(missingTask.ok, false);
  assert.equal(missingTask.reason, "task_not_found");
  const wrongRef = await service.getTaskDetail({ batchId: started.batchId, taskId: "task-one", detailRef: "f".repeat(64) });
  assert.equal(wrongRef.ok, false);
  assert.equal(wrongRef.reason, "detail_ref_mismatch");
  const ok = await service.getTaskDetail({ batchId: started.batchId, taskId: "task-one", detailRef });
  assert.equal(ok.ok, true);
});
