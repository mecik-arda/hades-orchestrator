import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createReadOnlyResultCache } from "../subagent-bridge/src/services/read-only-cache.js";
import { createProviderCircuitBreaker } from "../subagent-bridge/src/services/provider-circuit-breaker.js";
import { resolveReliabilityBudget } from "../subagent-bridge/src/services/reliability-budget.js";
import { createWorkspaceCoordinator, withGuard } from "../subagent-bridge/src/services/workspace-coordinator.js";
import { resolveRuntimeRoute } from "../subagent-bridge/src/runtime/router.js";
import { createMcpToolHandlers } from "../subagent-bridge/src/frontends/mcp/tools.js";
import { readMetricsDirectory, summarizeMetrics } from "../scripts/report-metrics.js";
import { appendRedactedRunMetric, getCostBudgetSnapshot, listPendingDirectEditFeedback, listPendingRoutingFeedback, pruneMetricFiles, recordDirectEditFeedback, recordRoutingFeedback, reserveCostBudget, settleCostBudget, withMetricLock } from "../subagent-bridge/src/metrics.js";

test("OPT-01: processler arası coordinator paralel okumayı korur ve yazmayı sıraya alır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-coordinator-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = createWorkspaceCoordinator({ lockDirectory: path.join(root, "locks") });
  const second = createWorkspaceCoordinator({ lockDirectory: path.join(root, "locks") });
  const readOne = await first.acquire(root, "read_only", "read-one");
  const readTwo = await second.acquire(root, "read_only", "read-two");
  let editResolved = false;
  const edit = second.acquire(root, "edit", "edit-one").then((value) => {
    editResolved = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(readOne);
  assert.ok(readTwo);
  assert.equal(editResolved, false);
  first.release("read-one");
  second.release("read-two");
  assert.ok(await edit);
  second.release("edit-one");
  assert.ok(await first.acquire(root, "edit", "external-holder"));
  const externalWaiter = second.acquire(root, "read_only", "external-waiter");
  first.release("external-holder");
  const externalGrant = await Promise.race([
    externalWaiter,
    new Promise((_, reject) => setTimeout(() => reject(new Error("external release was not observed")), 1000))
  ]);
  assert.ok(externalGrant);
  second.release("external-waiter");
  assert.ok(await first.acquire(root, "read_only", "reader-before-writer"));
  const originalNow = Date.now;
  const enqueueTime = originalNow();
  let waitingWriter;
  let laterReader;
  try {
    Date.now = () => enqueueTime;
    waitingWriter = second.acquire(root, "edit", "waiting-writer", 10);
    laterReader = second.acquire(root, "read_only", "later-reader", 30);
  } finally {
    Date.now = originalNow;
  }
  first.release("reader-before-writer");
  assert.ok(await waitingWriter);
  let laterReaderResolved = false;
  laterReader.then(() => { laterReaderResolved = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(laterReaderResolved, false);
  second.release("waiting-writer");
  assert.ok(await laterReader);
  second.release("later-reader");
  const workspaceHash = crypto.createHash("sha256").update(root).digest("hex");
  const guardPath = path.join(root, "locks", workspaceHash, "guard.lock");
  fs.writeFileSync(guardPath, "stale", "utf8");
  const staleAt = new Date(Date.now() - 1000);
  fs.utimesSync(guardPath, staleAt, staleAt);
  const staleCoordinator = createWorkspaceCoordinator({ lockDirectory: path.join(root, "locks"), staleLockMs: 10 });
  assert.ok(await staleCoordinator.acquire(root, "read_only", "stale-guard-reader"));
  staleCoordinator.release("stale-guard-reader");
});

test("OPT-01a: eski guard sahibi yeni guard dosyasını silemez", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-guard-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const guardPath = path.join(root, "guard.lock");
  assert.equal(withGuard(root, 1000, () => {
    fs.writeFileSync(guardPath, "replacement", "utf8");
    return true;
  }), true);
  assert.equal(fs.readFileSync(guardPath, "utf8"), "replacement");
});

test("OPT-01aa: etkin lease staleLockMs aşılırken silinmez", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-lease-heartbeat-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { lockDirectory: path.join(root, "locks"), staleLockMs: 1000, leaseHeartbeatMs: 20 };
  const first = createWorkspaceCoordinator(options);
  const second = createWorkspaceCoordinator(options);
  assert.ok(await first.acquire(root, "edit", "lease-holder"));
  const workspaceHash = crypto.createHash("sha256").update(root).digest("hex");
  const writeLockPath = path.join(root, "locks", workspaceHash, "write.lock");
  const staleAt = new Date(Date.now() - 2000);
  fs.utimesSync(writeLockPath, staleAt, staleAt);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(Date.now() - fs.statSync(writeLockPath).mtimeMs < options.staleLockMs);
  let secondAcquired = false;
  const waiting = second.acquire(root, "edit", "lease-waiter").then((grant) => {
    secondAcquired = Boolean(grant);
    return grant;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(secondAcquired, false);
  first.release("lease-holder");
  assert.ok(await waiting);
  second.release("lease-waiter");
});

test("OPT-01aaa: coordinator sınırlı bekleme sonrası isteği fail-closed reddeder", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-coordinator-wait-limit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDirectory = path.join(root, "locks");
  const holder = createWorkspaceCoordinator({ lockDirectory });
  const waiter = createWorkspaceCoordinator({ lockDirectory, maxWaitAttempts: 0 });
  assert.ok(await holder.acquire(root, "edit", "wait-limit-holder"));
  assert.equal(await waiter.acquire(root, "read_only", "wait-limit-reader"), null);
  assert.equal(waiter.snapshot().localQueued, 0);
  holder.release("wait-limit-holder");
});

test("OPT-01ab: metric lock canlı sahibi silmez ve ölü sahibi temizler", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-metric-lock-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "metric.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ token: crypto.randomUUID(), pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
  await assert.rejects(() => withMetricLock(lockPath, async () => {}, { timeoutMs: 80 }), /metric lock unavailable/);
  assert.equal(fs.existsSync(lockPath), true);
  const exitedProcess = childProcess.spawn(process.execPath, ["--eval", "process.exit(0)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => {
    exitedProcess.once("error", reject);
    exitedProcess.once("exit", resolve);
  });
  const deadOwner = { token: crypto.randomUUID(), pid: exitedProcess.pid, createdAt: new Date().toISOString() };
  fs.writeFileSync(lockPath, JSON.stringify(deadOwner), "utf8");
  assert.equal(await withMetricLock(lockPath, async () => "acquired", { timeoutMs: 3000 }), "acquired");
  assert.equal(fs.existsSync(lockPath), false);
});

test("OPT-01b: bağımsız Node processleri aynı workspace yazma kilidini paylaşır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-coordinator-process-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(path.resolve("subagent-bridge/src/services/workspace-coordinator.js")).href;
  const launch = (executionId, holdMs) => {
    const source = `import { createWorkspaceCoordinator } from ${JSON.stringify(moduleUrl)}; const coordinator = createWorkspaceCoordinator({ lockDirectory: ${JSON.stringify(path.join(root, "locks"))} }); const grant = await coordinator.acquire(${JSON.stringify(root)}, "edit", ${JSON.stringify(executionId)}); if (!grant) process.exit(1); process.stdout.write("acquired\\n"); setTimeout(() => { coordinator.release(${JSON.stringify(executionId)}); }, ${holdMs});`;
    return childProcess.spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "ignore"] });
  };
  const waitForAcquire = (child) => new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("coordinator process did not acquire the lock"));
    }, 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("acquired")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!output.includes("acquired")) {
        clearTimeout(timeout);
        reject(new Error(`coordinator process exited with ${code}`));
      }
    });
  });
  const waitForExit = (child) => new Promise((resolve, reject) => child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`coordinator process exited with ${code}`))));
  const first = launch("first-writer", 200);
  const firstExit = waitForExit(first);
  await waitForAcquire(first);
  const startedAt = Date.now();
  const second = launch("second-writer", 0);
  const secondExit = waitForExit(second);
  await waitForAcquire(second);
  assert.ok(Date.now() - startedAt >= 150);
  await Promise.all([firstExit, secondExit]);
});

