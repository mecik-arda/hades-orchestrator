import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendRedactedRunMetric } from "../subagent-bridge/src/metrics.js";

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function configuration(root) {
  return {
    statePaths: { logs: path.join(root, "logs") },
    observability: { maxMetricFileBytes: 16 * 1024 * 1024 }
  };
}

function readAllMetrics(root) {
  const metricsDirectory = path.join(root, "logs", "metrics");
  if (!fs.existsSync(metricsDirectory)) return "";
  return fs.readdirSync(metricsDirectory)
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => fs.readFileSync(path.join(metricsDirectory, entry), "utf8"))
    .join("\n");
}

function executionMetricV2(overrides = {}) {
  return {
    schemaVersion: 2,
    recordedAt: new Date().toISOString(),
    backend: "antigravity",
    modelHash: hash("model"),
    executionIdHash: hash("execution"),
    workspaceHash: hash("workspace"),
    mode: "read_only",
    profile: "review",
    outcomeStatus: "failed",
    failureClass: "process_exit",
    failureStage: "provider_execution",
    providerCode: "process_exit",
    retryStopReason: "mutation_state_unknown",
    usage: { durationMs: 100, totalCostUsd: null },
    attempts: [],
    retries: 0,
    queueWaitMs: 0,
    cacheHit: false,
    ...overrides
  };
}

const forbiddenSentinels = {
  prompt: "PROMPT_SENTINEL",
  stdout: "STDOUT_SENTINEL",
  stderr: "STDERR_SENTINEL",
  output: "OUTPUT_SENTINEL",
  toolOutput: "TOOL_OUTPUT_SENTINEL",
  url: "URL_SENTINEL",
  workspacePath: "WORKSPACE_PATH_SENTINEL",
  executionId: "EXECUTION_ID_SENTINEL",
  taskId: "TASK_ID_SENTINEL",
  apiKey: "API_KEY_SENTINEL",
  token: "TOKEN_SENTINEL",
  secret: "SECRET_SENTINEL"
};

test("ADV-01: her kayıt türünde yasak anahtarlar serileşmez", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv-01-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await appendRedactedRunMetric(config, executionMetricV2(forbiddenSentinels));
  await appendRedactedRunMetric(config, { backend: "codex", recordedAt: new Date().toISOString(), ...forbiddenSentinels });
  await appendRedactedRunMetric(config, {
    recordType: "health_snapshot",
    recordedAt: new Date().toISOString(),
    backend: "bridge-health",
    adapters: { antigravity: { installed: true, version: "1.2.3", authValid: null, error: null, ...forbiddenSentinels } },
    ...forbiddenSentinels
  });
  await appendRedactedRunMetric(config, {
    recordType: "direct_edit_feedback",
    recordedAt: new Date().toISOString(),
    backend: "direct-edit-baseline",
    executionIdHash: hash("feedback"),
    outcome: "accepted",
    ...forbiddenSentinels
  });
  await appendRedactedRunMetric(config, {
    recordType: "routing_feedback",
    recordedAt: new Date().toISOString(),
    backend: "routing-evaluation",
    executionIdHash: hash("routing"),
    outcome: "useful",
    ...forbiddenSentinels
  });
  const serialized = readAllMetrics(root);
  for (const sentinel of Object.values(forbiddenSentinels)) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
});

test("ADV-02: getter ve toJSON tuzakları çalışmaz", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv-02-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  let getterInvoked = false;
  const hostile = executionMetricV2();
  Object.defineProperty(hostile, "dangerous", {
    enumerable: true,
    get() {
      getterInvoked = true;
      throw new Error("getter trap");
    }
  });
  hostile.toJSON = () => ({ leaked: "TOJSON_SENTINEL" });
  await appendRedactedRunMetric(config, hostile);
  assert.equal(getterInvoked, false);
  const serialized = readAllMetrics(root);
  assert.equal(serialized.includes("TOJSON_SENTINEL"), false);
  const record = JSON.parse(serialized.trim());
  assert.deepEqual(Object.keys(record).sort(), [
    "attempts", "backend", "cacheHit", "executionIdHash", "failureClass", "failureStage", "mode", "modelHash",
    "outcomeStatus", "profile", "providerCode", "queueWaitMs", "recordedAt", "retries", "retryStopReason",
    "schemaVersion", "usage", "workspaceHash"
  ]);
});

