import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";
import { createWorkspaceCoordinator } from "../subagent-bridge/src/services/workspace-coordinator.js";

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function createRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  git(root, ["init", "-q", "workspace"]);
  git(workspace, ["config", "user.email", "bridge@example.invalid"]);
  git(workspace, ["config", "user.name", "Bridge Test"]);
  fs.writeFileSync(path.join(workspace, "src", "a.txt"), "alpha\n", "utf8");
  fs.writeFileSync(path.join(workspace, "src", "b.txt"), "beta\n", "utf8");
  git(workspace, ["add", "-A"]);
  git(workspace, ["commit", "-qm", "initial"]);
  return { root, workspace, baseCommit: git(workspace, ["rev-parse", "HEAD"]).trim() };
}

function createConfiguration(root, verificationCommands = ["git diff --check"]) {
  const stateRoot = path.join(root, "runtime");
  return {
    packageRoot: root,
    statePaths: {
      logs: path.join(stateRoot, "logs"),
      state: path.join(stateRoot, "state"),
      cache: path.join(stateRoot, "cache")
    },
    reliability: { maxAttempts: 1, maxUnknownAttemptCostUsd: 0.1, dailyCostLimitUsd: 100, monthlyCostLimitUsd: 100, costBudgetEnforced: false },
    observability: { maxMetricFileBytes: 20971520, maxMetricRetentionDays: 45 },
    orchestration: { taskProfiles: {} },
    codex: { timeoutMs: 30000, maxRetries: 0, allowedModes: ["read_only", "edit"], defaultMode: "edit" },
    parallelBatch: {
      enabled: true,
      editEnabled: true,
      maxWorkers: 2,
      providerConcurrency: { codex: 1 },
      defaultProviderConcurrency: 1,
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
      codexNetworkOffCapability: "available",
      worktreeRoot: path.join(stateRoot, "worktrees"),
      verificationCommands,
      orphanGraceMs: 1000
    }
  };
}

function createEditAdapter(requests = []) {
  const adapter = createAdapter("codex", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    requests.push(request);
    if (request.mode === "edit") fs.writeFileSync(path.join(request.workspace, "src", "a.txt"), "edited by worker\n", "utf8");
    return {
      ok: true,
      backend: "codex",
      model: request.model || "default",
      result: JSON.stringify({ status: "ok", summary: "file edited", action_required: "none" }),
      error: null,
      retryable: false,
      timedOut: false,
      exitCode: 0,
      durationMs: 5,
      metrics: { retries: 0, totalCostUsd: 0.01 }
    };
  };
  return adapter;
}

function readOnlyTask() {
  return {
    taskId: "read-one",
    role: "reviewer",
    mode: "read_only",
    target: "codex",
    objective: "Review the selected companion file",
    readablePaths: ["src/b.txt"]
  };
}