test("OPT-01c: coordinator snapshot owner ve workspace kimliği göstermeden kuyruk durumunu raporlar", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-coordinator-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coordinator = createWorkspaceCoordinator({ lockDirectory: path.join(root, "locks") });
  assert.ok(await coordinator.acquire(root, "edit", "private-owner"));
  const waiting = coordinator.acquire(root, "read_only", "private-waiter");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.localActive, 1);
  assert.equal(snapshot.localQueued, 1);
  assert.equal(snapshot.lockCount, 1);
  assert.deepEqual(snapshot.externalDiskLocks, ["lock-1"]);
  assert.equal(JSON.stringify(snapshot).includes("private-owner"), false);
  assert.equal(JSON.stringify(snapshot).includes(root), false);
  coordinator.release("private-owner");
  assert.ok(await waiting);
  coordinator.release("private-waiter");
});

test("OPT-02: read-only cache yalnız Git revision anahtarıyla sonuç döndürür", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  childProcess.execFileSync("git", ["init", root], { stdio: "ignore" });
  childProcess.execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  childProcess.execFileSync("git", ["-C", root, "config", "user.name", "Bridge Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "cache", "utf8");
  childProcess.execFileSync("git", ["-C", root, "add", "README.md"]);
  childProcess.execFileSync("git", ["-C", root, "commit", "-m", "initial"], { stdio: "ignore" });
  const cache = createReadOnlyResultCache();
  const key = await cache.keyFor({ workspace: root, backend: "codex", model: "default", profile: "review", prompt: "inspect" });
  cache.set(key, { ok: true, result: "cached", metrics: { retries: 0 } });
  assert.equal(cache.get(key).result, "cached");
  assert.equal(await cache.keyFor({ workspace: root, backend: "codex", model: "default", profile: "review", prompt: "different" }) === key, false);
  fs.writeFileSync(path.join(root, "dirty.txt"), "dirty", "utf8");
  assert.equal(await cache.keyFor({ workspace: root, backend: "codex", model: "default", profile: "review", prompt: "inspect" }), null);
});

test("OPT-02a: read-only cache en eski girişi LRU sınırında çıkarır", () => {
  const cache = createReadOnlyResultCache({ maxEntries: 2 });
  cache.set("first", { ok: true, result: "first" });
  cache.set("second", { ok: true, result: "second" });
  assert.equal(cache.get("first").result, "first");
  cache.set("third", { ok: true, result: "third" });
  assert.equal(cache.get("second"), null);
  assert.equal(cache.get("first").result, "first");
  assert.equal(cache.get("third").result, "third");
});

test("OPT-03: profile canonical target ve modla route edilir", () => {
  const configuration = { orchestration: { taskProfiles: { review: { target: "codex", mode: "read_only" } } } };
  assert.deepEqual(resolveRuntimeRoute({ target: "profile", profile: "review" }, configuration), { backend: "codex", model: "default" });
  assert.throws(() => resolveRuntimeRoute({ target: "profile", profile: "unknown" }, configuration), /unsupported task profile/);
});

test("OPT-03a: MCP profile modu policy tanımından alır", async () => {
  let request = null;
  const handlers = createMcpToolHandlers({
    runtime: { run: async (value) => {
      request = value;
      return { ok: true, backend: "codex", model: "default", result: "ok", error: null, retryable: false, timedOut: false, exitCode: 0, durationMs: 0, metrics: { retries: 0 } };
    } },
    trustedWorkspace: "C:\\trusted",
    configuration: { orchestration: { taskProfiles: { custom_review: { target: "codex", mode: "read_only" } } } }
  });
  await handlers.runProfile({ profile: "custom_review", prompt: "inspect" });
  assert.equal(request.mode, "read_only");
  assert.equal(request.profile, "custom_review");
});

test("OPT-03b: provider circuit open ve half-open tek probe sözleşmesini uygular", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-provider-circuit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const circuit = createProviderCircuitBreaker({ stateDirectory: root, failureThreshold: 1, windowMs: 1000, openMs: 100 });
  assert.deepEqual(await circuit.beforeCall("codex", 1000), { allowed: true, state: "closed", probe: false });
  await circuit.recordFailure("codex", 1000);
  assert.deepEqual(await circuit.beforeCall("codex", 1050), { allowed: false, state: "open" });
  assert.deepEqual(await circuit.beforeCall("codex", 1101), { allowed: true, state: "half_open", probe: true });
  assert.deepEqual(await circuit.beforeCall("codex", 1102), { allowed: false, state: "half_open" });
  await circuit.recordSuccess("codex", 1103);
  assert.deepEqual(await circuit.beforeCall("codex", 1104), { allowed: true, state: "closed", probe: false });
  const serializedState = fs.readdirSync(root).filter((entry) => entry.endsWith(".json")).map((entry) => fs.readFileSync(path.join(root, entry), "utf8")).join("\n");
  assert.equal(serializedState.includes("codex"), false);
});

