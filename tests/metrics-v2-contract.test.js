import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendRedactedRunMetric, createRedactedExecutionMetric } from "../subagent-bridge/src/metrics.js";
import { readRecentRuns } from "../subagent-bridge/src/recent-runs.js";

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function configuration(root) {
  return {
    statePaths: {
      logs: path.join(root, "machine-logs"),
      state: path.join(root, "machine-state"),
      cache: path.join(root, "machine-cache")
    },
    observability: { maxMetricFileBytes: 16 * 1024 * 1024 },
    orchestration: {
      taskProfiles: {
        review: { target: "codex", model: "gemini-3.8-flash-high", mode: "read_only", priority: 1, cacheable: false }
      }
    }
  };
}

function readMetricRecords(config) {
  const metricsDirectory = path.join(config.statePaths.logs, "metrics");
  return fs.readdirSync(metricsDirectory)
    .filter((entry) => entry.endsWith(".jsonl"))
    .flatMap((entry) => fs.readFileSync(path.join(metricsDirectory, entry), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
}

function executionAttempt(overrides = {}) {
  return {
    number: 1,
    failureClass: "process_exit",
    failureStage: "provider_execution",
    providerCode: "process_exit",
    exitCode: 1,
    signal: null,
    retryDecision: "stop",
    retryStopReason: "non_retryable_failure_class",
    settingsLockWaitMs: null,
    providerExecutionMs: 25,
    stdoutBucket: "empty",
    stderrBucket: "lte_1_kib",
    durationMs: 30,
    totalCostUsd: null,
    ...overrides
  };
}

function baseResult(overrides = {}) {
  return {
    ok: false,
    backend: "antigravity",
    model: "gemini-3.8-flash-high",
    resolvedModel: "gemini-3.8-flash-high",
    result: null,
    error: "provider failed",
    retryable: false,
    timedOut: false,
    exitCode: 1,
    durationMs: 50,
    reason: "process_exit",
    metrics: { retries: 0, totalCostUsd: null, attempts: [executionAttempt()] },
    ...overrides
  };
}

async function writeExecutionMetric(config, { executionId, workspace, mode, profile, result }) {
  const metric = createRedactedExecutionMetric({ executionId, workspace, mode, profile, result });
  await appendRedactedRunMetric(config, metric);
  return metric;
}

test("V2-01: başarılı run v2 kaydı strict okuyucudan geçer ve operatör görünümünde tanı alanları null olur", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-01-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await writeExecutionMetric(config, {
    executionId: "exec-success",
    workspace: root,
    mode: "read_only",
    profile: "review",
    result: baseResult({
      ok: true,
      error: null,
      exitCode: 0,
      reason: undefined,
      metrics: {
        retries: 0,
        totalCostUsd: 0.01,
        queueWaitMs: 5,
        cacheHit: true,
        attempts: [executionAttempt({ failureClass: null, failureStage: null, providerCode: null, exitCode: 0, retryDecision: "not_applicable", retryStopReason: null, totalCostUsd: 0.01 })]
      }
    })
  });
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 1);
  const run = view.runs[0];
  assert.equal(run.outcomeStatus, "completed");
  assert.equal(run.failureClass, null);
  assert.equal(run.failureStage, null);
  assert.equal(run.providerCode, null);
  assert.equal(run.retryStopReason, null);
  assert.equal(run.exitCode, 0);
  assert.equal(run.retries, 0);
  assert.equal(run.cacheHit, true);
  assert.equal(run.durationMs, 50);
  assert.equal(run.reportedCostUsd, 0.01);
  assert.equal(Object.hasOwn(run, "attempts"), false);
  const [record] = readMetricRecords(config);
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.attempts.length, 1);
  assert.equal(record.attempts[0].retryDecision, "not_applicable");
  assert.equal(record.usage.totalCostUsd, 0.01);
  assert.equal(record.queueWaitMs, 5);
});

