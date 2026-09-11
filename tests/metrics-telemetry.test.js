import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendRedactedRunMetric,
  createRedactedExecutionMetric,
  normalizeFailureStage,
  normalizeOutputSizeBucket,
  normalizeProcessSignal,
  normalizeProviderCode,
  normalizeRetryDecision,
  normalizeRetryStopReason,
  outputSizeBucket
} from "../subagent-bridge/src/metrics.js";
import { enableProjectMirror, readProjectMirror } from "../subagent-bridge/src/project-runs.js";
import { readRecentRuns } from "../subagent-bridge/src/recent-runs.js";

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function configuration(root, workspace = root) {
  return {
    allowedRoots: [root],
    deepseek: { deniedRootPaths: [] },
    statePaths: {
      logs: path.join(root, "machine-logs"),
      state: path.join(root, "machine-state"),
      cache: path.join(root, "machine-cache")
    },
    observability: { maxMetricFileBytes: 16 * 1024 * 1024 },
    orchestration: {
      taskProfiles: {
        review: { target: "codex", model: "gpt-test", mode: "read_only", priority: 1, cacheable: false }
      }
    },
    workspace
  };
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
    retryStopReason: "mutation_state_unknown",
    settingsLockWaitMs: 12,
    providerExecutionMs: 340,
    stdoutBucket: "empty",
    stderrBucket: "lte_1_kib",
    durationMs: 400,
    totalCostUsd: null,
    ...overrides
  };
}

function executionMetric(overrides = {}) {
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
    retryStopReason: "mutation_state_unknown",
    usage: { durationMs: 400, totalCostUsd: null },
    attempts: [executionAttempt()],
    retries: 0,
    queueWaitMs: 0,
    cacheHit: false,
    ...overrides
  };
}

function readMetricRecords(config) {
  const metricsDirectory = path.join(config.statePaths.logs, "metrics");
  return fs.readdirSync(metricsDirectory)
    .filter((entry) => entry.endsWith(".jsonl"))
    .flatMap((entry) => fs.readFileSync(path.join(metricsDirectory, entry), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
}

test("WP4-ALLOWLIST-01: writer yalnız explicit execution allowlist alanlarını yazar", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp4-allowlist-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await appendRedactedRunMetric(config, executionMetric({
    prompt: "PROMPT_SENTINEL",
    stdout: "STDOUT_SENTINEL",
    stderr: "STDERR_SENTINEL",
    output: "OUTPUT_SENTINEL",
    workspacePath: "WORKSPACE_PATH_SENTINEL",
    executionId: "EXECUTION_ID_SENTINEL",
    taskId: "TASK_ID_SENTINEL",
    apiKey: "API_KEY_SENTINEL",
    url: "URL_SENTINEL"
  }));
  const [record] = readMetricRecords(config);
  const serialized = JSON.stringify(record);
  for (const sentinel of ["PROMPT_SENTINEL", "STDOUT_SENTINEL", "STDERR_SENTINEL", "OUTPUT_SENTINEL", "WORKSPACE_PATH_SENTINEL", "EXECUTION_ID_SENTINEL", "TASK_ID_SENTINEL", "API_KEY_SENTINEL", "URL_SENTINEL"]) {
    assert.equal(serialized.includes(sentinel), false);
  }
  assert.deepEqual(Object.keys(record).sort(), [
    "attempts", "backend", "cacheHit", "executionIdHash", "failureClass", "failureStage", "mode", "modelHash",
    "outcomeStatus", "profile", "providerCode", "queueWaitMs", "recordedAt", "retries", "retryStopReason",
    "schemaVersion", "usage", "workspaceHash"
  ]);
  assert.deepEqual(Object.keys(record.attempts[0]).sort(), [
    "durationMs", "exitCode", "failureClass", "failureStage", "number", "providerCode", "providerExecutionMs",
    "retryDecision", "retryStopReason", "settingsLockWaitMs", "signal", "stderrBucket", "stdoutBucket", "totalCostUsd"
  ]);
});

test("WP4-ALLOWLIST-02: geçersiz enum ve serbest metin kapalı değerlere normalize edilir", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp4-normalize-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await appendRedactedRunMetric(config, executionMetric({
    failureClass: "raw failure with spaces",
    failureStage: "PROMPT_STAGE_SENTINEL",
    providerCode: "sk_live_PROVIDER_SENTINEL",
    retryStopReason: "because provider said so",
    attempts: [executionAttempt({
      failureClass: "raw failure with spaces",
      failureStage: "raw stage",
      providerCode: 42,
      signal: "SIGFAKE",
      retryDecision: "maybe",
      retryStopReason: "raw reason",
      stdoutBucket: "huge"
    })]
  }));
  const [record] = readMetricRecords(config);
  assert.equal(record.failureClass, "unclassified_failure");
  assert.equal(record.failureStage, null);
  assert.equal(record.providerCode, "unclassified");
  assert.equal(record.retryStopReason, null);
  assert.equal(record.attempts[0].failureStage, null);
  assert.equal(record.attempts[0].providerCode, "unclassified");
  assert.equal(record.attempts[0].signal, null);
  assert.equal(record.attempts[0].retryDecision, "not_applicable");
  assert.equal(record.attempts[0].retryStopReason, null);
  assert.equal(record.attempts[0].stdoutBucket, null);
  const serialized = JSON.stringify(record);
  for (const sentinel of ["raw failure with spaces", "PROMPT_STAGE_SENTINEL", "sk_live_PROVIDER_SENTINEL", "because provider said so", "raw stage", "raw reason"]) {
    assert.equal(serialized.includes(sentinel), false);
  }
});