test("OPT-04: reliability budget provider ve global sınırı birlikte uygular", () => {
  const budget = resolveReliabilityBudget({
    reliability: { maxAttempts: 3, maxTotalDurationMs: 60000, maxRetryCostUsd: 1, baseRetryDelayMs: 500, maxRetryDelayMs: 2000 },
    codex: { timeoutMs: 90000, maxRetries: 1 }
  }, "codex", 30000);
  assert.equal(budget.maxAttempts, 2);
  assert.equal(budget.timeoutMs, 30000);
  assert.equal(budget.maxTotalDurationMs, 60000);
  const defaultBudget = resolveReliabilityBudget({ reliability: { maxAttempts: 3 }, codex: { timeoutMs: 90000, maxRetries: 1 } }, "codex", 30000);
  assert.equal(defaultBudget.maxTotalDurationMs, 60000);
});

test("OPT-05: telemetry özeti provider, percentile ve cache bilgisini taşır", () => {
  const summary = summarizeMetrics([
    { backend: "codex", outcomeStatus: "completed", failureClass: null, usage: { durationMs: 100, totalCostUsd: 0.01 }, attempts: [{}], retries: 0, cacheHit: false },
    { backend: "antigravity", outcomeStatus: "failed", failureClass: "process_exit", usage: { durationMs: 200, totalCostUsd: null }, attempts: [{}, {}], retries: 1, cacheHit: true },
    { recordType: "cost_settlement", backend: "cost", chargedCostUsd: 0.2 },
    { recordType: "health_snapshot", recordedAt: "2026-08-11T00:00:00.000Z", backend: "bridge-health", adapters: { codex: { installed: true, authValid: true, error: null } } },
    { recordType: "health_snapshot", recordedAt: "2026-08-11T00:01:00.000Z", backend: "bridge-health", adapters: { codex: { installed: true, authValid: false, error: "unavailable" } } }
  ]);
  assert.equal(summary.runCount, 2);
  assert.equal(summary.p95DurationMs, 200);
  assert.equal(summary.byBackend.codex.completed, 1);
  assert.equal(summary.byBackend.antigravity.cacheHits, 1);
  assert.equal(summary.averageAttempts, 1.5);
  assert.equal(summary.health.observationCount, 2);
  assert.equal(summary.health.byAdapter.codex.availabilityRate, 0.5);
  assert.deepEqual(summary.directEditBaseline, {
    totalEditRuns: 0,
    labeledEditRuns: 0,
    pendingFeedback: 0,
    outcomes: { accepted: 0, minor_fix: 0, reverted: 0, security_concern: 0 },
    interventionRate: null,
    rollbackOrSecurityRate: null,
    decisionReady: false,
    byBackend: {},
    byProfile: {}
  });
  assert.deepEqual(summary.routingEvaluation, { byProfile: {} });
});