test("V2-02: attempt üretmeyen erken hata v2 kaydında top-level tanıyla okunur", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-02-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await writeExecutionMetric(config, {
    executionId: "exec-early",
    workspace: root,
    mode: "read_only",
    profile: null,
    result: baseResult({
      reason: "queue_unavailable",
      error: "workspace queue unavailable",
      exitCode: null,
      metrics: { retries: 0, totalCostUsd: null }
    })
  });
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 1);
  assert.equal(view.runs[0].failureClass, "queue_unavailable");
  assert.equal(view.runs[0].failureStage, null);
  assert.equal(view.runs[0].providerCode, null);
  assert.equal(view.runs[0].retryStopReason, null);
  const [record] = readMetricRecords(config);
  assert.deepEqual(record.attempts, []);
});

test("V2-03: son attempt sinyali ve çıkış kodu operatör görünümüne taşınır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-03-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await writeExecutionMetric(config, {
    executionId: "exec-signal",
    workspace: root,
    mode: "read_only",
    profile: null,
    result: baseResult({
      exitCode: null,
      metrics: {
        retries: 1,
        totalCostUsd: null,
        attempts: [
          executionAttempt({ number: 1, failureClass: "network", providerCode: "connection_reset", exitCode: null, retryDecision: "retry", retryStopReason: null }),
          executionAttempt({ number: 2, failureClass: "process_exit", signal: "SIGTERM", exitCode: null, durationMs: 60 })
        ]
      }
    })
  });
  const view = readRecentRuns(config);
  assert.equal(view.runs[0].failureClass, "process_exit");
  assert.equal(view.runs[0].signal, "SIGTERM");
  assert.equal(view.runs[0].exitCode, null);
  assert.equal(view.runs[0].retries, 1);
});

test("V2-04: usage ve queueWaitMs değerleri korunur", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-04-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await writeExecutionMetric(config, {
    executionId: "exec-usage",
    workspace: root,
    mode: "read_only",
    profile: null,
    result: baseResult({
      durationMs: 1234,
      metrics: { retries: 0, totalCostUsd: 0.25, queueWaitMs: 77, attempts: [executionAttempt({ totalCostUsd: 0.25 })] }
    })
  });
  const view = readRecentRuns(config);
  assert.equal(view.runs[0].durationMs, 1234);
  assert.equal(view.runs[0].reportedCostUsd, 0.25);
  const [record] = readMetricRecords(config);
  assert.equal(record.usage.durationMs, 1234);
  assert.equal(record.queueWaitMs, 77);
});

test("V2-05: mode ve profile allowlist normalizasyonu uygulanır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-05-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await writeExecutionMetric(config, {
    executionId: "exec-mode",
    workspace: root,
    mode: "edit",
    profile: "bad profile!",
    result: baseResult()
  });
  await writeExecutionMetric(config, {
    executionId: "exec-mode-2",
    workspace: root,
    mode: "unexpected-mode",
    profile: "review",
    result: baseResult({ metrics: { retries: 0, totalCostUsd: null, attempts: [executionAttempt({ number: 2 })] } })
  });
  const records = readMetricRecords(config);
  const editRecord = records.find((record) => record.executionIdHash === hash("exec-mode"));
  const fallbackRecord = records.find((record) => record.executionIdHash === hash("exec-mode-2"));
  assert.equal(editRecord.mode, "edit");
  assert.equal(editRecord.profile, null);
  assert.equal(fallbackRecord.mode, "read_only");
  assert.equal(fallbackRecord.profile, "review");
});

test("V2-06: eksik model ve workspace deterministik hash ile kapatılır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-06-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await writeExecutionMetric(config, {
    executionId: "exec-missing",
    workspace: undefined,
    mode: "read_only",
    profile: null,
    result: baseResult({ model: undefined, resolvedModel: undefined })
  });
  const [record] = readMetricRecords(config);
  assert.equal(record.modelHash, hash("unavailable"));
  assert.equal(record.workspaceHash, hash("unavailable"));
  assert.equal(JSON.stringify(record).includes("undefined"), false);
});

test("V2-07: geçersiz top-level enum değerleri kapalı değerlere düşer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-07-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await writeExecutionMetric(config, {
    executionId: "exec-enums",
    workspace: root,
    mode: "read_only",
    profile: null,
    result: baseResult({
      reason: "custom free text failure",
      metrics: { retries: 0, totalCostUsd: null }
    })
  });
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 1);
  assert.equal(view.runs[0].failureClass, "unclassified_failure");
  assert.equal(view.runs[0].failureStage, null);
  assert.equal(view.runs[0].providerCode, null);
  assert.equal(view.runs[0].retryStopReason, null);
});

