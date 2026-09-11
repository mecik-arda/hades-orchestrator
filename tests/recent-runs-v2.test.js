import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
    orchestration: {
      taskProfiles: {
        review: { target: "antigravity", model: "gemini-3.8-flash-high", mode: "read_only", priority: 1, cacheable: false }
      }
    }
  };
}

function metricsDirectory(config) {
  return path.join(config.statePaths.logs, "metrics");
}

function writeJsonl(config, fileName, records) {
  const directory = metricsDirectory(config);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, fileName), `${records.map((record) => typeof record === "string" ? record : JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function attemptV2(overrides = {}) {
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

function executionV2(overrides = {}) {
  return {
    schemaVersion: 2,
    recordedAt: new Date().toISOString(),
    backend: "antigravity",
    modelHash: hash("gemini-3.8-flash-high"),
    executionIdHash: hash("execution"),
    workspaceHash: hash("workspace"),
    mode: "read_only",
    profile: "review",
    outcomeStatus: "failed",
    failureClass: "process_exit",
    failureStage: "provider_execution",
    providerCode: "process_exit",
    retryStopReason: "non_retryable_failure_class",
    usage: { durationMs: 30, totalCostUsd: null },
    attempts: [attemptV2()],
    retries: 0,
    queueWaitMs: 0,
    cacheHit: false,
    ...overrides
  };
}

function executionV1(overrides = {}) {
  return {
    recordedAt: new Date(Date.now() - 1000).toISOString(),
    backend: "codex",
    modelHash: hash("gpt-test"),
    executionIdHash: hash("v1-execution"),
    workspaceHash: hash("v1-workspace"),
    mode: "read_only",
    profile: null,
    outcomeStatus: "completed",
    failureClass: null,
    usage: { durationMs: 5, totalCostUsd: 0 },
    attempts: [{ number: 1, failureClass: null, exitCode: 0, durationMs: 5, totalCostUsd: 0, retryDelayMs: null }],
    retries: 0,
    queueWaitMs: 0,
    cacheHit: false,
    ...overrides
  };
}

function legacyRecord(overrides = {}) {
  return {
    recordedAt: new Date(Date.now() - 2000).toISOString(),
    backend: "deepseek",
    runIdHash: hash("legacy-run"),
    taskIdHash: hash("legacy-task"),
    agent: "deepseek",
    role: "reviewer",
    modelHash: hash("deepseek-v4-pro"),
    outcomeStatus: "completed",
    failureClass: null,
    usage: { durationMs: 500, totalCostUsd: 0.001 },
    attempts: [{ number: 1, failureClass: null, exitCode: 0, durationMs: 500, apiDurationMs: null, turns: null, totalCostUsd: 0.001, retryDelayMs: null }],
    ...overrides
  };
}

test("RV2-01: tutarsız top-level alanlar yerine son attempt tanısı gösterilir", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv2-01-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  writeJsonl(config, "antigravity-runs.jsonl", [executionV2({
    failureClass: "timeout",
    failureStage: "settings_lock",
    providerCode: "timeout",
    retryStopReason: "mutation_state_unknown",
    attempts: [
      attemptV2({ number: 1, failureClass: "network", providerCode: "connection_reset", exitCode: null, retryDecision: "retry", retryStopReason: null }),
      attemptV2({ number: 2, failureClass: "process_exit", signal: "SIGTERM", exitCode: null, retryDecision: "stop", retryStopReason: "mutation_state_unknown" })
    ]
  })]);
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 1);
  const run = view.runs[0];
  assert.equal(run.failureClass, "process_exit");
  assert.equal(run.failureStage, "provider_execution");
  assert.equal(run.providerCode, "process_exit");
  assert.equal(run.retryStopReason, "mutation_state_unknown");
  assert.equal(run.signal, "SIGTERM");
  assert.equal(run.exitCode, null);
  assert.equal(run.retries, 1);
  assert.equal(Object.hasOwn(run, "attempts"), false);
});

test("RV2-02: attempt dizisi boşsa top-level tanı kullanılır", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv2-02-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  writeJsonl(config, "antigravity-runs.jsonl", [executionV2({
    failureClass: "rate_limited",
    failureStage: "provider_execution",
    providerCode: "resource_exhausted",
    retryStopReason: "non_retryable_failure_class",
    attempts: [],
    retries: 3
  })]);
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 1);
  assert.equal(view.runs[0].failureClass, "rate_limited");
  assert.equal(view.runs[0].providerCode, "resource_exhausted");
  assert.equal(view.runs[0].retryStopReason, "non_retryable_failure_class");
  assert.equal(view.runs[0].retries, 3);
});

test("RV2-03: geçersiz v2 kaydı atlanır ve legacy kayıt okunmaya devam eder", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv2-03-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  writeJsonl(config, "antigravity-runs.jsonl", [executionV2({ providerCode: "not-an-enum-value" })]);
  writeJsonl(config, "deepseek-runs.jsonl", [legacyRecord()]);
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 1);
  assert.equal(view.runs[0].role, "reviewer");
  assert.equal(view.runs[0].mode, "not_applicable");
  assert.deepEqual(view.runs[0].feedback, { routing: "not_applicable", directEdit: "not_applicable" });
});

test("RV2-04: aynı hash için çelişkili v2 kayıtları gösterilmez", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv2-04-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const first = executionV2();
  writeJsonl(config, "antigravity-runs.jsonl", [first, { ...first, outcomeStatus: "completed", failureClass: null, failureStage: null, providerCode: null, retryStopReason: null }]);
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 0);
  assert.equal(view.conflictCount, 1);
});

test("RV2-05: v1 legacy ve v2 kayıtlar aynı görünümde ayrışır", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv2-05-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  writeJsonl(config, "codex-runs.jsonl", [executionV1()]);
  writeJsonl(config, "deepseek-runs.jsonl", [legacyRecord()]);
  writeJsonl(config, "antigravity-runs.jsonl", [executionV2()]);
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 3);
  const legacyRun = view.runs.find((run) => run.role === "reviewer");
  const v1Run = view.runs.find((run) => run.profile === null && run.role === null);
  const v2Run = view.runs.find((run) => run.failureClass === "process_exit");
  assert.ok(legacyRun);
  assert.ok(v1Run);
  assert.ok(v2Run);
  assert.equal(v2Run.failureStage, "provider_execution");
});

test("RV2-06: v2 run için doğrudan düzenleme geri bildirimi eşleşir", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv2-06-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  writeJsonl(config, "antigravity-runs.jsonl", [executionV2()]);
  writeJsonl(config, "direct-edit-baseline-runs.jsonl", [{
    recordType: "direct_edit_feedback",
    recordedAt: new Date().toISOString(),
    backend: "direct-edit-baseline",
    executionIdHash: hash("execution"),
    outcome: "minor_fix"
  }]);
  writeJsonl(config, "routing-evaluation-runs.jsonl", [{
    recordType: "routing_feedback",
    recordedAt: new Date().toISOString(),
    backend: "routing-evaluation",
    executionIdHash: hash("execution"),
    outcome: "partial"
  }]);
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 1);
  assert.deepEqual(view.runs[0].feedback, { routing: "partial", directEdit: "minor_fix" });
});

test("RV2-07: yapılandırılmış model hash'i görüntü adına çözülür", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv2-07-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  writeJsonl(config, "antigravity-runs.jsonl", [executionV2()]);
  const view = readRecentRuns(config);
  assert.equal(view.runs[0].modelDisplay, "gemini-3.8-flash-high");
});

test("RV2-08: yüzden fazla attempt içeren v2 kaydı reddedilir", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv2-08-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const attempts = Array.from({ length: 101 }, (_, index) => attemptV2({ number: index + 1 }));
  writeJsonl(config, "antigravity-runs.jsonl", [executionV2({ attempts })]);
  assert.equal(readRecentRuns(config).runCount, 0);
});

test("RV2-09: kayıt zaman penceresi dışındaki v2 run gösterilmez", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv2-09-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const recent = executionV2();
  const expired = executionV2({
    recordedAt: new Date(Date.now() - 10 * 86400000).toISOString(),
    executionIdHash: hash("old-execution")
  });
  writeJsonl(config, "antigravity-runs.jsonl", [expired, recent]);
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 1);
  assert.equal(view.runs[0].recordedAt, recent.recordedAt);
});

test("RV2-10: retries değeri attempt dizisinden türetilir", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv2-10-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  writeJsonl(config, "antigravity-runs.jsonl", [executionV2({
    retries: 0,
    attempts: [
      attemptV2({ number: 1, failureClass: "network", providerCode: "connection_reset", exitCode: null, retryDecision: "retry", retryStopReason: null }),
      attemptV2({ number: 2 }),
      attemptV2({ number: 3 })
    ]
  })]);
  const view = readRecentRuns(config);
  assert.equal(view.runs[0].retries, 2);
});