test("OPT-05a: direct edit baseline yalnız redacted kullanıcı sonucunu özetler", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-edit-feedback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = { statePaths: { logs: root }, observability: { maxMetricFileBytes: 65536 } };
  const executionIdHash = crypto.createHash("sha256").update("private-edit-execution").digest("hex");
  await appendRedactedRunMetric(configuration, {
    recordedAt: "2026-08-11T00:00:00.000Z",
    backend: "codex",
    executionIdHash,
    mode: "edit",
    profile: "implementation",
    outcomeStatus: "completed",
    usage: { durationMs: 250, totalCostUsd: 0.02 },
    attempts: [{}]
  });
  await appendRedactedRunMetric(configuration, {
    recordedAt: "2026-08-11T00:01:00.000Z",
    backend: "codex",
    executionIdHash: crypto.createHash("sha256").update("failed-private-edit-execution").digest("hex"),
    mode: "edit",
    outcomeStatus: "failed",
    usage: { durationMs: 250, totalCostUsd: 0.02 },
    attempts: [{}]
  });
  assert.deepEqual(listPendingDirectEditFeedback(configuration), [{
    feedbackId: executionIdHash.slice(0, 12),
    backend: "codex",
    recordedAt: "2026-08-11T00:00:00.000Z",
    outcomeStatus: "completed",
    durationMs: 250,
    totalCostUsd: 0.02
  }]);
  await recordDirectEditFeedback(configuration, executionIdHash.slice(0, 12), "minor_fix");
  assert.deepEqual(listPendingDirectEditFeedback(configuration), []);
  const summary = summarizeMetrics(readMetricsDirectory(path.join(root, "metrics")));
  assert.equal(summary.directEditBaseline.totalEditRuns, 1);
  assert.equal(summary.directEditBaseline.labeledEditRuns, 1);
  assert.equal(summary.directEditBaseline.outcomes.minor_fix, 1);
  assert.equal(summary.directEditBaseline.interventionRate, 1);
  assert.deepEqual(summary.directEditBaseline.byBackend.codex, {
    totalEditRuns: 1,
    labeledEditRuns: 1,
    pendingFeedback: 0,
    outcomes: { accepted: 0, minor_fix: 1, reverted: 0, security_concern: 0 },
    interventionRate: 1,
    rollbackOrSecurityRate: 0,
    decisionReady: false
  });
  assert.deepEqual(summary.directEditBaseline.byProfile.implementation, summary.directEditBaseline.byBackend.codex);
  const serialized = fs.readFileSync(path.join(root, "metrics", "direct-edit-baseline-runs.jsonl"), "utf8");
  assert.equal(serialized.includes("private-edit-execution"), false);
  await assert.rejects(() => recordDirectEditFeedback(configuration, executionIdHash.slice(0, 12), "accepted"), /already recorded/);
});

