import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createParallelBatchRegistry } from "../subagent-bridge/src/services/parallel-batch-registry.js";
import { createParallelArtifactStore } from "../subagent-bridge/src/services/parallel-artifact-store.js";
import { createWorkspaceCoordinator } from "../subagent-bridge/src/services/workspace-coordinator.js";
import { createParallelBatchService } from "../subagent-bridge/src/services/parallel-batch.js";

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-batch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "a.txt"), "alpha\n", "utf8");
  fs.writeFileSync(path.join(workspace, "src", "b.txt"), "beta\n", "utf8");
  fs.writeFileSync(path.join(workspace, "src", "c.txt"), "gamma\n", "utf8");
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
    reliability: {
      maxAttempts: 2,
      maxUnknownAttemptCostUsd: 0.1,
      dailyCostLimitUsd: 100,
      monthlyCostLimitUsd: 100,
      costBudgetEnforced: false
    },
    observability: { maxMetricFileBytes: 20971520, maxMetricRetentionDays: 45 },
    orchestration: {
      taskProfiles: {
        quick_read: { target: "codex", model: "gpt-5.6-luna", mode: "read_only", priority: 30, cacheable: false },
        web_research_test: { target: "gemini_pro", mode: "read_only", priority: 20, cacheable: false, webEvidenceRequired: true }
      }
    },
    codex: { timeoutMs: 30000, maxRetries: 0 },
    opencode: { timeoutMs: 30000, maxRetries: 0, allowedModels: ["deepseek/deepseek-v4-pro"] },
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
      allowedTargets: ["codex", "opencode", "antigravity", "claude_code", "native_claude"],
      opencodeOutputCapability: "unavailable",
      opencodeOutputTokens: 2048,
      opencodeSteps: 8,
      codexNetworkOffCapability: "unavailable",
      worktreeRoot: path.join(stateRoot, "worktrees"),
      verificationCommands: [],
      orphanGraceMs: 1000,
      ...(overrides.parallelBatch || {})
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "parallelBatch"))
  };
}

function workerResult(payload, costUsd = 0) {
  return {
    ok: true,
    backend: "codex",
    model: "default",
    result: JSON.stringify(payload),
    error: null,
    retryable: false,
    timedOut: false,
    exitCode: 0,
    durationMs: 5,
    metrics: { retries: 0, totalCostUsd: costUsd }
  };
}

function createFixture(t, options = {}) {
  const { root, workspace } = createWorkspace(t);
  const configuration = createConfiguration(root, options.configurationOverrides || {});
  const registry = createParallelBatchRegistry({ stateDirectory: path.join(configuration.statePaths.state, "parallel-batches") });
  const workspaceCoordinator = createWorkspaceCoordinator({ lockDirectory: path.join(configuration.statePaths.cache, "locks"), staleLockMs: 60000, leaseHeartbeatMs: 1000 });
  const artifactStore = createParallelArtifactStore({
    rootDirectory: path.join(configuration.statePaths.state, "parallel-artifacts"),
    ttlMs: configuration.parallelBatch.artifactTtlMs,
    maxArtifactBytes: configuration.parallelBatch.maxArtifactBytes,
    maxTotalBytes: configuration.parallelBatch.maxArtifactTotalBytes
  });
  const executions = [];
  const runtime = {
    executions,
    async run(request) {
      executions.push(request);
      return options.handler ? options.handler(request, executions.length) : workerResult({ status: "ok", summary: "task completed", action_required: "none" }, 0.01);
    },
    async cancel(executionId) {
      executions.push({ cancelledExecutionId: executionId });
      return true;
    }
  };
  const service = createParallelBatchService({
    configuration,
    registry,
    artifactStore,
    runtime,
    trustedWorkspace: workspace,
    caller: "openCode",
    workspaceCoordinator,
    worktreeManager: options.worktreeManager || null,
    dashboardLauncher: options.dashboardLauncher
  });
  return { root, workspace, configuration, registry, artifactStore, runtime, service, workspaceCoordinator };
}