test("V2-08: edit mutation_state_unknown yalnız retryStopReason olarak kalır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-08-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const metric = await writeExecutionMetric(config, {
    executionId: "exec-edit",
    workspace: root,
    mode: "edit",
    profile: null,
    result: baseResult({
      reason: "mutation_state_unknown",
      metrics: {
        retries: 0,
        totalCostUsd: null,
        attempts: [executionAttempt({ failureClass: "process_exit", retryDecision: "stop", retryStopReason: "mutation_state_unknown" })]
      }
    })
  });
  assert.equal(metric.failureClass, "process_exit");
  assert.equal(metric.retryStopReason, "mutation_state_unknown");
  const view = readRecentRuns(config);
  assert.equal(view.runs[0].failureClass, "process_exit");
  assert.equal(view.runs[0].retryStopReason, "mutation_state_unknown");
  assert.equal(view.runs[0].mode, "edit");
});

test("V2-09: bozuk v2 kaydı okuyucu tarafından dışlanır, geçerli v1 kaydı okunur", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-09-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const metricsDirectory = path.join(config.statePaths.logs, "metrics");
  fs.mkdirSync(metricsDirectory, { recursive: true });
  const forgedV2 = {
    schemaVersion: 2,
    recordedAt: new Date().toISOString(),
    backend: "antigravity",
    modelHash: hash("model"),
    executionIdHash: hash("forged"),
    workspaceHash: hash("workspace"),
    mode: "read_only",
    profile: null,
    outcomeStatus: "failed",
    failureClass: "process_exit",
    failureStage: "provider_execution",
    providerCode: "sk-live-NOT-ALLOWED",
    retryStopReason: null,
    usage: { durationMs: 1, totalCostUsd: null },
    attempts: [],
    retries: 0,
    queueWaitMs: 0,
    cacheHit: false
  };
  const validV1 = {
    recordedAt: new Date(Date.now() - 1000).toISOString(),
    backend: "codex",
    modelHash: hash("gpt"),
    executionIdHash: hash("v1-valid"),
    workspaceHash: hash("workspace"),
    mode: "read_only",
    profile: null,
    outcomeStatus: "completed",
    failureClass: null,
    usage: { durationMs: 5, totalCostUsd: 0 },
    attempts: [{ number: 1, failureClass: null, exitCode: 0, durationMs: 5, totalCostUsd: 0, retryDelayMs: null }],
    retries: 0,
    queueWaitMs: 0,
    cacheHit: false
  };
  fs.appendFileSync(path.join(metricsDirectory, "antigravity-runs.jsonl"), `${JSON.stringify(forgedV2)}\n`, "utf8");
  fs.appendFileSync(path.join(metricsDirectory, "codex-runs.jsonl"), `${JSON.stringify(validV1)}\n`, "utf8");
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 1);
  assert.equal(view.runs[0].failureClass, null);
});

test("V2-10: cache hit kaydı sıfır attempt ile okunur", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-10-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await writeExecutionMetric(config, {
    executionId: "exec-cache",
    workspace: root,
    mode: "read_only",
    profile: null,
    result: baseResult({
      ok: true,
      error: null,
      exitCode: 0,
      reason: undefined,
      metrics: { retries: 0, totalCostUsd: 0, cacheHit: true }
    })
  });
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 1);
  assert.equal(view.runs[0].cacheHit, true);
  assert.equal(view.runs[0].retries, 0);
  const [record] = readMetricRecords(config);
  assert.deepEqual(record.attempts, []);
});

test("V2-11: son attempt failureClass null ise top-level failureClass null kalır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-11-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const result = baseResult({
    reason: "process_exit",
    metrics: { retries: 0, totalCostUsd: null, attempts: [executionAttempt({ failureClass: null })] }
  });
  const metric = createRedactedExecutionMetric({ executionId: "exec-null-class", workspace: root, mode: "read_only", profile: null, result });
  assert.equal(metric.failureClass, null);
  await appendRedactedRunMetric(config, metric);
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 1);
  assert.equal(view.runs[0].failureClass, null);
});