test("OPT-05b: routing değerlendirmesi profile kalite süre ve maliyetini özetler", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-routing-feedback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = { statePaths: { logs: root }, observability: { maxMetricFileBytes: 65536 } };
  const executionIdHash = crypto.createHash("sha256").update("private-profile-execution").digest("hex");
  await appendRedactedRunMetric(configuration, {
    recordedAt: "2026-08-11T00:00:00.000Z",
    backend: "codex",
    modelHash: crypto.createHash("sha256").update("gpt-5.6-terra").digest("hex"),
    executionIdHash,
    mode: "read_only",
    profile: "review",
    outcomeStatus: "completed",
    usage: { durationMs: 400, totalCostUsd: 0.03 },
    attempts: [{}]
  });
  assert.equal(listPendingRoutingFeedback(configuration)[0].profile, "review");
  await recordRoutingFeedback(configuration, executionIdHash.slice(0, 12), "useful");
  assert.deepEqual(listPendingRoutingFeedback(configuration), []);
  const summary = summarizeMetrics(readMetricsDirectory(path.join(root, "metrics")));
  assert.deepEqual(summary.routingEvaluation.byProfile.review, {
    runs: 1,
    labeledRuns: 1,
    useful: 1,
    partial: 0,
    notUseful: 0,
    totalCostUsd: 0.03,
    pendingFeedback: 0,
    usefulRate: 1,
    averageDurationMs: 400,
    decisionReady: false
  });
  await assert.rejects(() => recordRoutingFeedback(configuration, executionIdHash.slice(0, 12), "not_useful"), /already recorded/);
});

test("OPT-06: metrics dosyası sınırda rotasyon yapar", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-metrics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = { statePaths: { logs: root }, observability: { maxMetricFileBytes: 120 } };
  await appendRedactedRunMetric(configuration, { backend: "codex", recordedAt: "one", payload: "x".repeat(80) });
  await appendRedactedRunMetric(configuration, { backend: "codex", recordedAt: "two", payload: "x".repeat(80) });
  const entries = fs.readdirSync(path.join(root, "metrics"));
  assert.equal(entries.some((entry) => entry.startsWith("codex-runs-") && entry.endsWith(".jsonl")), true);
  assert.equal(entries.includes("codex-runs.jsonl"), true);
  assert.equal(readMetricsDirectory(path.join(root, "metrics")).length, 2);
});

test("OPT-06a: eşzamanlı processler metrics kaydı kaybetmez", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-metrics-concurrent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = { statePaths: { logs: root }, observability: { maxMetricFileBytes: 65536 } };
  const metricsModule = pathToFileURL(path.resolve("subagent-bridge/src/metrics.js")).href;
  const writeMetric = (index) => new Promise((resolve, reject) => {
    const source = `import { appendRedactedRunMetric } from ${JSON.stringify(metricsModule)}; await appendRedactedRunMetric(${JSON.stringify(configuration)}, { backend: "codex", index: ${index} });`;
    const child = childProcess.spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`metric writer exited with ${code}`)));
  });
  await Promise.all(Array.from({ length: 12 }, (_, index) => writeMetric(index)));
  const metricsPath = path.join(root, "metrics", "codex-runs.jsonl");
  const entries = fs.readFileSync(metricsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 12);
  assert.deepEqual(entries.map((entry) => entry.index).sort((left, right) => left - right), Array.from({ length: 12 }, (_, index) => index));
  assert.equal(fs.existsSync(`${metricsPath}.lock`), false);
});