function baseTask(taskId, readablePaths = ["src/a.txt"]) {
  return {
    taskId,
    role: "analyst",
    mode: "read_only",
    target: "codex",
    objective: `Analyze ${taskId}`,
    readablePaths
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

test("V2-BATCH: prepare validates and returns a bounded plan without starting workers", async (t) => {
  const { service, runtime } = createFixture(t);
  const result = await service.prepare({
    objective: "Inspect files",
    batchMaxReservedCostUsd: 1,
    tasks: [baseTask("task-one"), baseTask("task-two", ["src/b.txt"])]
  });
  assert.equal(result.ok, true);
  assert.match(result.planId, /^[a-f0-9]{32}$/);
  assert.match(result.planHash, /^[a-f0-9]{64}$/);
  assert.equal(result.summary.status, "planned");
  assert.equal(result.summary.progress.percentage, 0);
  assert.equal(result.summary.batchId, null);
  assert.equal(result.summary.tasks.length, 2);
  assert.equal(runtime.executions.length, 0);
  assert.equal(result.summary.budget.isProviderInvoice, false);
});

test("V2-BATCH: start runs the single wave, projects bounded summaries and settles known cost", async (t) => {
  const { service } = createFixture(t);
  const prepared = await service.prepare({
    objective: "Inspect files",
    batchMaxReservedCostUsd: 1,
    tasks: [baseTask("task-one"), baseTask("task-two", ["src/b.txt"])]
  });
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  assert.equal(started.ok, true);
  assert.match(started.batchId, /^[a-f0-9]{32}$/);
  assert.equal(started.summary.budget.reservedUsd, prepared.allocation.estimatedUsd);
  assert.equal(started.summary.budget.remainingUsd, 1 - prepared.allocation.estimatedUsd);
  const summary = await waitForBatch(service, started.batchId, ["result_ready"]);
  assert.equal(summary.completedCount, 2);
  assert.equal(summary.progress.percentage, 100);
  assert.equal(summary.progress.resolvedCount, 2);
  assert.equal(summary.tasks.every((task) => task.status === "completed"), true);
  assert.equal(summary.tasks.every((task) => task.summaryStatus === "full"), true);
  assert.equal(summary.budget.settledKnownUsd, 0.02);
  assert.equal(summary.budget.unknownReservedUsd, 0);
  assert.equal(summary.budget.remainingUsd > 0.7, true);
  assert.equal(summary.budget.reservedUsd, 0.02);
});

test("V2-BATCH: pilot metrics capture snapshot and public summary byte counts", async (t) => {
  const { service, configuration, workspace } = createFixture(t);
  const prepared = await service.prepare({ objective: "Inspect a selected file", batchMaxReservedCostUsd: 1, tasks: [baseTask("task-one")] });
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const summary = await waitForBatch(service, started.batchId, ["result_ready"]);
  const metricsPath = path.join(configuration.statePaths.logs, "metrics", "parallel-batch-runs.jsonl");
  const deadline = Date.now() + 3000;
  let records = [];
  while (Date.now() < deadline) {
    if (fs.existsSync(metricsPath)) {
      records = fs.readFileSync(metricsPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      if (records.some((record) => record.recordType === "parallel_batch_finish")
        && records.some((record) => record.recordType === "parallel_batch_task")) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const batchIdHash = records.find((record) => record.recordType === "parallel_batch_finish")?.batchIdHash;
  const taskRecord = records.find((record) => record.recordType === "parallel_batch_task" && record.batchIdHash === batchIdHash);
  const finishRecord = records.find((record) => record.recordType === "parallel_batch_finish" && record.batchIdHash === batchIdHash);
  assert.equal(taskRecord.snapshotBytes, Buffer.byteLength(fs.readFileSync(path.join(workspace, "src", "a.txt"))));
  assert.equal(Number.isInteger(taskRecord.artifactBytes), true);
  assert.equal(finishRecord.summaryBytes, summary.contentBytes);
  assert.equal(finishRecord.isProviderInvoice, false);
});

test("V2-BATCH: duplicate start consumes the plan exactly once", async (t) => {
  const { service, registry } = createFixture(t);
  const prepared = await service.prepare({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [baseTask("task-one")] });
  const first = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  await waitForBatch(service, first.batchId, ["result_ready"]);
  const second = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  assert.equal(second.ok, true);
  assert.equal(second.alreadyStarted, true);
  assert.equal(second.batchId, first.batchId);
  const batches = await registry.listBatches();
  assert.equal(batches.length, 1);
});

test("V2-BATCH: read-only multi-wave plans are accepted", async (t) => {
  const { service } = createFixture(t);
  const result = await service.prepare({
    objective: "x",
    batchMaxReservedCostUsd: 1,
    tasks: [baseTask("task-one", ["src/a.txt"]), { ...baseTask("task-two", ["src/b.txt"]), dependsOn: ["task-one"] }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.tasks.length, 2);
});

test("V2-BATCH: batch summaries and cancellation are scoped to their trusted workspace", async (t) => {
  const first = createFixture(t);
  const second = createFixture(t, { configurationOverrides: { statePaths: first.configuration.statePaths } });
  const prepared = await first.service.prepare({ objective: "Inspect one file", batchMaxReservedCostUsd: 1, tasks: [baseTask("workspace-scoped-task")] });
  const started = await first.service.start({ planId: prepared.planId, planHash: prepared.planHash });
  await waitForBatch(first.service, started.batchId, ["result_ready"]);

  const foreignSummary = await second.service.getBatch({ batchId: started.batchId });
  const foreignCancel = await second.service.cancel({ batchId: started.batchId });
  const foreignDetail = await second.service.getTaskDetail({ batchId: started.batchId, taskId: "workspace-scoped-task", detailRef: "0".repeat(64) });
  const foreignStart = await second.service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const original = await first.registry.getBatch(started.batchId);
  assert.equal(foreignSummary.ok, false);
  assert.equal(foreignSummary.reason, "batch_not_found");
  assert.equal(foreignCancel.ok, false);
  assert.equal(foreignCancel.reason, "batch_not_found");
  assert.equal(foreignDetail.ok, false);
  assert.equal(foreignDetail.reason, "batch_not_found");
  assert.equal(foreignStart.ok, false);
  assert.equal(foreignStart.reason, "plan_not_found");
  assert.equal(original.status, "result_ready");
});

test("V2-BATCH: shared resource claims serialize tasks across dependency peers", async (t) => {
  let activeClaims = 0;
  let maximumActiveClaims = 0;
  const { service } = createFixture(t, {
    handler: async (request) => {
      activeClaims += 1;
      maximumActiveClaims = Math.max(maximumActiveClaims, activeClaims);
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeClaims -= 1;
      return workerResult({ status: "ok", summary: request.prompt.includes("task-one") ? "one" : "two", action_required: "none" }, 0.01);
    }
  });
  const prepared = await service.prepare({
    objective: "Run two tasks that share one fixture resource.",
    batchMaxReservedCostUsd: 1,
    tasks: [
      { ...baseTask("task-one"), resourceClaims: ["fixture:shared"] },
      { ...baseTask("task-two"), resourceClaims: ["fixture:shared"] }
    ]
  });
  assert.equal(prepared.ok, true);
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const result = await waitForBatch(service, started.batchId, ["result_ready"]);
  assert.deepEqual(result.tasks.map((task) => task.status), ["completed", "completed"]);
  assert.equal(maximumActiveClaims, 1);
});

test("V2-BATCH: terminal edit batches release diffs when integration cannot start", async (t) => {
  const heldDiffs = new Set();
  const releasedBatches = [];
  let preparationCount = 0;
  const fixture = createFixture(t, {
    configurationOverrides: {
      parallelBatch: {
        editEnabled: true,
        codexNetworkOffCapability: "available",
        verificationCommands: ["git diff --check"]
      }
    },
    handler: (request) => workerResult({
      status: request.prompt.includes("second edit surface") ? "failed" : "ok",
      summary: "edit task result",
      action_required: "none"
    }, 0.01),
    worktreeManager: {
      assertCleanSource() {
        return { ok: true, head: "a".repeat(40) };
      },
      captureRefState() {
        return { head: "a".repeat(40), refsHash: "b".repeat(64) };
      },
      assertRefStateUnchanged() {
        return { ok: true };
      },
      createTaskWorktree({ taskId }) {
        return { ok: true, worktreePath: taskId };
      },
      runVerification() {
        return { ok: true, results: [] };
      },
      collectTaskDiff({ worktreePath }) {
        const relativePath = worktreePath === "edit-one" ? "src/a.txt" : "src/b.txt";
        return {
          ok: true,
          diff: `diff ${relativePath}`,
          diffHash: "c".repeat(64),
          filesChanged: [relativePath],
          changes: [{ relativePath, mode: "replace", contentBase64: Buffer.from("edited\n").toString("base64") }]
        };
      },
      cleanupTaskWorktree() {
        return { cleaned: true };
      },
      holdTaskDiff({ batchId, taskId }) {
        heldDiffs.add(`${batchId}:${taskId}`);
      },
      releaseBatchTaskDiffs(batchId) {
        for (const key of heldDiffs) if (key.startsWith(`${batchId}:`)) heldDiffs.delete(key);
        releasedBatches.push(batchId);
      },
      prepareIntegration() {
        preparationCount += 1;
        return { ok: false, reason: "not_expected" };
      },
      applyIntegration() {
        return { ok: false, reason: "not_expected" };
      }
    }
  });
  const tasks = [
    { taskId: "edit-one", role: "implementer", mode: "edit", target: "codex", objective: "first edit surface", files: ["src/a.txt"], acceptanceCriteria: ["change A"], verificationCommands: ["git diff --check"] },
    { taskId: "edit-two", role: "implementer", mode: "edit", target: "codex", objective: "second edit surface", files: ["src/b.txt"], acceptanceCriteria: ["change B"], verificationCommands: ["git diff --check"] }
  ];
  const prepared = await fixture.service.prepare({ objective: "Run two independent edits", batchMaxReservedCostUsd: 1, tasks });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const started = await fixture.service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const summary = await waitForBatch(fixture.service, started.batchId, ["result_ready"]);
  assert.equal(summary.tasks.filter((task) => task.status === "completed").length, 1);
  assert.equal(summary.tasks.filter((task) => task.status === "failed").length, 1);
  assert.equal(heldDiffs.size, 0);
  assert.deepEqual(releasedBatches, [started.batchId]);
  assert.equal(preparationCount, 0);
});

test("V2-BATCH: web researcher profile permits only read-only web access and gets one evidence repair", async (t) => {
  const webEvidence = {
    schemaVersion: 1,
    evidenceSourceType: "untrusted_web",
    sourceUrlHash: "a".repeat(64),
    retrievedAt: new Date().toISOString(),
    excerpts: ["Untrusted web excerpt."],
    confidence: "low",
    verificationStatus: "unverified",
    contentTrust: "untrusted",
    quarantineStatus: "quarantined"
  };
  const { service, runtime } = createFixture(t, {
    handler: () => ({ ...workerResult({ status: "ok", summary: "Research result", action_required: "none" }, 0.01), webEvidence, metrics: { retries: 0, totalCostUsd: 0.01, webReadStatus: "used" } })
  });
  const prepared = await service.prepare({
    objective: "Research official docs and include direct URLs in the summary.",
    batchMaxReservedCostUsd: 1,
    tasks: [{
      taskId: "web-research-task",
      role: "researcher",
      mode: "read_only",
      profile: "web_research_test",
      objective: "Research official docs and include direct URLs in the summary.",
      readablePaths: ["src/a.txt"]
    }]
  });
  assert.equal(prepared.ok, true);
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const summary = await waitForBatch(service, started.batchId, ["result_ready"]);
  const request = runtime.executions.find((entry) => entry.profile === "web_research_test");
  assert.equal(summary.tasks[0].status, "completed");
  const detail = await service.getTaskDetail({ batchId: started.batchId, taskId: "web-research-task", detailRef: summary.tasks[0].detailRef });
  assert.equal(JSON.parse(detail.page.content).webEvidenceStatus, "present_untrusted");
  assert.match(request.prompt, /explicitly permits public, read-only web retrieval/);
  assert.match(request.prompt, /read_url_content tool/);
  assert.match(request.prompt, /authorized by the read_url permission action/);
  assert.match(request.prompt, /Short URL-free excerpt from the fetched page/);
  assert.match(request.prompt, /JSON-encoded string inside the provider outer result field/);
  assert.match(request.prompt, /Required worker-summary JSON shape inside result/);
  assert.match(request.prompt, /Keep the worker summary free of URLs and citation links/);
  assert.doesNotMatch(request.prompt, /Stop conditions: if the task requires changes, external calls/);
  assert.equal(request.maxWebEvidenceRepairAttempts, 1);
  assert.match(request.webEvidenceRepairPrompt, /evidence carrier rules take precedence/);
  assert.match(request.webEvidenceRepairPrompt, /JSON-encoded worker summary/);
  assert.match(request.webEvidenceRepairPrompt, /confidence.*low/);
  assert.match(request.webEvidenceRepairPrompt, /Do not change read-only permissions/);
});

test("V2-BATCH: web-research profile blocks a successful summary without evidence", async (t) => {
  const { service } = createFixture(t, {
    handler: () => {
      const result = workerResult({ status: "ok", summary: "Research result without evidence", action_required: "none" });
      return { ...result, metrics: { ...result.metrics, webReadStatus: "used" } };
    }
  });
  const evidence = {
    schemaVersion: 1,
    evidenceSourceType: "untrusted_web",
    sourceUrlHash: "b".repeat(64),
    retrievedAt: new Date().toISOString(),
    excerpts: ["Untrusted web excerpt."],
    confidence: "low",
    verificationStatus: "unverified",
    contentTrust: "untrusted",
    quarantineStatus: "quarantined"
  };
  const prepared = await service.prepare({
    objective: "Research one official web source.",
    batchMaxReservedCostUsd: 1,
    tasks: [{
      taskId: "missing-web-evidence",
      role: "researcher",
      mode: "read_only",
      profile: "web_research_test",
      objective: "Research one official web source.",
      readablePaths: ["src/a.txt"]
    }]
  });
  assert.equal(prepared.ok, true);
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const summary = await waitForBatch(service, started.batchId, ["result_ready"]);
  const task = summary.tasks[0];
  assert.equal(task.status, "blocked");
  assert.equal(task.failureClass, "web_evidence_missing");
  assert.equal(task.summaryStatus, "not_available");
  const detail = await service.getTaskDetail({ batchId: started.batchId, taskId: task.taskId, detailRef: task.detailRef });
  assert.equal(JSON.parse(detail.page.content).webEvidenceStatus, "missing");
  assert.equal(JSON.parse(detail.page.content).webReadStatus, "used");
});

test("V2-BATCH: web-research profile reports a read_url permission denial separately", async (t) => {
  const { service } = createFixture(t, {
    handler: () => ({
      ok: false,
      backend: "antigravity",
      model: "gemini_pro",
      result: null,
      error: "read_url tool permission denied",
      retryable: false,
      timedOut: false,
      exitCode: 0,
      durationMs: 5,
      reason: "permission_denied",
      metrics: { retries: 0, webReadStatus: "permission_denied" }
    })
  });
  const prepared = await service.prepare({
    objective: "Research one official web source.",
    batchMaxReservedCostUsd: 1,
    tasks: [{
      taskId: "denied-web-read",
      role: "researcher",
      mode: "read_only",
      profile: "web_research_test",
      objective: "Research one official web source.",
      readablePaths: ["src/a.txt"]
    }]
  });
  assert.equal(prepared.ok, true);
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const summary = await waitForBatch(service, started.batchId, ["result_ready"]);
  const task = summary.tasks[0];
  assert.equal(task.status, "blocked");
  assert.equal(task.failureClass, "permission_denied");
  assert.equal(task.summaryStatus, "not_available");
  const detail = await service.getTaskDetail({ batchId: started.batchId, taskId: task.taskId, detailRef: task.detailRef });
  assert.equal(JSON.parse(detail.page.content).webEvidenceStatus, "missing");
  assert.equal(JSON.parse(detail.page.content).webReadStatus, "permission_denied");
});

test("V2-BATCH: web-research profile rejects evidence when read_url was not invoked", async (t) => {
  const evidence = {
    schemaVersion: 1,
    evidenceSourceType: "untrusted_web",
    sourceUrlHash: "c".repeat(64),
    retrievedAt: new Date().toISOString(),
    excerpts: ["Untrusted web excerpt."],
    confidence: "low",
    verificationStatus: "unverified",
    contentTrust: "untrusted",
    quarantineStatus: "quarantined"
  };
  const { service } = createFixture(t, {
    handler: () => ({ ...workerResult({ status: "ok", summary: "Unsupported source result", action_required: "none" }), webEvidence: evidence, metrics: { retries: 0, totalCostUsd: 0.01, webReadStatus: "not_invoked" } })
  });
  const prepared = await service.prepare({
    objective: "Research one official web source.",
    batchMaxReservedCostUsd: 1,
    tasks: [{
      taskId: "unobserved-web-read",
      role: "researcher",
      mode: "read_only",
      profile: "web_research_test",
      objective: "Research one official web source.",
      readablePaths: ["src/a.txt"]
    }]
  });
  assert.equal(prepared.ok, true);
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const summary = await waitForBatch(service, started.batchId, ["result_ready"]);
  const task = summary.tasks[0];
  assert.equal(task.status, "blocked");
  assert.equal(task.failureClass, "web_read_not_invoked");
  const detail = await service.getTaskDetail({ batchId: started.batchId, taskId: task.taskId, detailRef: task.detailRef });
  assert.equal(JSON.parse(detail.page.content).webEvidenceStatus, "present_untrusted");
  assert.equal(JSON.parse(detail.page.content).webReadStatus, "not_invoked");
});

test("V2-BATCH: web-research profile reports when read_url is not available in the CLI tool set", async (t) => {
  const { service } = createFixture(t, {
    handler: () => ({ ...workerResult({ status: "ok", summary: "Unsupported source result", action_required: "none" }), metrics: { retries: 0, totalCostUsd: 0.01, webReadStatus: "unavailable" } })
  });
  const prepared = await service.prepare({
    objective: "Research one official web source.",
    batchMaxReservedCostUsd: 1,
    tasks: [{
      taskId: "unavailable-web-read",
      role: "researcher",
      mode: "read_only",
      profile: "web_research_test",
      objective: "Research one official web source.",
      readablePaths: ["src/a.txt"]
    }]
  });
  assert.equal(prepared.ok, true);
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const summary = await waitForBatch(service, started.batchId, ["result_ready"]);
  const task = summary.tasks[0];
  assert.equal(task.status, "blocked");
  assert.equal(task.failureClass, "web_read_unavailable");
  const detail = await service.getTaskDetail({ batchId: started.batchId, taskId: task.taskId, detailRef: task.detailRef });
  assert.equal(JSON.parse(detail.page.content).webReadStatus, "unavailable");
});

test("V2-BATCH: non-web analyst profile remains blocked from external calls and gets no evidence repair", async (t) => {
  const { service, runtime } = createFixture(t);
  const prepared = await service.prepare({
    objective: "Inspect the provided local file.",
    batchMaxReservedCostUsd: 1,
    tasks: [baseTask("local-analysis-task")]
  });
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  await waitForBatch(service, started.batchId, ["result_ready"]);
  const request = runtime.executions[0];
  assert.match(request.prompt, /Stop conditions: if the task requires changes, external calls/);
  assert.match(request.prompt, /read-only tools or shell\/CLI commands may be used only to read files in the listed snapshot/);
  assert.equal(request.maxWebEvidenceRepairAttempts, undefined);
  assert.equal(request.webEvidenceRepairPrompt, undefined);
});

test("V2-BATCH: task-specific shell stop conditions take precedence over read-only snapshot access", async (t) => {
  const { service, runtime } = createFixture(t);
  const prepared = await service.prepare({
    objective: "Review the selected local file",
    batchMaxReservedCostUsd: 1,
    tasks: [{ ...baseTask("strict-stop-task"), stopConditions: ["If any shell command is required, return blocked."] }]
  });
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  await waitForBatch(service, started.batchId, ["result_ready"]);
  const request = runtime.executions[0];
  assert.match(request.prompt, /Available read-only tools or shell\/CLI commands/);
  assert.match(request.prompt, /Additional stop conditions:[\s\S]*If any shell command is required, return blocked\./);
  assert.match(request.prompt, /Task-specific stop conditions are stricter than these general rules and take precedence/);
  assert.equal(request.prompt.indexOf("Task-specific stop conditions are stricter") > request.prompt.indexOf("Available read-only tools or shell/CLI commands"), true);
});

test("V2-BATCH: duplicate work surfaces are rejected", async (t) => {
  const { service } = createFixture(t);
  const duplicate = { ...baseTask("task-two"), objective: "Analyze task-one" };
  const result = await service.prepare({
    objective: "x",
    batchMaxReservedCostUsd: 1,
    tasks: [baseTask("task-one"), duplicate]
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "duplicate_task_work");
});

test("V2-BATCH: unreadable paths are refused before dispatch", async (t) => {
  const { service, runtime } = createFixture(t);
  const result = await service.prepare({
    objective: "x",
    batchMaxReservedCostUsd: 1,
    tasks: [baseTask("task-one", ["src/missing.txt"])]
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "readable_path_unreadable");
  assert.equal(runtime.executions.length, 0);
});

test("V2-BATCH: read-only paths reject a symlinked ancestor outside the workspace", async (t) => {
  const fixture = createFixture(t);
  const outside = path.join(fixture.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside data\n", "utf8");
  try {
    fs.symlinkSync(outside, path.join(fixture.workspace, "alias"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("directory symlink creation is unavailable");
  }
  const readablePath = await fixture.service.prepare({
    objective: "Read only workspace files",
    batchMaxReservedCostUsd: 1,
    tasks: [baseTask("symlink-readable", ["alias/secret.txt"])]
  });
  assert.equal(readablePath.ok, false);
  assert.equal(readablePath.reason, "readable_path_unreadable");

  const contextPath = await fixture.service.prepare({
    objective: "Read only workspace files",
    batchMaxReservedCostUsd: 1,
    tasks: [{ ...baseTask("symlink-context"), contextFiles: ["alias/secret.txt"] }]
  });
  assert.equal(contextPath.ok, false);
  assert.equal(contextPath.reason, "context_file_unreadable");
  assert.equal(fixture.runtime.executions.length, 0);
});

test("V2-BATCH: read-only snapshot rejects a trusted workspace root that is rebound", async (t) => {
  const fixture = createFixture(t);
  const outside = path.join(fixture.root, "replacement-root");
  fs.mkdirSync(path.join(outside, "src"), { recursive: true });
  fs.writeFileSync(path.join(outside, "src", "a.txt"), "replacement data\n", "utf8");
  const originalWorkspace = `${fixture.workspace}-original`;
  fs.renameSync(fixture.workspace, originalWorkspace);
  try {
    fs.symlinkSync(outside, fixture.workspace, process.platform === "win32" ? "junction" : "dir");
  } catch {
    fs.renameSync(originalWorkspace, fixture.workspace);
    t.skip("directory symlink creation is unavailable");
  }
  const result = await fixture.service.prepare({
    objective: "Read only files from the pinned workspace",
    batchMaxReservedCostUsd: 1,
    tasks: [baseTask("rebound-workspace-root", ["src/a.txt"])]
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "readable_path_unreadable");
  assert.equal(fixture.runtime.executions.length, 0);
});

test("V2-BATCH: invalid worker summary becomes schema_invalid with a detail reference", async (t) => {
  const { service } = createFixture(t, {
    handler: () => workerResult({ status: "ok", summary: "free text without the contract", action_required: "none", extra: true })
  });
  const prepared = await service.prepare({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [baseTask("task-one")] });
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const summary = await waitForBatch(service, started.batchId, ["result_ready", "failed"]);
  const task = summary.tasks[0];
  assert.equal(task.status, "failed");
  assert.equal(task.summaryStatus, "schema_invalid");
  assert.equal(task.actionRequired, "blocked");
  assert.match(task.detailRef, /^[a-f0-9]{64}$/);
  const detail = await service.getTaskDetail({ batchId: started.batchId, taskId: "task-one", detailRef: task.detailRef });
  assert.equal(detail.ok, true);
  assert.match(detail.page.content, /free text without the contract/);
});

test("V2-BATCH: unexpected task rejection leaves an unknown task and retains its allocation", async (t) => {
  const fixture = createFixture(t);
  fixture.artifactStore.store = () => {
    throw new Error("injected artifact store failure");
  };
  const prepared = await fixture.service.prepare({ objective: "Inspect a file", batchMaxReservedCostUsd: 1, tasks: [baseTask("unexpected-task-error")] });
  const started = await fixture.service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const summary = await waitForBatch(fixture.service, started.batchId, ["unknown"]);
  assert.equal(summary.tasks[0].status, "unknown");
  assert.equal(summary.tasks[0].failureClass, "task_execution_unexpected_error");
  const manifest = await fixture.registry.getBatch(started.batchId);
  assert.equal(manifest.tasks["unexpected-task-error"].attempts[0].status, "unknown");
  assert.ok(manifest.budget.unknownReservedUsd > 0);
});

test("V2-BATCH: rejected terminal task mutation is reconciled as unknown", async (t) => {
  let rejectTerminalUpdate = false;
  const fixture = createFixture(t, {
    handler: () => {
      rejectTerminalUpdate = true;
      return workerResult({ status: "ok", summary: "completed response", action_required: "none" }, 0.01);
    }
  });
  const originalUpdateBatch = fixture.registry.updateBatch.bind(fixture.registry);
  fixture.registry.updateBatch = async (batchId, mutator, options) => {
    if (rejectTerminalUpdate) {
      const manifest = await fixture.registry.getBatch(batchId);
      if (manifest?.tasks["terminal-mutation-rejected"]?.status === "running") {
        rejectTerminalUpdate = false;
        return { ok: false, reason: "mutation_rejected" };
      }
    }
    return originalUpdateBatch(batchId, mutator, options);
  };
  const prepared = await fixture.service.prepare({ objective: "Inspect a file", batchMaxReservedCostUsd: 1, tasks: [baseTask("terminal-mutation-rejected")] });
  const started = await fixture.service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const summary = await waitForBatch(fixture.service, started.batchId, ["unknown"]);
  assert.equal(summary.tasks[0].status, "unknown");
  assert.equal(summary.tasks[0].failureClass, "task_execution_unexpected_error");
  const manifest = await fixture.registry.getBatch(started.batchId);
  assert.equal(manifest.tasks["terminal-mutation-rejected"].attempts[0].status, "unknown");
  assert.ok(manifest.budget.unknownReservedUsd > 0);
});

test("V2-BATCH: recovery reconciles a durably committed integration before interrupted batches", async (t) => {
  const batchId = "f".repeat(32);
  const finalized = [];
  const fixture = createFixture(t, {
    worktreeManager: {
      recoverPendingPromotions() {
        return { ok: true, reason: null };
      },
      recoveredCommittedPromotions() {
        return [{ batchId, diffHash: "b".repeat(64) }];
      },
      finalizePromotion(recoveredBatchId) {
        finalized.push(recoveredBatchId);
        return { ok: true };
      }
    }
  });
  await fixture.registry.createBatch({
    schemaVersion: 1,
    batchId,
    planId: "e".repeat(32),
    planHash: "d".repeat(64),
    workspaceHash: fixture.service.workspaceHash,
    status: "integrating",
    createdAt: new Date().toISOString(),
    taskOrder: ["task-one"],
    tasks: {
      "task-one": {
        taskId: "task-one",
        status: "completed",
        summaryText: "edit complete",
        summaryStatus: "full",
        actionRequired: "none",
        filesChanged: ["src/a.txt"],
        verification: [],
        riskLevel: "low_impact",
        detailRef: null,
        failureClass: null,
        durationMs: 1,
        costUsd: 0.01,
        allocationUsd: 0.1,
        budgetSettled: true
      }
    },
    budget: { capUsd: 1, spentKnownUsd: 0.01, unknownReservedUsd: 0, refundedUsd: 0.09, remainingUsd: 0.99, overageUsd: 0 },
    integration: { approvalRef: "c".repeat(64), diffHash: "b".repeat(64), detailRef: "a".repeat(64), filesChanged: ["src/a.txt"] }
  });

  const recovered = await fixture.service.recover();
  const manifest = await fixture.registry.getBatch(batchId);
  assert.deepEqual(recovered.recovered, []);
  assert.equal(manifest.status, "integrated");
  assert.deepEqual(finalized, [batchId]);
  const repeatedRecovery = await fixture.service.recover();
  assert.deepEqual(repeatedRecovery.recovered, []);
  assert.deepEqual(finalized, [batchId, batchId]);
});

test("V2-BATCH: committed promotion recovery refuses a manifest diff mismatch", async (t) => {
  const batchId = "a".repeat(32);
  let finalized = false;
  const fixture = createFixture(t, {
    worktreeManager: {
      recoverPendingPromotions() {
        return { ok: true, reason: null };
      },
      recoveredCommittedPromotions() {
        return [{ batchId, diffHash: "b".repeat(64) }];
      },
      finalizePromotion() {
        finalized = true;
        return { ok: true };
      }
    }
  });
  await fixture.registry.createBatch({
    schemaVersion: 1,
    batchId,
    planId: "c".repeat(32),
    planHash: "d".repeat(64),
    workspaceHash: fixture.service.workspaceHash,
    status: "integrating",
    createdAt: new Date().toISOString(),
    taskOrder: [],
    tasks: {},
    budget: { capUsd: 1, spentKnownUsd: 0, unknownReservedUsd: 0, refundedUsd: 0, remainingUsd: 1, overageUsd: 0 },
    integration: { diffHash: "e".repeat(64), filesChanged: [] }
  });

  const recovery = await fixture.service.recover();
  const manifest = await fixture.registry.getBatch(batchId);
  assert.deepEqual(recovery, { ok: false, recovered: [], reason: "promotion_manifest_diff_mismatch" });
  assert.equal(manifest.status, "integrating");
  assert.equal(finalized, false);
});

test("V2-BATCH: committed promotion reconciliation rechecks the diff under the registry lock", async (t) => {
  const batchId = "9".repeat(32);
  let finalized = false;
  const fixture = createFixture(t, {
    worktreeManager: {
      recoverPendingPromotions() {
        return { ok: true, reason: null };
      },
      recoveredCommittedPromotions() {
        return [{ batchId, diffHash: "b".repeat(64) }];
      },
      finalizePromotion() {
        finalized = true;
        return { ok: true };
      }
    }
  });
  await fixture.registry.createBatch({
    schemaVersion: 1,
    batchId,
    planId: "c".repeat(32),
    planHash: "d".repeat(64),
    workspaceHash: fixture.service.workspaceHash,
    status: "integrating",
    createdAt: new Date().toISOString(),
    taskOrder: [],
    tasks: {},
    budget: { capUsd: 1, spentKnownUsd: 0, unknownReservedUsd: 0, refundedUsd: 0, remainingUsd: 1, overageUsd: 0 },
    integration: { diffHash: "b".repeat(64), filesChanged: [] }
  });
  const originalUpdateBatch = fixture.registry.updateBatch.bind(fixture.registry);
  let mutateBeforeReconciliation = true;
  fixture.registry.updateBatch = async (...args) => {
    if (mutateBeforeReconciliation) {
      mutateBeforeReconciliation = false;
      await originalUpdateBatch(batchId, (candidate) => {
        candidate.integration.diffHash = "e".repeat(64);
        return candidate;
      });
    }
    return originalUpdateBatch(...args);
  };

  const recovery = await fixture.service.recover();
  const manifest = await fixture.registry.getBatch(batchId);
  assert.deepEqual(recovery, { ok: false, recovered: [], reason: "promotion_manifest_reconcile_failed" });
  assert.equal(manifest.status, "integrating");
  assert.equal(manifest.integration.diffHash, "e".repeat(64));
  assert.equal(finalized, false);
});

test("V2-BATCH: already-integrated promotion recovery rechecks binding under the registry lock", async (t) => {
  const batchId = "6".repeat(32);
  let finalized = false;
  const fixture = createFixture(t, {
    worktreeManager: {
      recoverPendingPromotions() {
        return { ok: true, reason: null };
      },
      recoveredCommittedPromotions() {
        return [{ batchId, diffHash: "b".repeat(64) }];
      },
      finalizePromotion() {
        finalized = true;
        return { ok: true };
      }
    }
  });
  await fixture.registry.createBatch({
    schemaVersion: 1,
    batchId,
    planId: "c".repeat(32),
    planHash: "d".repeat(64),
    workspaceHash: fixture.service.workspaceHash,
    status: "integrated",
    createdAt: new Date().toISOString(),
    taskOrder: [],
    tasks: {},
    budget: { capUsd: 1, spentKnownUsd: 0, unknownReservedUsd: 0, refundedUsd: 0, remainingUsd: 1, overageUsd: 0 },
    integration: { diffHash: "b".repeat(64), filesChanged: [] }
  });
  const originalUpdateBatch = fixture.registry.updateBatch.bind(fixture.registry);
  let mutateBeforeFinalization = true;
  fixture.registry.updateBatch = async (...args) => {
    if (mutateBeforeFinalization) {
      mutateBeforeFinalization = false;
      await originalUpdateBatch(batchId, (candidate) => {
        candidate.integration.diffHash = "e".repeat(64);
        return candidate;
      });
    }
    return originalUpdateBatch(...args);
  };

  const recovery = await fixture.service.recover();
  const manifest = await fixture.registry.getBatch(batchId);
  assert.deepEqual(recovery, { ok: false, recovered: [], reason: "promotion_manifest_reconcile_failed" });
  assert.equal(manifest.status, "integrated");
  assert.equal(manifest.integration.diffHash, "e".repeat(64));
  assert.equal(finalized, false);
});

test("V2-BATCH: process byte-limit failures are classified as output_limit", async (t) => {
  const { service } = createFixture(t, {
    handler: () => ({
      ok: false,
      backend: "codex",
      model: "default",
      result: null,
      error: "Process output exceeded limit: 1048576 bytes",
      retryable: false,
      timedOut: false,
      exitCode: null,
      durationMs: 5,
      reason: "process_error",
      metrics: { retries: 0, totalCostUsd: null }
    })
  });
  const prepared = await service.prepare({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [baseTask("task-one")] });
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const summary = await waitForBatch(service, started.batchId, ["failed"]);
  assert.equal(summary.tasks[0].failureClass, "output_limit");
  assert.equal(summary.tasks[0].summaryStatus, "output_limit");
});

test("V2-BATCH: start requires a prepared plan and the exact plan hash", async (t) => {
  const { service, runtime } = createFixture(t);
  const unknown = await service.start({ planId: "a".repeat(32), planHash: "b".repeat(64) });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "plan_not_found");
  const prepared = await service.prepare({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [baseTask("task-one")] });
  const wrongHash = await service.start({ planId: prepared.planId, planHash: "0".repeat(64) });
  assert.equal(wrongHash.ok, false);
  assert.equal(wrongHash.reason, "plan_hash_mismatch");
  assert.equal(runtime.executions.length, 0);
});

test("V2-BATCH: oversized summaries are truncated with an opaque detail reference", async (t) => {
  const { service } = createFixture(t, {
    configurationOverrides: { parallelBatch: { maxSummaryCharacters: 32 } },
    handler: () => workerResult({ status: "ok", summary: "S".repeat(200), action_required: "none" })
  });
  const prepared = await service.prepare({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [baseTask("task-one")] });
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const summary = await waitForBatch(service, started.batchId, ["result_ready"]);
  const task = summary.tasks[0];
  assert.equal(task.summary, null);
  assert.equal(task.summaryStatus, "summary_truncated");
  assert.match(task.detailRef, /^[a-f0-9]{64}$/);
});

test("V2-BATCH: public summary byte cap applies after all summary fields are serialized", async (t) => {
  const { service, registry } = createFixture(t, {
    configurationOverrides: { parallelBatch: { maxBatchSummaryBytes: 4096 } }
  });
  const prepared = await service.prepare({ objective: "Inspect selected files", batchMaxReservedCostUsd: 1, tasks: [baseTask("task-one")] });
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  await waitForBatch(service, started.batchId, ["result_ready"]);
  await registry.updateBatch(started.batchId, (manifest) => {
    manifest.tasks["task-one"].filesChanged = Array.from({ length: 200 }, (_, index) => `${String(index).padStart(3, "0")}/${"p".repeat(480)}.js`);
    return manifest;
  });
  const result = await service.getBatch({ batchId: started.batchId });
  assert.equal(result.ok, true);
  assert.equal(result.summary.contentBytes <= 4096, true);
  assert.equal(result.summary.contentBytes, Buffer.byteLength(JSON.stringify(result.summary), "utf8"));
  assert.equal(result.summary.tasks[0].filesChanged.length, 0);
  assert.match(result.summary.message, /details and approval are withheld/);
});

test("V2-BATCH: registry owner loss after temporary manifest write prevents publication", async (t) => {
  const { service, registry } = createFixture(t);
  const prepared = await service.prepare({ objective: "Fence manifest publication", batchMaxReservedCostUsd: 1, tasks: [baseTask("registry-fence")] });
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  await waitForBatch(service, started.batchId, ["result_ready"]);
  let ownerChecks = 0;
  const update = await registry.updateBatch(started.batchId, (manifest) => {
    manifest.fenceProbe = "unapproved";
    return manifest;
  }, {
    assertOwner() {
      ownerChecks += 1;
      return ownerChecks < 3;
    }
  });
  assert.deepEqual(update, { ok: false, reason: "owner_lost" });
  const persisted = await registry.getBatch(started.batchId);
  assert.equal(persisted.fenceProbe, undefined);
  assert.equal(ownerChecks, 3);
});

test("V2-BATCH: minimum-cap summary stays bounded with five maximum-length task identifiers", async (t) => {
  const { service, registry } = createFixture(t, {
    configurationOverrides: { parallelBatch: { maxBatchSummaryBytes: 4096 } }
  });
  const tasks = Array.from({ length: 5 }, (_, index) => baseTask(`task-${index}-${"a".repeat(55)}`));
  const prepared = await service.prepare({ objective: "Inspect bounded paths", batchMaxReservedCostUsd: 1, tasks });
  assert.equal(prepared.ok, true);
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  await waitForBatch(service, started.batchId, ["result_ready"]);
  await registry.updateBatch(started.batchId, (manifest) => {
    for (const taskId of manifest.taskOrder) {
      manifest.tasks[taskId].filesChanged = Array.from({ length: 200 }, (_, index) => `${String(index).padStart(3, "0")}/${"p".repeat(480)}.js`);
      manifest.tasks[taskId].verification = Array.from({ length: 20 }, () => ({ commandHash: "a".repeat(64), exitCode: 0, outputBytes: 0 }));
    }
    return manifest;
  });
  const result = await service.getBatch({ batchId: started.batchId });
  assert.equal(result.ok, true);
  assert.equal(result.summary.contentBytes <= 4096, true);
  assert.equal(result.summary.contentBytes, Buffer.byteLength(JSON.stringify(result.summary), "utf8"));
  assert.equal(result.summary.tasks.length, 5);
  assert.equal(result.summary.tasks.every((task) => task.filesChanged.length === 0 && task.verification.length === 0), true);
});

test("V2-BATCH: oversized integration summary withholds approval", async (t) => {
  let applyCalled = false;
  const { service, registry } = createFixture(t, {
    configurationOverrides: { parallelBatch: { editEnabled: true, maxBatchSummaryBytes: 4096 } },
    worktreeManager: {
      async applyIntegration() {
        applyCalled = true;
        return { ok: true, integration: {} };
      }
    }
  });
  const batchId = "e".repeat(32);
  await registry.createBatch({
    schemaVersion: 1,
    batchId,
    planId: "f".repeat(32),
    planHash: "a".repeat(64),
    workspaceHash: service.workspaceHash,
    status: "ready_for_approval",
    createdAt: new Date().toISOString(),
    taskOrder: ["task-one"],
    tasks: {
      "task-one": {
        taskId: "task-one",
        status: "completed",
        summaryText: "edit complete",
        summaryStatus: "full",
        actionRequired: "none",
        filesChanged: Array.from({ length: 200 }, (_, index) => `${String(index).padStart(3, "0")}/${"p".repeat(480)}.js`),
        verification: [],
        riskLevel: "low_impact",
        detailRef: "b".repeat(64),
        failureClass: null,
        durationMs: 1,
        costUsd: 0.01,
        allocationUsd: 0.1
      }
    },
    budget: { capUsd: 1, spentKnownUsd: 0.01, unknownReservedUsd: 0, refundedUsd: 0.09, remainingUsd: 0.99, overageUsd: 0 },
    integration: { approvalRef: "c".repeat(64), diffHash: "d".repeat(64), detailRef: "e".repeat(64), filesChanged: Array.from({ length: 200 }, (_, index) => `${String(index).padStart(3, "0")}/${"p".repeat(480)}.js`) }
  });
  const batch = await service.getBatch({ batchId });
  assert.equal(batch.ok, true);
  assert.equal(batch.summary.contentBytes <= 4096, true);
  assert.equal(batch.summary.status, "blocked");
  assert.equal(batch.summary.approvalRequired, false);
  const approval = await service.approveIntegration({ batchId, approvalRef: "c".repeat(64), expectedDiffHash: "d".repeat(64) });
  assert.equal(approval.ok, false);
  assert.equal(approval.reason, "integration_summary_unavailable");
  assert.equal(applyCalled, false);
});

test("V2-BATCH: failed source rollback blocks further integration approval", async (t) => {
  const { service, registry } = createFixture(t, {
    configurationOverrides: { parallelBatch: { editEnabled: true } },
    worktreeManager: {
      async applyIntegration() {
        return { ok: false, reason: "promotion_rollback_failed", message: "manual recovery required" };
      }
    }
  });
  const batchId = "e".repeat(32);
  await registry.createBatch({
    schemaVersion: 1,
    batchId,
    planId: "f".repeat(32),
    planHash: "a".repeat(64),
    workspaceHash: service.workspaceHash,
    status: "ready_for_approval",
    createdAt: new Date().toISOString(),
    taskOrder: ["task-one"],
    tasks: {
      "task-one": {
        taskId: "task-one",
        status: "completed",
        summaryText: "edit complete",
        summaryStatus: "full",
        actionRequired: "none",
        filesChanged: ["src/a.txt"],
        verification: [],
        riskLevel: "low_impact",
        detailRef: "b".repeat(64),
        failureClass: null,
        durationMs: 1,
        costUsd: 0.01,
        allocationUsd: 0.1
      }
    },
    budget: { capUsd: 1, spentKnownUsd: 0.01, unknownReservedUsd: 0, refundedUsd: 0.09, remainingUsd: 0.99, overageUsd: 0 },
    integration: { approvalRef: "c".repeat(64), diffHash: "d".repeat(64), detailRef: "e".repeat(64), filesChanged: ["src/a.txt"] }
  });
  const result = await service.approveIntegration({ batchId, approvalRef: "c".repeat(64), expectedDiffHash: "d".repeat(64) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "promotion_rollback_failed");
  const summary = await service.getBatch({ batchId });
  assert.equal(summary.summary.status, "blocked");
});

test("V2-BATCH: stale cancellation cannot override an integration claim", async (t) => {
  const batchId = "9".repeat(32);
  const fixture = createFixture(t, {
    configurationOverrides: { parallelBatch: { editEnabled: true } },
    worktreeManager: {
      hasPendingPromotions() {
        return false;
      },
      recoverPendingPromotions() {
        return { ok: true, reason: null };
      },
      recoveredCommittedPromotions() {
        return [];
      },
      applyIntegration({ manifest }) {
        return { ok: true, integration: { ...manifest.integration, appliedAt: new Date().toISOString() } };
      },
      finalizePromotion() {
        return { ok: true };
      }
    }
  });
  await fixture.registry.createBatch({
    schemaVersion: 1,
    batchId,
    planId: "e".repeat(32),
    planHash: "d".repeat(64),
    workspaceHash: fixture.service.workspaceHash,
    status: "ready_for_approval",
    createdAt: new Date().toISOString(),
    cancelRequestedAt: null,
    taskOrder: ["task-one"],
    tasks: {
      "task-one": {
        taskId: "task-one",
        status: "completed",
        summaryText: "edit complete",
        summaryStatus: "full",
        actionRequired: "none",
        filesChanged: ["src/a.txt"],
        verification: [],
        riskLevel: "low_impact",
        detailRef: null,
        failureClass: null,
        durationMs: 1,
        costUsd: 0.01,
        allocationUsd: 0.1,
        budgetSettled: true
      }
    },
    budget: { capUsd: 1, spentKnownUsd: 0.01, unknownReservedUsd: 0, refundedUsd: 0.09, remainingUsd: 0.99, overageUsd: 0 },
    integration: { approvalRef: "c".repeat(64), diffHash: "b".repeat(64), detailRef: "a".repeat(64), filesChanged: ["src/a.txt"] }
  });

  const readerId = "stale-cancel-approval-reader";
  assert.ok(await fixture.workspaceCoordinator.acquire(fixture.workspace, "read_only", readerId));
  const approvalPromise = fixture.service.approveIntegration({
    batchId,
    approvalRef: "c".repeat(64),
    expectedDiffHash: "b".repeat(64)
  });
  let releaseCancellation;
  let cancellationReached;
  const cancellationGate = new Promise((resolve) => { releaseCancellation = resolve; });
  const cancellationStarted = new Promise((resolve) => { cancellationReached = resolve; });
  const originalUpdateBatch = fixture.registry.updateBatch.bind(fixture.registry);
  let pauseFirstUpdate = true;
  fixture.registry.updateBatch = async (...args) => {
    if (pauseFirstUpdate) {
      pauseFirstUpdate = false;
      cancellationReached();
      await cancellationGate;
    }
    return originalUpdateBatch(...args);
  };
  const cancellationPromise = fixture.service.cancel({ batchId });
  await cancellationStarted;
  fixture.workspaceCoordinator.release(readerId);
  const approval = await approvalPromise;
  assert.equal(approval.ok, true);
  assert.equal(approval.summary.status, "integrated");
  releaseCancellation();
  const cancellation = await cancellationPromise;
  assert.equal(cancellation.ok, true);
  assert.equal(cancellation.cancellation.requested, false);
  assert.equal(cancellation.cancellation.reason, "already_terminal");
  const finalManifest = await fixture.registry.getBatch(batchId);
  assert.equal(finalManifest.status, "integrated");
  assert.equal(finalManifest.cancelRequestedAt, null);
});

test("V2-BATCH: read-only workers run in a bounded snapshot workspace", async (t) => {
  let observedWorkspace = null;
  let observedFiles = null;
  const { service, workspace } = createFixture(t, {
    handler: (request) => {
      observedWorkspace = request.trustedWorkspace;
      observedFiles = {
        a: fs.existsSync(path.join(request.trustedWorkspace, "src", "a.txt")),
        b: fs.existsSync(path.join(request.trustedWorkspace, "src", "b.txt"))
      };
      return workerResult({ status: "ok", summary: "task completed", action_required: "none" }, 0.01);
    }
  });
  const prepared = await service.prepare({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [baseTask("task-one", ["src/a.txt"])] });
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  await waitForBatch(service, started.batchId, ["result_ready"]);
  assert.notEqual(observedWorkspace, workspace);
  assert.equal(observedFiles.a, true);
  assert.equal(observedFiles.b, false);
  assert.equal(fs.existsSync(observedWorkspace), false);
});

test("V2-BATCH: per-task input byte limit cannot exceed snapshot policy", async (t) => {
  const { service } = createFixture(t);
  const prepared = await service.prepare({
    objective: "Read one small fixture",
    batchMaxReservedCostUsd: 1,
    tasks: [{ ...baseTask("bounded-input"), maxInputBytes: 1 }]
  });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.reason, "readable_snapshot_too_large");
});

test("V2-BATCH: task token limits fail closed when the resolved route lacks a proven cap", async (t) => {
  const inputFixture = createFixture(t);
  const inputTokenLimit = await inputFixture.service.prepare({
    objective: "Inspect selected files",
    batchMaxReservedCostUsd: 1,
    tasks: [{ ...baseTask("input-token-cap"), maxInputTokens: 1000 }]
  });
  assert.equal(inputTokenLimit.ok, false);
  assert.equal(inputTokenLimit.reason, "input_token_limit_unsupported");

  const outputFixture = createFixture(t);
  const outputTokenLimit = await outputFixture.service.prepare({
    objective: "Inspect selected files",
    batchMaxReservedCostUsd: 1,
    tasks: [{ ...baseTask("output-token-cap"), maxOutputTokens: 1000 }]
  });
  assert.equal(outputTokenLimit.ok, false);
  assert.equal(outputTokenLimit.reason, "output_token_limit_unsupported");
});

test("V2-BATCH: proven OpenCode route receives its task output token cap", async (t) => {
  const { service, runtime } = createFixture(t, {
    configurationOverrides: {
      parallelBatch: { opencodeOutputCapability: "available", opencodeOutputTokens: 1024 }
    }
  });
  const prepared = await service.prepare({
    objective: "Inspect a file with a bounded model response",
    batchMaxReservedCostUsd: 1,
    tasks: [{
      ...baseTask("open-code-output-cap"),
      target: "opencode",
      model: "deepseek/deepseek-v4-pro",
      maxOutputTokens: 512
    }]
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  await waitForBatch(service, started.batchId, ["result_ready"]);
  assert.equal(runtime.executions[0].maxOutputTokens, 512);
});

test("V2-BATCH: per-task output bytes stay under host ceiling and reach runtime", async (t) => {
  const { service, runtime } = createFixture(t, {
    configurationOverrides: { parallelBatch: { maxOutputBytesPerTask: 4096 } }
  });
  const aboveHostLimit = await service.prepare({
    objective: "Inspect selected files",
    batchMaxReservedCostUsd: 1,
    tasks: [{ ...baseTask("oversized-output-limit"), maxOutputBytes: 8192 }]
  });
  assert.equal(aboveHostLimit.ok, false);
  assert.equal(aboveHostLimit.reason, "task_output_byte_limit_exceeds_host_cap");

  const prepared = await service.prepare({
    objective: "Inspect selected files",
    batchMaxReservedCostUsd: 1,
    tasks: [{ ...baseTask("bounded-output"), maxOutputBytes: 2048 }]
  });
  assert.equal(prepared.ok, true);
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  await waitForBatch(service, started.batchId, ["result_ready"]);
  assert.equal(runtime.executions[0].maxOutputBytes, 2048);
});

test("V2-BATCH: read-only dependency waves run in order and pass summaries forward", async (t) => {
  const prompts = [];
  const { service } = createFixture(t, {
    handler: (request) => {
      prompts.push(request.prompt);
      return workerResult({ status: "ok", summary: prompts.length === 1 ? "first-wave-result" : "second-wave-result", action_required: "none" }, 0.01);
    }
  });
  const prepared = await service.prepare({
    objective: "x",
    batchMaxReservedCostUsd: 1,
    tasks: [baseTask("task-one", ["src/a.txt"]), { ...baseTask("task-two", ["src/b.txt"]), dependsOn: ["task-one"] }]
  });
  assert.equal(prepared.ok, true);
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const summary = await waitForBatch(service, started.batchId, ["result_ready", "failed"]);
  assert.equal(summary.completedCount, 2);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Dependency results from earlier waves:/);
  assert.match(prompts[1], /task-one: first-wave-result/);
});

test("V2-BATCH: a failed dependency blocks its dependent task", async (t) => {
  const { service } = createFixture(t, {
    handler: (request) => {
      if (request.prompt.includes("Analyze task-one")) {
        return { ok: false, backend: "codex", model: "default", result: null, error: "boom", retryable: false, timedOut: false, exitCode: 1, durationMs: 1, reason: "execution_failed", metrics: { retries: 0, totalCostUsd: 0 } };
      }
      return workerResult({ status: "ok", summary: "second", action_required: "none" }, 0);
    }
  });
  const prepared = await service.prepare({
    objective: "x",
    batchMaxReservedCostUsd: 1,
    tasks: [baseTask("task-one", ["src/a.txt"]), { ...baseTask("task-two", ["src/b.txt"]), dependsOn: ["task-one"] }]
  });
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  const summary = await waitForBatch(service, started.batchId, ["failed", "result_ready"]);
  const dependent = summary.tasks.find((task) => task.taskId === "task-two");
  assert.equal(dependent.status, "blocked");
  assert.equal(dependent.failureClass, "dependency_not_completed");
});

test("V2-BATCH: dependency cycles are rejected", async (t) => {
  const { service } = createFixture(t);
  const result = await service.prepare({
    objective: "x",
    batchMaxReservedCostUsd: 1,
    tasks: [
      { ...baseTask("task-one", ["src/a.txt"]), dependsOn: ["task-two"] },
      { ...baseTask("task-two", ["src/b.txt"]), dependsOn: ["task-one"] }
    ]
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "dependency_cycle");
});

test("V2-BATCH: unknown dependencies are rejected", async (t) => {
  const { service } = createFixture(t);
  const result = await service.prepare({
    objective: "x",
    batchMaxReservedCostUsd: 1,
    tasks: [{ ...baseTask("task-two", ["src/b.txt"]), dependsOn: ["task-missing"] }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "dependency_unknown");
});

test("V2-BATCH: opencode route is fail-closed until output capability is proven", async (t) => {
  const opencodeTask = { taskId: "task-one", role: "analyst", mode: "read_only", target: "opencode", model: "deepseek/deepseek-v4-pro", objective: "Analyze", readablePaths: ["src/a.txt"] };
  const { service } = createFixture(t);
  const rejected = await service.prepare({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [opencodeTask] });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "route_output_capability_unavailable");
  const { service: proven } = createFixture(t, { configurationOverrides: { parallelBatch: { opencodeOutputCapability: "available" } } });
  const accepted = await proven.prepare({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [opencodeTask] });
  assert.equal(accepted.ok, true);
});

test("V2-BATCH: opt-in terminal watcher launches once after batch acceptance", async (t) => {
  const openedBatchIds = [];
  const { service } = createFixture(t, {
    configurationOverrides: { parallelBatch: { autoOpenTerminalDashboard: true } },
    dashboardLauncher: {
      async open(batchId) {
        openedBatchIds.push(batchId);
        return { opened: true, mode: "windows_terminal_window" };
      }
    }
  });
  const prepared = await service.prepare({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [baseTask("task-one")] });
  const started = await service.start({ planId: prepared.planId, planHash: prepared.planHash });
  assert.equal(started.dashboard.opened, true);
  assert.equal(started.dashboard.mode, "windows_terminal_window");
  assert.deepEqual(openedBatchIds, [started.batchId]);
  await waitForBatch(service, started.batchId, ["result_ready"]);
});

test("V2-BATCH: parallel batch is fail-closed when disabled", async (t) => {
  const { service } = createFixture(t, { configurationOverrides: { parallelBatch: { enabled: false } } });
  const result = await service.prepare({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [baseTask("task-one")] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "parallel_batch_disabled");
});