test("ADV-03: kalıtılan alanlar kayıt yönlendirmesini ve içeriği etkilemez", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv-03-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const hostile = executionMetricV2();
  Object.setPrototypeOf(hostile, { inheritedSecret: "INHERITED_SENTINEL", recordType: "health_snapshot" });
  await appendRedactedRunMetric(config, hostile);
  const serialized = readAllMetrics(root);
  assert.equal(serialized.includes("INHERITED_SENTINEL"), false);
  assert.equal(Object.hasOwn({}, "inheritedSecret"), false);
  const entries = fs.readdirSync(path.join(root, "logs", "metrics"));
  assert.equal(entries.includes("health_snapshot-runs.jsonl"), false);
  assert.equal(entries.includes("antigravity-runs.jsonl"), true);
});

test("ADV-04: döngüsel ve derin yapılar yazımı bozmaz", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv-04-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const hostile = executionMetricV2({
    attempts: [{ number: 1, failureClass: "process_exit", durationMs: 1, totalCostUsd: null }]
  });
  hostile.usage.self = hostile;
  hostile.attempts[0].self = hostile.attempts[0];
  hostile.deep = { a: { b: {} } };
  hostile.deep.a.b.loop = hostile.deep;
  await appendRedactedRunMetric(config, hostile);
  const record = JSON.parse(readAllMetrics(root).trim());
  assert.equal(record.attempts.length, 1);
  assert.equal(record.attempts[0].failureClass, "process_exit");
  assert.equal(Object.hasOwn(record.attempts[0], "self"), false);
  assert.equal(Object.hasOwn(record.usage, "self"), false);
});

test("ADV-05: BigInt Symbol ve fonksiyon değerleri güvenli normalize edilir", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv-05-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await appendRedactedRunMetric(config, executionMetricV2({
    failureClass: 10n,
    failureStage: Symbol("stage"),
    providerCode: () => "process_exit",
    retryStopReason: { toString: () => "mutation_state_unknown" },
    attempts: []
  }));
  await appendRedactedRunMetric(config, executionMetricV2({
    executionIdHash: hash("attempt-hazards"),
    attempts: [{ number: 1, failureClass: Symbol("fc"), exitCode: 3n, signal: Symbol("sig"), durationMs: 1, totalCostUsd: null }]
  }));
  const serialized = readAllMetrics(root);
  const records = serialized.trim().split("\n").map((line) => JSON.parse(line));
  const topLevel = records.find((record) => record.executionIdHash === hash("execution"));
  const attemptLevel = records.find((record) => record.executionIdHash === hash("attempt-hazards"));
  assert.equal(topLevel.failureClass, "unclassified_failure");
  assert.equal(topLevel.failureStage, null);
  assert.equal(topLevel.providerCode, "unclassified");
  assert.equal(topLevel.retryStopReason, null);
  assert.equal(attemptLevel.failureClass, "unclassified_failure");
  assert.equal(attemptLevel.attempts[0].failureClass, "unclassified_failure");
  assert.equal(attemptLevel.attempts[0].exitCode, null);
  assert.equal(attemptLevel.attempts[0].signal, null);
});

test("ADV-06: allowlist alanlarındaki JSON injection ek alan oluşturamaz", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv-06-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const hostile = executionMetricV2({
    recordedAt: "2026-01-01T00:00:00.000Z\",\"prompt\":\"INJECTION_SENTINEL",
    failureClass: "x\",\"recordType\":\"health_snapshot",
    profile: "review\",\"secret\":\"PROFILE_SENTINEL"
  });
  await appendRedactedRunMetric(config, hostile);
  const serialized = readAllMetrics(root);
  assert.equal(serialized.includes("INJECTION_SENTINEL"), false);
  assert.equal(serialized.includes("PROFILE_SENTINEL"), false);
  const record = JSON.parse(serialized.trim());
  assert.equal(Object.hasOwn(record, "recordType"), false);
  assert.equal(Object.hasOwn(record, "prompt"), false);
  assert.equal(Object.hasOwn(record, "secret"), false);
  assert.equal(record.failureClass, "unclassified_failure");
  assert.equal(record.profile, null);
  assert.notEqual(record.recordedAt, hostile.recordedAt);
});