test("OPT-06b: cost circuit breaker günlük rezerv limiti uygular", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cost-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = {
    statePaths: { logs: root },
    reliability: { dailyCostLimitUsd: 0.2, monthlyCostLimitUsd: 1 }
  };
  assert.deepEqual(await reserveCostBudget(configuration, "first", 0.1), { allowed: true });
  assert.deepEqual(await reserveCostBudget(configuration, "second", 0.11), {
    allowed: false,
    reason: "daily_cost_budget_exhausted",
    budget: { period: "daily", limitUsd: 0.2, spentUsd: 0.1, remainingUsd: 0.1 }
  });
  await appendRedactedRunMetric(configuration, {
    backend: "codex",
    executionIdHash: crypto.createHash("sha256").update("first").digest("hex"),
    recordedAt: new Date().toISOString(),
    usage: { totalCostUsd: 0.05 }
  });
  assert.deepEqual(await reserveCostBudget(configuration, "second", 0.11), { allowed: true });
});

test("OPT-06c: cost budget günlüğü sınırda rotasyon yapar", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cost-budget-rotation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = {
    statePaths: { logs: root },
    observability: { maxMetricFileBytes: 200 },
    reliability: { dailyCostLimitUsd: 10, monthlyCostLimitUsd: 10 }
  };
  await reserveCostBudget(configuration, "first", 0.1);
  await reserveCostBudget(configuration, "second", 0.1);
  const entries = fs.readdirSync(path.join(root, "metrics"));
  assert.equal(entries.some((entry) => entry.startsWith("cost-budget-runs-") && entry.endsWith(".jsonl")), true);
  assert.equal(entries.includes("cost-budget-runs.jsonl"), true);
});

test("OPT-06i: aylık bütçe reddi limit harcama ve kalan kotayı raporlar", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-monthly-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = {
    statePaths: { logs: root },
    reliability: { monthlyCostLimitUsd: 0.2, maxTotalDurationMs: 60000 }
  };
  assert.deepEqual(await reserveCostBudget(configuration, "first", 0.15), { allowed: true });
  assert.deepEqual(await reserveCostBudget(configuration, "second", 0.06), {
    allowed: false,
    reason: "monthly_cost_budget_exhausted",
    budget: { period: "monthly", limitUsd: 0.2, spentUsd: 0.15, remainingUsd: 0.05 }
  });
});

test("OPT-06d: cost reservation açık settlement kaydıyla gerçek maliyete uzlaştırılır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cost-settlement-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = {
    statePaths: { logs: root },
    observability: { maxMetricFileBytes: 65536 },
    reliability: { dailyCostLimitUsd: 0.2, monthlyCostLimitUsd: 1, maxTotalDurationMs: 60000 }
  };
  assert.deepEqual(await reserveCostBudget(configuration, "private-execution", 0.15), { allowed: true });
  assert.deepEqual(await settleCostBudget(configuration, "private-execution", 0.05), { settled: true, chargedCostUsd: 0.05 });
  assert.deepEqual(await reserveCostBudget(configuration, "private-execution", 0.01), { allowed: false, reason: "duplicate_cost_reservation" });
  assert.deepEqual(await reserveCostBudget(configuration, "next", 0.15), { allowed: true });
  const journal = fs.readFileSync(path.join(root, "metrics", "cost-budget-runs.jsonl"), "utf8");
  assert.equal(journal.includes("private-execution"), false);
  assert.match(journal, /"recordType":"cost_settlement"/);
});

test("OPT-06e: bağımsız süreçlerin eşzamanlı rezervleri hard cap değerini aşmaz", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cost-concurrent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = {
    statePaths: { logs: root },
    observability: { maxMetricFileBytes: 65536 },
    reliability: { dailyCostLimitUsd: 0.2, monthlyCostLimitUsd: 1, maxTotalDurationMs: 60000 }
  };
  const metricsModule = pathToFileURL(path.resolve("subagent-bridge/src/metrics.js")).href;
  const reserve = (index) => new Promise((resolve, reject) => {
    const source = `import { reserveCostBudget } from ${JSON.stringify(metricsModule)}; const result = await reserveCostBudget(${JSON.stringify(configuration)}, "execution-${index}", 0.03); process.stdout.write(JSON.stringify(result));`;
    const child = childProcess.spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`reservation process exited with ${code}: ${stderr}`)));
  });
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => reserve(index)));
  assert.equal(results.filter((result) => result.allowed).length, 6);
  assert.ok(results.filter((result) => result.allowed).length * 0.03 <= configuration.reliability.dailyCostLimitUsd);
});