test("WP4-ROUNDTRIP-03: v2 metric son attempt tanısını gösterir, attempt dizisini göstermez", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp4-roundtrip-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const result = {
    ok: false,
    backend: "antigravity",
    model: "gemini-3.8-flash-high",
    resolvedModel: "gemini-3.8-flash-high",
    result: null,
    error: "process exited with code 1",
    reason: "mutation_state_unknown",
    exitCode: 1,
    durationMs: 400,
    metrics: {
      retries: 1,
      totalCostUsd: null,
      attempts: [
        executionAttempt({ number: 1, retryDecision: "retry", retryStopReason: null, totalCostUsd: 0 }),
        executionAttempt({ number: 2 })
      ]
    }
  };
  const metric = createRedactedExecutionMetric({
    executionId: "RAW_EXECUTION_ID",
    workspace: path.join(root, "workspace"),
    mode: "edit",
    profile: "review",
    result
  });
  assert.equal(metric.schemaVersion, 2);
  assert.equal(metric.failureClass, "process_exit");
  assert.equal(metric.retryStopReason, "mutation_state_unknown");
  await appendRedactedRunMetric(config, metric);
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 1);
  const run = view.runs[0];
  assert.equal(run.failureClass, "process_exit");
  assert.equal(run.retryStopReason, "mutation_state_unknown");
  assert.equal(run.failureStage, "provider_execution");
  assert.equal(run.providerCode, "process_exit");
  assert.equal(run.exitCode, 1);
  assert.equal(run.mode, "edit");
  assert.equal(run.retries, 1);
  assert.equal(Object.hasOwn(run, "attempts"), false);
  const [record] = readMetricRecords(config);
  assert.equal(record.attempts.length, 2);
  assert.equal(record.attempts[1].retryStopReason, "mutation_state_unknown");
  assert.equal(JSON.stringify(record).includes("RAW_EXECUTION_ID"), false);
  assert.equal(JSON.stringify(record).includes(path.join(root, "workspace")), false);
});

test("WP4-MIRROR-04: mirror sanitized kaydı alır ve sentinel sızdırmaz", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp4-mirror-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root, workspace);
  await enableProjectMirror(config, workspace, { nonGitWrite: true });
  await appendRedactedRunMetric(config, executionMetric({
    prompt: "PROMPT_SENTINEL",
    executionId: "RAW_EXECUTION_SENTINEL",
    workspaceHash: hash(workspace)
  }), { workspace });
  const raw = fs.readFileSync(path.join(workspace, ".hades", "runs.jsonl"), "utf8");
  assert.equal(raw.includes("PROMPT_SENTINEL"), false);
  assert.equal(raw.includes("RAW_EXECUTION_SENTINEL"), false);
  assert.equal(raw.includes(workspace), false);
  const view = readProjectMirror(config, workspace);
  assert.equal(view.runCount, 1);
  assert.equal(view.runs[0].failureClass, "process_exit");
});

test("WP4-CLASSIFY-05: process_exit ve sınıflandırılamayan failureClass ayrı raporlanır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp4-classify-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await appendRedactedRunMetric(config, executionMetric({ executionIdHash: hash("process-exit") }));
  await appendRedactedRunMetric(config, executionMetric({ executionIdHash: hash("unclassified"), failureClass: "free text failure", attempts: [] }));
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 2);
  const processExitRun = view.runs.find((run) => run.failureClass === "process_exit");
  const unclassifiedRun = view.runs.find((run) => run.failureClass === "unclassified_failure");
  assert.ok(processExitRun);
  assert.ok(unclassifiedRun);
  assert.equal(processExitRun.providerCode, "process_exit");
});