async function waitForBatch(runtime, workspace, batchId, statuses, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let latestSummary = null;
  while (Date.now() < deadline) {
    const result = await runtime.getParallelBatch({ batchId }, workspace);
    if (result.ok) {
      latestSummary = result.summary;
      if (statuses.includes(result.summary.status)) return result.summary;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for batch statuses: ${statuses.join(", ")}; latest=${JSON.stringify(latestSummary)}`);
}

function editTask(verificationCommands = ["git diff --check"]) {
  return {
    taskId: "edit-one",
    role: "implementer",
    mode: "edit",
    target: "codex",
    objective: "Replace the file content",
    files: ["src/a.txt"],
    acceptanceCriteria: ["File contains the new content"],
    verificationCommands,
    stopConditions: ["Stop if the task needs a file outside the selected set"],
    resourceClaims: ["fixture:edit-repository"],
    maxFilesChanged: 1,
    maxFileBytes: 1024,
    maxTotalDiffBytes: 4096
  };
}

test("V2-INTEGRATION: edit batch prepares an approval-bound diff and applies it atomically", async (t) => {
  const { root, workspace, baseCommit } = createRepository(t);
  const configuration = createConfiguration(root);
  const observedRequests = [];
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: createEditAdapter(observedRequests) }, sleep: async () => {} });
  const prepared = await runtime.prepareParallelBatch({ objective: "Edit the file and review a file", batchMaxReservedCostUsd: 1, tasks: [editTask(), readOnlyTask()] }, workspace);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const started = await runtime.startParallelBatch({ planId: prepared.planId, planHash: prepared.planHash }, workspace);
  assert.equal(started.ok, true);
  const ready = await waitForBatch(runtime, workspace, started.batchId, ["ready_for_approval", "blocked", "failed"]);
  assert.equal(ready.status, "ready_for_approval");
  assert.equal(ready.approvalRequired, true);
  assert.deepEqual(ready.tasks[0].filesChanged, ["src/a.txt"]);
  assert.equal(ready.tasks[0].riskLevel, "low_impact");
  assert.equal(ready.tasks[0].verification.length, 1);
  assert.equal(ready.tasks[0].verification[0].exitCode, 0);
  const editRequest = observedRequests.find((request) => request.mode === "edit");
  assert.match(editRequest.prompt, /Stop conditions:/);
  assert.match(editRequest.prompt, /fixture:edit-repository/);
  assert.match(editRequest.prompt, /Host-run verification commands/);
  assert.deepEqual(ready.approval.filesChanged, ["src/a.txt"]);
  assert.match(ready.approval.approvalRef, /^[a-f0-9]{64}$/);
  assert.match(ready.approval.detailRef, /^[a-f0-9]{64}$/);
  const integrationPreview = await runtime.getParallelTaskDetail({
    batchId: started.batchId,
    taskId: "integration",
    detailRef: ready.approval.detailRef
  }, workspace);
  assert.equal(integrationPreview.ok, true);
  assert.match(JSON.parse(integrationPreview.page.content).diff, /edited by worker/);
  assert.equal(fs.readFileSync(path.join(workspace, "src", "a.txt"), "utf8"), "alpha\n");
  fs.writeFileSync(path.join(workspace, "src", "a.txt"), "user edit after preview\n", "utf8");
  const sourceFileDrift = await runtime.approveParallelIntegration({
    batchId: started.batchId,
    approvalRef: ready.approval.approvalRef,
    expectedDiffHash: ready.approval.diffHash
  }, workspace);
  assert.equal(sourceFileDrift.ok, false);
  assert.equal(sourceFileDrift.reason, "source_file_state_changed");
  assert.equal(fs.readFileSync(path.join(workspace, "src", "a.txt"), "utf8"), "user edit after preview\n");
  fs.writeFileSync(path.join(workspace, "src", "a.txt"), "alpha\n", "utf8");
  const competingCoordinator = createWorkspaceCoordinator({
    lockDirectory: path.join(configuration.statePaths.cache, "locks"),
    staleLockMs: 60000,
    leaseHeartbeatMs: 1000
  });
  const readerExecutionId = "approval-test-reader";
  const readGrant = await competingCoordinator.acquire(workspace, "read_only", readerExecutionId);
  assert.ok(readGrant);
  let approvalSettled = false;
  const approvalPromise = runtime.approveParallelIntegration({
    batchId: started.batchId,
    approvalRef: ready.approval.approvalRef,
    expectedDiffHash: ready.approval.diffHash
  }, workspace);
  void approvalPromise.then(() => { approvalSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(approvalSettled, false);
  assert.equal(fs.readFileSync(path.join(workspace, "src", "a.txt"), "utf8"), "alpha\n");
  competingCoordinator.release(readerExecutionId);
  const applied = await approvalPromise;
  assert.equal(applied.ok, true);
  assert.equal(applied.summary.status, "integrated");
  assert.doesNotMatch(applied.summary.message, /cleanup is pending/);
  assert.equal(fs.readFileSync(path.join(workspace, "src", "a.txt"), "utf8").replaceAll("\r\n", "\n"), "edited by worker\n");
  assert.equal(git(workspace, ["rev-parse", "HEAD"]).trim(), baseCommit);
  const promotionRoot = path.join(configuration.parallelBatch.worktreeRoot, "promotion-journals");
  const pendingJournalFiles = fs.readdirSync(promotionRoot).flatMap((workspaceHash) =>
    fs.readdirSync(path.join(promotionRoot, workspaceHash)).filter((entry) => entry.endsWith(".json")));
  assert.deepEqual(pendingJournalFiles, []);
});

test("V2-INTEGRATION: edit prompt uses host diff limits when task limits are omitted", async (t) => {
  const { root, workspace } = createRepository(t);
  const configuration = createConfiguration(root);
  configuration.parallelBatch.maxFilesChangedPerTask = 7;
  configuration.parallelBatch.maxFileBytesPerTask = 4096;
  configuration.parallelBatch.maxTotalDiffBytesPerTask = 16384;
  const observedRequests = [];
  const task = editTask();
  delete task.maxFilesChanged;
  delete task.maxFileBytes;
  delete task.maxTotalDiffBytes;
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: createEditAdapter(observedRequests) }, sleep: async () => {} });
  const prepared = await runtime.prepareParallelBatch({ objective: "Edit the file", batchMaxReservedCostUsd: 1, tasks: [task] }, workspace);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const started = await runtime.startParallelBatch({ planId: prepared.planId, planHash: prepared.planHash }, workspace);
  const ready = await waitForBatch(runtime, workspace, started.batchId, ["ready_for_approval", "blocked", "failed"]);
  assert.equal(ready.status, "ready_for_approval");
  const editRequest = observedRequests.find((request) => request.mode === "edit");
  assert.match(editRequest.prompt, /max files changed 7; max file bytes 4096; max total diff bytes 16384/);
});

test("V2-INTEGRATION: cancelling a ready diff prevents later approval", async (t) => {
  const { root, workspace } = createRepository(t);
  const configuration = createConfiguration(root);
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: createEditAdapter() }, sleep: async () => {} });
  const prepared = await runtime.prepareParallelBatch({ objective: "Edit the file", batchMaxReservedCostUsd: 1, tasks: [editTask()] }, workspace);
  const started = await runtime.startParallelBatch({ planId: prepared.planId, planHash: prepared.planHash }, workspace);
  const ready = await waitForBatch(runtime, workspace, started.batchId, ["ready_for_approval", "blocked", "failed"]);
  assert.equal(ready.status, "ready_for_approval");

  const competingCoordinator = createWorkspaceCoordinator({
    lockDirectory: path.join(configuration.statePaths.cache, "locks"),
    staleLockMs: 60000,
    leaseHeartbeatMs: 1000
  });
  const readerExecutionId = "cancel-approval-race-reader";
  const readGrant = await competingCoordinator.acquire(workspace, "read_only", readerExecutionId);
  assert.ok(readGrant);
  let approvalSettled = false;
  const approvalPromise = runtime.approveParallelIntegration({
    batchId: started.batchId,
    approvalRef: ready.approval.approvalRef,
    expectedDiffHash: ready.approval.diffHash
  }, workspace);
  void approvalPromise.then(() => { approvalSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(approvalSettled, false);
  const cancelled = await runtime.cancelParallelBatch({ batchId: started.batchId }, workspace);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.summary.status, "cancelled");
  assert.equal(cancelled.cancellation.requested, true);
  competingCoordinator.release(readerExecutionId);
  const approval = await approvalPromise;
  assert.equal(approval.ok, false);
  assert.equal(approval.reason, "integration_not_ready");
  assert.equal(fs.readFileSync(path.join(workspace, "src", "a.txt"), "utf8"), "alpha\n");
});

test("V2-INTEGRATION: task worktree refs are isolated from source refs", async (t) => {
  const { root, workspace, baseCommit } = createRepository(t);
  git(root, ["init", "--bare", "source-origin"]);
  git(workspace, ["remote", "add", "origin", path.join(root, "source-origin")]);
  const configuration = createConfiguration(root);
  const adapter = createEditAdapter();
  const originalExecute = adapter.execute.bind(adapter);
  let workerRefCreated = false;
  let workerRemotes = null;
  adapter.execute = async (request) => {
    if (request.mode === "edit") {
      workerRemotes = git(request.workspace, ["remote"]).trim();
      git(request.workspace, ["branch", "worker-created-ref"]);
      workerRefCreated = true;
    }
    return originalExecute(request);
  };
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: adapter }, sleep: async () => {} });
  const prepared = await runtime.prepareParallelBatch({
    objective: "Test private task worktree Git refs",
    batchMaxReservedCostUsd: 1,
    tasks: [editTask()]
  }, workspace);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const started = await runtime.startParallelBatch({ planId: prepared.planId, planHash: prepared.planHash }, workspace);
  const ready = await waitForBatch(runtime, workspace, started.batchId, ["ready_for_approval", "blocked", "failed"]);
  assert.equal(ready.status, "ready_for_approval");
  assert.equal(ready.tasks[0].status, "completed");
  assert.equal(workerRefCreated, true);
  assert.equal(workerRemotes, "");
  assert.equal(git(workspace, ["rev-parse", "HEAD"]).trim(), baseCommit);
  assert.equal(fs.readFileSync(path.join(workspace, "src", "a.txt"), "utf8"), "alpha\n");
  assert.equal(git(workspace, ["branch", "--list", "worker-created-ref"]).trim(), "");
});

test("V2-INTEGRATION: task Git config mutation blocks host verification and cleanup", async (t) => {
  const { root, workspace, baseCommit } = createRepository(t);
  const configuration = createConfiguration(root);
  const adapter = createEditAdapter();
  const originalExecute = adapter.execute.bind(adapter);
  adapter.execute = async (request) => {
    if (request.mode === "edit") {
      git(request.workspace, ["config", "canary.mutated", "true"]);
      fs.writeFileSync(path.join(request.workspace, "src", "a.txt"), "edited in isolated task\n", "utf8");
    }
    return originalExecute(request);
  };
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: adapter }, sleep: async () => {} });
  const prepared = await runtime.prepareParallelBatch({
    objective: "Test task Git config integrity enforcement",
    batchMaxReservedCostUsd: 1,
    tasks: [editTask()]
  }, workspace);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const started = await runtime.startParallelBatch({ planId: prepared.planId, planHash: prepared.planHash }, workspace);
  const failed = await waitForBatch(runtime, workspace, started.batchId, ["failed"]);
  assert.equal(failed.tasks[0].failureClass, "task_git_metadata_changed");
  assert.equal(failed.approvalRequired, false);
  assert.equal(fs.readFileSync(path.join(workspace, "src", "a.txt"), "utf8"), "alpha\n");
  assert.equal(git(workspace, ["rev-parse", "HEAD"]).trim(), baseCommit);
  assert.equal(git(workspace, ["status", "--porcelain=v1"]).trim(), "");
});

test("V2-INTEGRATION: unsafe host verification policy blocks batch admission", async (t) => {
  const { root, workspace } = createRepository(t);
  const configuration = createConfiguration(root, ["git diff --check", "git rev-parse --verify missing-ref-xyz"]);
  const observedRequests = [];
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: createEditAdapter(observedRequests) }, sleep: async () => {} });
  const prepared = await runtime.prepareParallelBatch({ objective: "Edit the file", batchMaxReservedCostUsd: 1, tasks: [editTask(["git diff --check"])] }, workspace);
  assert.equal(prepared.ok, false);
  assert.equal(prepared.reason, "verification_command_policy_unsafe");
  assert.equal(observedRequests.length, 0);
  assert.equal(fs.readFileSync(path.join(workspace, "src", "a.txt"), "utf8"), "alpha\n");
  assert.equal(git(workspace, ["status", "--porcelain=v1"]).trim(), "");
});

test("V2-INTEGRATION: parallel edit is refused when the capability gate is unavailable", async (t) => {
  const { root, workspace } = createRepository(t);
  const configuration = createConfiguration(root);
  configuration.parallelBatch.codexNetworkOffCapability = "unavailable";
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: createEditAdapter() }, sleep: async () => {} });
  const prepared = await runtime.prepareParallelBatch({ objective: "Edit the file", batchMaxReservedCostUsd: 1, tasks: [editTask()] }, workspace);
  assert.equal(prepared.ok, false);
  assert.equal(prepared.reason, "edit_route_unsupported");
});

test("V2-INTEGRATION: edit task cannot select verification commands outside the host allowlist", async (t) => {
  const { root, workspace } = createRepository(t);
  const configuration = createConfiguration(root);
  const observedRequests = [];
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: createEditAdapter(observedRequests) }, sleep: async () => {} });
  const prepared = await runtime.prepareParallelBatch({
    objective: "Edit the file",
    batchMaxReservedCostUsd: 1,
    tasks: [editTask(["git status --porcelain"])]
  }, workspace);
  assert.equal(prepared.ok, false);
  assert.equal(prepared.reason, "verification_command_not_allowed");
  assert.equal(observedRequests.length, 0);
});

test("V2-INTEGRATION: edit admission excludes profile fallbacks the runtime will not execute", async (t) => {
  const { root, workspace } = createRepository(t);
  const configuration = createConfiguration(root);
  configuration.parallelBatch.editEnabled = true;
  configuration.parallelBatch.codexNetworkOffCapability = "available";
  configuration.orchestration.taskProfiles.edit_with_fallback = {
    target: "codex",
    model: "gpt-5.6-luna",
    mode: "edit",
    priority: 10,
    cacheable: false,
    fallbackTargets: [{ target: "codex", model: "gpt-5.6-sol" }]
  };
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: createEditAdapter() }, sleep: async () => {} });
  const prepared = await runtime.prepareParallelBatch({
    objective: "Edit one selected file",
    batchMaxReservedCostUsd: 0.1,
    tasks: [{
      taskId: "edit-profile-fallback",
      role: "implementer",
      mode: "edit",
      profile: "edit_with_fallback",
      objective: "Replace the selected file",
      files: ["src/a.txt"],
      acceptanceCriteria: ["File content is replaced"],
      verificationCommands: ["git diff --check"]
    }]
  }, workspace);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.allocation.estimatedUsd, 0.1);
});