test("ADV-07: uzunluk ve dizi sınırları uygulanır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv-07-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const longToken = "a".repeat(65);
  const attempts = Array.from({ length: 130 }, (_, index) => ({
    number: index + 1,
    failureClass: "process_exit",
    durationMs: 1,
    totalCostUsd: null
  }));
  await appendRedactedRunMetric(config, executionMetricV2({ executionIdHash: hash("bounded"), attempts }));
  await appendRedactedRunMetric(config, executionMetricV2({
    executionIdHash: hash("token"),
    failureClass: longToken,
    profile: longToken,
    attempts: []
  }));
  const records = readAllMetrics(root).trim().split("\n").map((line) => JSON.parse(line));
  const bounded = records.find((record) => record.executionIdHash === hash("bounded"));
  const token = records.find((record) => record.executionIdHash === hash("token"));
  assert.equal(bounded.attempts.length, 100);
  assert.equal(token.failureClass, "unclassified_failure");
  assert.equal(token.profile, null);
});

test("ADV-08: serbest metin provider code stage ve signal alanlarına kopyalanamaz", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv-08-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await appendRedactedRunMetric(config, executionMetricV2({
    failureStage: "PROMPT_STAGE_SENTINEL",
    providerCode: "sk-live-PROVIDER_SENTINEL",
    retryStopReason: "because provider said so",
    attempts: [],
    retries: 1
  }));
  await appendRedactedRunMetric(config, executionMetricV2({
    executionIdHash: hash("signal"),
    attempts: [{ number: 1, failureClass: "process_exit", signal: "SIGTERM_SECRET", durationMs: 1, totalCostUsd: null }]
  }));
  const serialized = readAllMetrics(root);
  for (const sentinel of ["PROMPT_STAGE_SENTINEL", "sk-live-PROVIDER_SENTINEL", "because provider said so", "SIGTERM_SECRET"]) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
  const records = serialized.trim().split("\n").map((line) => JSON.parse(line));
  const first = records.find((record) => record.executionIdHash === hash("execution"));
  const second = records.find((record) => record.executionIdHash === hash("signal"));
  assert.equal(first.failureStage, null);
  assert.equal(first.providerCode, "unclassified");
  assert.equal(first.retryStopReason, null);
  assert.equal(second.attempts[0].signal, null);
});

test("ADV-09: recordedAt yalnız ISO-8601 kabul eder", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv-09-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const validRecordedAt = new Date("2026-01-02T03:04:05.678Z").toISOString();
  await appendRedactedRunMetric(config, executionMetricV2({ recordedAt: "RAW_RECORDED_AT_SENTINEL" }));
  await appendRedactedRunMetric(config, executionMetricV2({ executionIdHash: hash("iso"), recordedAt: validRecordedAt }));
  const serialized = readAllMetrics(root);
  assert.equal(serialized.includes("RAW_RECORDED_AT_SENTINEL"), false);
  const records = serialized.trim().split("\n").map((line) => JSON.parse(line));
  const raw = records.find((record) => record.executionIdHash === hash("execution"));
  const iso = records.find((record) => record.executionIdHash === hash("iso"));
  assert.match(raw.recordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(iso.recordedAt, validRecordedAt);
});

test("ADV-10: v1 execution yolu da allowlist dışına çıkamaz", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv-10-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  await appendRedactedRunMetric(config, {
    backend: "codex",
    recordedAt: "RAW_TIME_SENTINEL",
    failureClass: "raw failure text",
    profile: "review",
    prompt: "PROMPT_SENTINEL",
    modelHash: "not-a-hash",
    attempts: [{ number: 1, failureClass: "ok", extra: "EXTRA_SENTINEL" }]
  });
  const serialized = readAllMetrics(root);
  assert.equal(serialized.includes("PROMPT_SENTINEL"), false);
  assert.equal(serialized.includes("EXTRA_SENTINEL"), false);
  assert.equal(serialized.includes("RAW_TIME_SENTINEL"), false);
  const record = JSON.parse(serialized.trim());
  assert.equal(record.failureClass, "unclassified_failure");
  assert.equal(Object.hasOwn(record, "modelHash"), false);
  assert.equal(Object.hasOwn(record.attempts[0], "extra"), false);
  assert.match(record.recordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