test("WP4-LEGACY-06: v2 kayıtlar v1 kayıtlarla birlikte okunur", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp4-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const metricsDirectory = path.join(config.statePaths.logs, "metrics");
  fs.mkdirSync(metricsDirectory, { recursive: true });
  const v1 = {
    recordedAt: new Date(Date.now() - 60000).toISOString(),
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
    cacheHit: false
  };
  fs.writeFileSync(path.join(metricsDirectory, "codex-runs.jsonl"), `${JSON.stringify(v1)}\n`, "utf8");
  await appendRedactedRunMetric(config, executionMetric({ executionIdHash: hash("v2-execution") }));
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 2);
  const v1Run = view.runs.find((run) => run.failureClass === null);
  const v2Run = view.runs.find((run) => run.failureClass === "process_exit");
  assert.ok(v1Run);
  assert.ok(v2Run);
  assert.equal(v1Run.failureStage, null);
  assert.equal(v2Run.failureStage, "provider_execution");
});

test("WP4-BUCKETS-07: boyut kovaları ve enum normalizasyonu sınırlarda çalışır", () => {
  assert.equal(outputSizeBucket(0), "empty");
  assert.equal(outputSizeBucket(1), "lte_1_kib");
  assert.equal(outputSizeBucket(1024), "lte_1_kib");
  assert.equal(outputSizeBucket(1025), "lte_64_kib");
  assert.equal(outputSizeBucket(65536), "lte_64_kib");
  assert.equal(outputSizeBucket(65537), "lte_1_mib");
  assert.equal(outputSizeBucket(1048576), "lte_1_mib");
  assert.equal(outputSizeBucket(1048577), "gt_1_mib");
  assert.equal(outputSizeBucket(null), null);
  assert.equal(normalizeOutputSizeBucket("huge"), null);
  assert.equal(normalizeProcessSignal("SIGTERM"), "SIGTERM");
  assert.equal(normalizeProcessSignal("SIGFAKE"), null);
  assert.equal(normalizeFailureStage("provider_execution"), "provider_execution");
  assert.equal(normalizeFailureStage("raw"), null);
  assert.equal(normalizeProviderCode("rate_limited"), "rate_limited");
  assert.equal(normalizeProviderCode("raw"), "unclassified");
  assert.equal(normalizeProviderCode(null), null);
  assert.equal(normalizeRetryDecision("retry"), "retry");
  assert.equal(normalizeRetryDecision("maybe"), "not_applicable");
  assert.equal(normalizeRetryStopReason("mutation_state_unknown"), "mutation_state_unknown");
  assert.equal(normalizeRetryStopReason("raw"), null);
});

test("WP4-CONSISTENCY-08: writer top-level tanıyı ve retries değerini son attempt'ten türetir", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp4-consistency-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await appendRedactedRunMetric(config, executionMetric({
    failureClass: "timeout",
    failureStage: "settings_lock",
    providerCode: "timeout",
    retryStopReason: null,
    retries: 9,
    attempts: [
      executionAttempt({ number: 1, failureClass: "network", failureStage: "provider_execution", providerCode: "connection_reset", retryDecision: "retry", retryStopReason: null }),
      executionAttempt({ number: 2, failureClass: "process_exit", failureStage: "provider_execution", providerCode: "process_exit", retryDecision: "stop", retryStopReason: "non_retryable_failure_class" })
    ]
  }));
  await appendRedactedRunMetric(config, executionMetric({
    recordedAt: new Date(Date.now() - 1000).toISOString(),
    executionIdHash: hash("completed"),
    outcomeStatus: "completed",
    failureClass: "timeout",
    failureStage: "settings_lock",
    providerCode: "timeout",
    retryStopReason: "mutation_state_unknown",
    attempts: [executionAttempt({ failureClass: null })]
  }));
  await appendRedactedRunMetric(config, executionMetric({
    recordedAt: new Date(Date.now() - 2000).toISOString(),
    executionIdHash: hash("null-diagnosis"),
    failureClass: "process_exit",
    failureStage: "provider_execution",
    providerCode: "process_exit",
    retryStopReason: "mutation_state_unknown",
    attempts: [executionAttempt({
      failureClass: "process_error",
      failureStage: null,
      providerCode: null,
      retryDecision: "stop",
      retryStopReason: "non_retryable_failure_class"
    })]
  }));
  const records = readMetricRecords(config);
  const failedRecord = records.find((record) => record.executionIdHash === hash("execution"));
  const completedRecord = records.find((record) => record.outcomeStatus === "completed");
  const nullDiagnosisRecord = records.find((record) => record.executionIdHash === hash("null-diagnosis"));
  assert.equal(failedRecord.failureClass, "process_exit");
  assert.equal(failedRecord.failureStage, "provider_execution");
  assert.equal(failedRecord.providerCode, "process_exit");
  assert.equal(failedRecord.retryStopReason, "non_retryable_failure_class");
  assert.equal(failedRecord.retries, 1);
  assert.equal(completedRecord.failureClass, null);
  assert.equal(completedRecord.failureStage, null);
  assert.equal(completedRecord.providerCode, null);
  assert.equal(completedRecord.retryStopReason, null);
  assert.equal(nullDiagnosisRecord.failureClass, "process_error");
  assert.equal(nullDiagnosisRecord.failureStage, null);
  assert.equal(nullDiagnosisRecord.providerCode, null);
  assert.equal(nullDiagnosisRecord.retryStopReason, "non_retryable_failure_class");
});