test("OPT-06g: bozuk JSONL satırları droppedMetricRecords olarak sayılır ve harcama etkilenmez", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cost-dropped-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = {
    statePaths: { logs: root },
    observability: { maxMetricFileBytes: 65536 },
    reliability: { dailyCostLimitUsd: 10, monthlyCostLimitUsd: 10, maxTotalDurationMs: 60000 }
  };
  const metricsDirectory = path.join(root, "metrics");
  fs.mkdirSync(metricsDirectory, { recursive: true });
  fs.appendFileSync(path.join(metricsDirectory, "codex-runs.jsonl"), "{this is not valid json}\n");
  fs.appendFileSync(path.join(metricsDirectory, "codex-runs.jsonl"), JSON.stringify({ backend: "codex", recordedAt: new Date().toISOString(), usage: { totalCostUsd: 0.5, durationMs: 100 }, executionIdHash: "abc" }) + "\n");
  const snapshot = await getCostBudgetSnapshot(configuration);
  assert.equal(snapshot.droppedMetricRecords, 1);
  assert.equal(snapshot.dailySpentUsd, 0.5);
});

test("OPT-06f: bütçe snapshot harcama kalan tutar ve aktif rezervleri raporlar", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cost-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = {
    statePaths: { logs: root },
    observability: { maxMetricFileBytes: 65536 },
    reliability: { dailyCostLimitUsd: 1, monthlyCostLimitUsd: 5, warningThresholdPercent: 20, maxTotalDurationMs: 60000 }
  };
  await reserveCostBudget(configuration, "active", 0.2);
  await reserveCostBudget(configuration, "completed", 0.3);
  await settleCostBudget(configuration, "completed", 0.1);
  const snapshot = await getCostBudgetSnapshot(configuration);
  assert.equal(snapshot.dailySpentUsd, 0.3);
  assert.equal(snapshot.monthlySpentUsd, 0.3);
  assert.equal(snapshot.dailyRemainingUsd, 0.7);
  assert.equal(snapshot.monthlyRemainingUsd, 4.7);
  assert.equal(snapshot.activeReservations, 1);
  assert.equal(snapshot.dailyUsagePercent, 30);
  assert.equal(snapshot.monthlyUsagePercent, 6);
  assert.equal(snapshot.dailyWarning, true);
  assert.equal(snapshot.monthlyWarning, false);
});

test("OPT-06h: pruneMetricFiles yalnız retention dışı rotated dosyaları siler", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-prune-retention-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = {
    statePaths: { logs: root },
    observability: { maxMetricFileBytes: 65536, maxMetricRetentionDays: 30 }
  };
  const metricsDirectory = path.join(root, "metrics");
  fs.mkdirSync(metricsDirectory, { recursive: true });
  const activePath = path.join(metricsDirectory, "codex-runs.jsonl");
  const stalePath = path.join(metricsDirectory, "codex-runs-2020-01-01T00-00-00-000Z-aaaa.jsonl");
  const freshRotatedPath = path.join(metricsDirectory, "codex-runs-2026-01-01T00-00-00-000Z-bbbb.jsonl");
  fs.writeFileSync(activePath, "active\n", "utf8");
  fs.writeFileSync(stalePath, "stale\n", "utf8");
  fs.writeFileSync(freshRotatedPath, "fresh\n", "utf8");
  const now = Date.parse("2026-02-01T00:00:00.000Z");
  fs.utimesSync(stalePath, new Date(now), new Date(Date.parse("2020-01-01T00:00:00.000Z")));
  fs.utimesSync(freshRotatedPath, new Date(now), new Date(Date.parse("2026-01-15T00:00:00.000Z")));
  fs.utimesSync(activePath, new Date(now), new Date(now));
  const deleted = pruneMetricFiles(configuration, now);
  assert.equal(deleted, 1);
  assert.equal(fs.existsSync(activePath), true);
  assert.equal(fs.existsSync(stalePath), false);
  assert.equal(fs.existsSync(freshRotatedPath), true);
});