test("WP4-FEEDBACK-09: writer geçersiz feedback outcome ve hash değerini reddeder", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp4-feedback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await assert.rejects(() => appendRedactedRunMetric(config, {
    recordType: "direct_edit_feedback",
    recordedAt: new Date().toISOString(),
    backend: "direct-edit-baseline",
    executionIdHash: hash("execution"),
    outcome: "RAW_SECRET_OUTCOME"
  }), /invalid feedback outcome/);
  await assert.rejects(() => appendRedactedRunMetric(config, {
    recordType: "routing_feedback",
    recordedAt: new Date().toISOString(),
    backend: "routing-evaluation",
    executionIdHash: "not-a-hash",
    outcome: "useful"
  }), /invalid feedback execution id hash/);
  assert.equal(fs.existsSync(path.join(config.statePaths.logs, "metrics", "direct-edit-baseline-runs.jsonl")), false);
  assert.equal(fs.existsSync(path.join(config.statePaths.logs, "metrics", "routing-evaluation-runs.jsonl")), false);
});

test("WP4-HEALTH-10: health snapshot version yalnız sürüm desenini saklar", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp4-health-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await appendRedactedRunMetric(config, {
    recordType: "health_snapshot",
    recordedAt: new Date().toISOString(),
    backend: "bridge-health",
    adapters: {
      antigravity: { installed: true, version: "Antigravity CLI 1.2.3-SECRET_VERSION_MARKER", authValid: null, error: null },
      codex: { installed: true, version: "codex-cli 0.153.4", authValid: true, error: null },
      claude_code: { installed: false, version: "sk_live_SECRET_TOKEN", authValid: false, error: "unavailable" }
    }
  });
  const [record] = readMetricRecords(config);
  assert.equal(record.adapters.antigravity.version, "1.2.3");
  assert.equal(record.adapters.codex.version, "0.153.4");
  assert.equal(record.adapters.claude_code.version, null);
  assert.equal(JSON.stringify(record).includes("SECRET"), false);
});

test("WP4-LEGACY-11: writer legacy DeepSeek alanlarını korur", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp4-legacy-writer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await appendRedactedRunMetric(config, {
    recordedAt: new Date(Date.now() - 60000).toISOString(),
    backend: "deepseek",
    runIdHash: hash("legacy-run"),
    taskIdHash: hash("legacy-task"),
    agent: "deepseek",
    role: "reviewer",
    modelHash: hash("deepseek-v4-pro"),
    outcomeStatus: "completed",
    failureClass: null,
    usage: { durationMs: 500, totalCostUsd: 0.001 },
    attempts: [{ number: 1, failureClass: null, exitCode: 0, durationMs: 500, apiDurationMs: null, turns: null, totalCostUsd: 0.001, retryDelayMs: null }]
  });
  const view = readRecentRuns(config);
  assert.equal(view.runCount, 1);
  assert.equal(view.runs[0].role, "reviewer");
  assert.equal(view.runs[0].mode, "not_applicable");
  const [record] = readMetricRecords(config);
  assert.equal(record.taskIdHash, hash("legacy-task"));
  assert.equal(record.agent, "deepseek");
  assert.equal(record.backend, "deepseek");
});
