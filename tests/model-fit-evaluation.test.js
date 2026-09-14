import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateModelFit, runLiveModelFitEvaluation, validateLiveModelFitDataset, validateModelFitEvaluationDataset } from "../subagent-bridge/src/model-fit-evaluation.js";
import { appendRedactedRunMetric } from "../subagent-bridge/src/metrics.js";
import { summarizeMetrics } from "../scripts/report-metrics.js";

const fixturePath = path.join(process.cwd(), "config", "model-fit-evaluation.json");

function readFixture() {
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

function metricConfiguration(root) {
  return {
    statePaths: { logs: path.join(root, "logs") },
    observability: { maxMetricFileBytes: 1024 * 1024 }
  };
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("WP3 fixture evaluator üç tekrar, rol eşleşmesi ve önceden tanımlı eşikleri uygular", () => {
  const dataset = readFixture();
  const validation = validateModelFitEvaluationDataset(dataset);
  assert.equal(validation.success, true);
  const report = evaluateModelFit(dataset, { evaluatedAt: "2026-09-12T00:00:00.000Z" });
  assert.equal(report.taskCount, 6);
  assert.equal(report.runCount, 18);
  assert.equal(report.candidateCount, 6);
  assert.equal(report.evidenceType, "synthetic_fixture");
  assert.equal(report.decisionReady, true);
  assert.equal(report.promotionEligible, false);
  assert.equal(report.candidates.find((candidate) => candidate.candidate === "sol").schemaPassRate, 0.6667);
  assert.equal(report.candidates.find((candidate) => candidate.candidate === "terra").editReadinessRate, 1);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].reason, "schema_failure");
});

test("WP3 dataset aday-görev politikasını ve minimum tekrar sayısını reddeder", () => {
  const dataset = readFixture();
  dataset.tasks[0].candidate = "sol";
  dataset.tasks[1].repetitions = dataset.tasks[1].repetitions.slice(0, 2);
  const validation = validateModelFitEvaluationDataset(dataset);
  assert.equal(validation.success, false);
  assert.throws(() => evaluateModelFit(dataset), /candidate is not allowed|minimum repetitions not met/);
});

test("WP3 dataset tekrar kimliklerinin tekrar kullanılmasını reddeder", () => {
  const dataset = readFixture();
  dataset.tasks[0].repetitions[2].repetition = dataset.tasks[0].repetitions[1].repetition;
  const validation = validateModelFitEvaluationDataset(dataset);
  assert.equal(validation.success, false);
  assert.throws(() => evaluateModelFit(dataset), /repetition ids must be unique/);
});

test("WP3 metric yalnız redacted değerlendirme alanlarını yazar", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp3-metric-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = metricConfiguration(root);
  await appendRedactedRunMetric(configuration, {
    recordType: "model_fit_evaluation",
    recordedAt: "2026-09-12T00:00:00.000Z",
    backend: "model-fit-evaluation",
    fixtureVersion: "2026-09-12-v1",
    taskClass: "sourced_analysis",
    modelHash: hash("deepseek_pro"),
    repetitionCount: 3,
    schemaPassRate: 1,
    sourceAccuracy: 0.99,
    failureClassificationAccuracy: 1,
    editReadinessRate: null,
    averageDurationMs: 1000,
    p95DurationMs: 1200,
    averageCostUsd: 0.003,
    thresholdsPassed: true,
    prompt: "PROMPT_SENTINEL",
    output: "OUTPUT_SENTINEL",
    workspacePath: "WORKSPACE_SENTINEL",
    taskId: "TASK_SENTINEL",
    apiKey: "SECRET_SENTINEL"
  });
  const metricPath = path.join(root, "logs", "metrics", "model-fit-evaluation-runs.jsonl");
  const [record] = fs.readFileSync(metricPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(Object.keys(record).sort(), [
    "averageCostUsd", "averageDurationMs", "backend", "coverageComplete", "editReadinessRate", "evidenceType",
    "failureClassificationAccuracy", "fixtureVersion", "identityAssurance", "modelHash", "p95DurationMs", "promotionEligible",
    "recordType", "recordedAt", "repetitionCount", "schemaPassRate", "sourceAccuracy", "taskClass", "thresholdsPassed"
  ]);
  assert.equal(JSON.stringify(record).includes("SENTINEL"), false);
  assert.equal(record.fixtureVersion, "2026-09-12-v1");
  const summary = summarizeMetrics([record]);
  assert.equal(summary.modelFitEvaluation.observationCount, 1);
  assert.equal(summary.modelFitEvaluation.byTaskClass.sourced_analysis.observationCount, 1);
  assert.equal(summary.modelFitEvaluation.byTaskClass.sourced_analysis.candidates[hash("deepseek_pro")].promotionEligible, false);
});

function liveDataset(overrides = {}) {
  return {
    schemaVersion: 1,
    fixtureVersion: "2026-09-13-live-v1",
    minimumRepetitions: 3,
    thresholds: {
      schemaPassRate: 1,
      sourceAccuracy: 1,
      failureClassificationAccuracy: 1,
      maxP95DurationMs: 10000,
      maxAverageCostUsd: 1,
      editReadinessRate: 1
    },
    tasks: [{
      id: "live-schema-task",
      taskClass: "strict_schema",
      candidate: "deepseek_pro",
      target: "opencode",
      model: "deepseek/deepseek-v4-pro",
      prompt: "Return only a JSON object.",
      expected: { json: true, jsonKeys: ["status"], jsonShape: { status: "string" }, allowExtraKeys: true, sourceMarker: "LIVE-MARKER-1" }
    }],
    ...overrides
  };
}

function fullLiveDataset() {
  const task = (id, taskClass, candidate, extra = {}) => ({
    id,
    taskClass,
    candidate,
    target: candidate === "gemini_flash" ? "gemini_flash" : candidate === "deepseek_pro" ? "opencode" : "codex",
    ...(candidate === "sol" ? { model: "gpt-5.6-sol" } : candidate === "deepseek_pro" ? { model: "deepseek/deepseek-v4-pro" } : candidate === "gemini_flash" ? { model: "gemini_flash" } : candidate === "luna" ? { model: "gpt-5.6-luna" } : { model: "gpt-5.6-terra" }),
    prompt: "Return only a JSON object.",
    expected: { json: true, jsonKeys: ["status"], jsonShape: { status: "string" }, allowExtraKeys: true },
    ...extra
  });
  const editContract = { files: ["src/value.txt"], contextFiles: [], acceptanceCriteria: ["change the value"] };
  return liveDataset({
    tasks: [
      task("live-candidate-generation", "candidate_generation", "gemini_flash", { expected: { json: true, jsonKeys: ["candidates"], jsonShape: { candidates: "array" }, allowExtraKeys: true } }),
      task("live-sourced-analysis", "sourced_analysis", "deepseek_pro", { expected: { json: true, jsonKeys: ["status"], jsonShape: { status: "string" }, allowExtraKeys: true, sourceMarker: "LIVE-MARKER-1" } }),
      task("live-strict-schema", "strict_schema", "deepseek_pro"),
      task("live-edit-readiness", "controlled_edit_readiness", "deepseek_pro", { edit: editContract }),
      task("live-edit-readiness-luna", "controlled_edit_readiness", "luna", { edit: editContract, profile: "luna_implementation" }),
      task("live-edit-readiness-terra", "controlled_edit_readiness", "terra", { edit: editContract, profile: "implementation" }),
      task("live-critical-review", "critical_review", "sol")
    ]
  });
}

function resolvedModelFor(candidate) {
  if (candidate === "gemini_flash") return "gemini-3.8-flash-high";
  if (candidate === "sol") return "gpt-5.6-sol";
  if (candidate === "luna") return "gpt-5.6-luna";
  if (candidate === "terra") return "gpt-5.6-terra";
  return "deepseek/deepseek-v4-pro";
}

function buildJsonOutput(task) {
  const keys = task.expected?.jsonKeys || [];
  const shape = task.expected?.jsonShape || {};
  const payload = {};
  for (const key of keys) {
    if (shape[key] === "array") payload[key] = ["LIVE-MARKER-1"];
    else if (shape[key] === "number") payload[key] = 1;
    else if (shape[key] === "boolean") payload[key] = false;
    else if (shape[key] === "null") payload[key] = null;
    else payload[key] = key === "status" ? "completed" : "LIVE-MARKER-1";
  }
  payload.marker = "LIVE-MARKER-1";
  return JSON.stringify(payload);
}

test("WP3-LIVE-01: canli olcum kosu sonuclarini live_observation olarak isaretler", async () => {
  const dataset = fullLiveDataset();
  assert.equal(validateLiveModelFitDataset(dataset).success, true);
  const report = await runLiveModelFitEvaluation({
    dataset,
    evaluatedAt: "2026-09-13T00:00:00.000Z",
    executeTask: async ({ task }) => ({ output: buildJsonOutput(task), resolvedModel: resolvedModelFor(task.candidate), failureClass: "none", durationMs: 100, costUsd: 0.001, editReady: true })
  });
  assert.equal(report.evidenceType, "live_observation");
  assert.equal(report.coverageComplete, true);
  assert.equal(report.runCount, 21);
  assert.equal(report.decisionReady, true);
  assert.equal(report.promotionEligible, true);
  assert.equal(report.candidates.every((candidate) => candidate.identityAssurance === "configured"), true);
  assert.equal(report.candidates.find((candidate) => candidate.taskClass === "strict_schema").schemaPassRate, 1);

  const partial = await runLiveModelFitEvaluation({
    dataset: liveDataset(),
    executeTask: async ({ task }) => ({ output: buildJsonOutput(task), resolvedModel: resolvedModelFor(task.candidate), failureClass: "none", durationMs: 100, costUsd: 0.001 })
  });
  assert.equal(partial.coverageComplete, false);
  assert.equal(partial.promotionEligible, false);

  const mismatch = await runLiveModelFitEvaluation({
    dataset,
    executeTask: async ({ task }) => ({
      output: buildJsonOutput(task),
      resolvedModel: task.candidate === "gemini_flash" ? "gemini-3.1-pro-high" : resolvedModelFor(task.candidate),
      failureClass: "none",
      durationMs: 100,
      costUsd: 0.001,
      editReady: true
    })
  });
  assert.equal(mismatch.modelsBound, false);
  assert.equal(mismatch.promotionEligible, false);
  assert.equal(mismatch.candidates.find((candidate) => candidate.candidate === "gemini_flash").boundModel, null);
  assert.equal(mismatch.candidates.find((candidate) => candidate.candidate === "gemini_flash").identityAssurance, "unresolved");
});

test("WP3-LIVE-02: basarisiz sema ve kaynak eslesmesi promotion'u kapatir", async () => {
  const report = await runLiveModelFitEvaluation({
    dataset: liveDataset(),
    executeTask: async () => ({ output: "not json", failureClass: "none", durationMs: 100, costUsd: 0.001 })
  });
  assert.equal(report.evidenceType, "live_observation");
  assert.equal(report.decisionReady, false);
  assert.equal(report.promotionEligible, false);
  assert.equal(report.candidates[0].checks.schemaPassRate, false);
  assert.equal(report.failures.filter((failure) => failure.reason === "schema_failure").length, 3);
});

test("WP3-LIVE-03: hata siniflandirmasi ve gecersiz dataset dogrulanir", async () => {
  const dataset = liveDataset({
    thresholds: { schemaPassRate: 0, sourceAccuracy: 1, failureClassificationAccuracy: 1, maxP95DurationMs: 10000, maxAverageCostUsd: 1, editReadinessRate: 1 },
    tasks: [{
      id: "live-rate-limit-task",
      taskClass: "strict_schema",
      candidate: "deepseek_pro",
      target: "opencode",
      model: "deepseek/deepseek-v4-pro",
      prompt: "Return only a JSON object.",
      expected: { json: true, jsonKeys: ["status"], jsonShape: { status: "string" }, failureClass: "rate_limited" }
    }]
  });
  const report = await runLiveModelFitEvaluation({
    dataset,
    executeTask: async () => ({ output: "", resolvedModel: "deepseek/deepseek-v4-pro", failureClass: "rate_limited", durationMs: 50, costUsd: 0 })
  });
  assert.equal(report.candidates[0].failureClassificationAccuracy, 1);
  assert.equal(report.candidates[0].checks.failureClassificationAccuracy, true);
  assert.equal(validateLiveModelFitDataset({ ...dataset, tasks: [{ id: "x" }] }).success, false);
});

test("WP3-LIVE-04: live metric yalniz live kanit ve gecen esiklerle promotionEligible olur", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp3-live-metric-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await appendRedactedRunMetric(metricConfiguration(root), {
    recordType: "model_fit_evaluation",
    recordedAt: "2026-09-13T00:00:00.000Z",
    backend: "model-fit-evaluation",
    evidenceType: "live_observation",
    promotionEligible: true,
    coverageComplete: true,
    identityAssurance: "configured",
    thresholdsPassed: true,
    fixtureVersion: "2026-09-13-live-v1",
    taskClass: "strict_schema",
    modelHash: hash("deepseek_pro"),
    repetitionCount: 3,
    schemaPassRate: 1,
    sourceAccuracy: 1,
    failureClassificationAccuracy: 1,
    editReadinessRate: null,
    averageDurationMs: 100,
    p95DurationMs: 120,
    averageCostUsd: 0.001
  });
  const metricPath = path.join(root, "logs", "metrics", "model-fit-evaluation-runs.jsonl");
  const [record] = fs.readFileSync(metricPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(record.evidenceType, "live_observation");
  assert.equal(record.promotionEligible, true);
  assert.equal(record.identityAssurance, "configured");
  const summary = summarizeMetrics([record]);
  assert.equal(summary.modelFitEvaluation.byTaskClass.strict_schema.candidates[hash("deepseek_pro")].promotionEligible, true);
  assert.equal(summary.modelFitEvaluation.byTaskClass.strict_schema.candidates[hash("deepseek_pro")].evidenceType, "live_observation");
  await appendRedactedRunMetric(metricConfiguration(root), {
    recordType: "model_fit_evaluation",
    recordedAt: "2026-09-13T00:01:00.000Z",
    backend: "model-fit-evaluation",
    evidenceType: "live_observation",
    promotionEligible: true,
    coverageComplete: true,
    identityAssurance: "unresolved",
    thresholdsPassed: true,
    fixtureVersion: "2026-09-13-live-v1",
    taskClass: "strict_schema",
    modelHash: hash("deepseek_pro"),
    repetitionCount: 3,
    schemaPassRate: 1,
    sourceAccuracy: 1,
    failureClassificationAccuracy: 1,
    editReadinessRate: null,
    averageDurationMs: 100,
    p95DurationMs: 120,
    averageCostUsd: 0.001
  });
  const records = fs.readFileSync(metricPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.at(-1).promotionEligible, false);
  assert.equal(records.at(-1).identityAssurance, "unresolved");
  const latestSummary = summarizeMetrics(records);
  assert.equal(latestSummary.modelFitEvaluation.byTaskClass.strict_schema.candidates[hash("deepseek_pro")].promotionEligible, false);
  assert.equal(latestSummary.modelFitEvaluation.byTaskClass.strict_schema.candidates[hash("deepseek_pro")].coverageComplete, true);
});

test("WP3-LIVE-06: olculemeyen maliyet not_observable olur ve maliyet esigini gecmis saymaz", async () => {
  const report = await runLiveModelFitEvaluation({
    dataset: liveDataset(),
    executeTask: async ({ task }) => ({ output: buildJsonOutput(task), resolvedModel: resolvedModelFor(task.candidate), failureClass: "none", durationMs: 100, costUsd: null })
  });
  const candidate = report.candidates[0];
  assert.equal(candidate.costObservation, "not_observable");
  assert.equal(candidate.averageCostUsd, null);
  assert.equal(candidate.checks.averageCostUsd, null);
  assert.equal(candidate.thresholdsPassed, true);
});

test("WP3-LIVE-07: kismi maliyet gozlemi observed sayilmaz ama diger esikleri engellemez", async () => {
  let call = 0;
  const report = await runLiveModelFitEvaluation({
    dataset: liveDataset(),
    executeTask: async ({ task }) => {
      call += 1;
      return { output: buildJsonOutput(task), resolvedModel: resolvedModelFor(task.candidate), failureClass: "none", durationMs: 100, costUsd: call === 1 ? 0.002 : null };
    }
  });
  const candidate = report.candidates[0];
  assert.equal(candidate.costObservation, "partial");
  assert.equal(candidate.checks.averageCostUsd, null);
  assert.equal(candidate.thresholdsPassed, true);
});

test("WP3-LIVE-08: acik partial maliyet isareti toplulastirmada korunur", async () => {
  const report = await runLiveModelFitEvaluation({
    dataset: liveDataset(),
    executeTask: async ({ task }) => ({ output: buildJsonOutput(task), resolvedModel: resolvedModelFor(task.candidate), failureClass: "none", durationMs: 100, costUsd: 0.002, costObservation: "partial" })
  });
  const candidate = report.candidates[0];
  assert.equal(candidate.costObservation, "partial");
  assert.equal(candidate.checks.averageCostUsd, null);
  assert.equal(candidate.thresholdsPassed, true);
});

test("WP3-LIVE-05: canli dataset kaynak isareti, edit sozlesmesi, aday politikasi ve json anahtarlarini zorunlu kilar", async () => {
  const missingSource = liveDataset({ tasks: [{ id: "live-source", taskClass: "sourced_analysis", candidate: "deepseek_pro", target: "opencode", model: "deepseek/deepseek-v4-pro", prompt: "p" }] });
  assert.equal(validateLiveModelFitDataset(missingSource).success, false);
  const missingEdit = liveDataset({ tasks: [{ id: "live-edit", taskClass: "controlled_edit_readiness", candidate: "deepseek_pro", target: "opencode", model: "deepseek/deepseek-v4-pro", prompt: "p" }] });
  assert.equal(validateLiveModelFitDataset(missingEdit).success, false);
  const missingKeys = liveDataset({ tasks: [{ id: "live-keys-missing", taskClass: "strict_schema", candidate: "deepseek_pro", target: "opencode", model: "deepseek/deepseek-v4-pro", prompt: "p", expected: { json: true } }] });
  assert.equal(validateLiveModelFitDataset(missingKeys).success, false);
  const wrongCandidate = liveDataset({ tasks: [{ id: "live-wrong-candidate", taskClass: "strict_schema", candidate: "luna", target: "opencode", model: "deepseek/deepseek-v4-pro", prompt: "p", expected: { json: true, jsonKeys: ["status"] } }] });
  assert.equal(validateLiveModelFitDataset(wrongCandidate).success, false);
  const wrongBinding = liveDataset({ tasks: [{ id: "live-wrong-binding", taskClass: "candidate_generation", candidate: "gemini_flash", target: "opencode", model: "deepseek/deepseek-v4-pro", prompt: "p", expected: { json: true, jsonKeys: ["status"] } }] });
  assert.equal(validateLiveModelFitDataset(wrongBinding).success, false);
  const wrongModel = liveDataset({ tasks: [{ id: "live-wrong-model", taskClass: "strict_schema", candidate: "deepseek_pro", target: "opencode", model: "openai/gpt-5.6-terra", prompt: "p", expected: { json: true, jsonKeys: ["status"], jsonShape: { status: "string" } } }] });
  assert.equal(validateLiveModelFitDataset(wrongModel).success, false);
  const flashModel = liveDataset({ tasks: [{ id: "live-flash-model", taskClass: "strict_schema", candidate: "deepseek_pro", target: "opencode", model: "deepseek/deepseek-v4-flash", prompt: "p", expected: { json: true, jsonKeys: ["status"], jsonShape: { status: "string" } } }] });
  assert.equal(validateLiveModelFitDataset(flashModel).success, false);
  const wrongSolModel = liveDataset({ tasks: [{ id: "live-wrong-sol", taskClass: "critical_review", candidate: "sol", target: "codex", model: "gpt-5.6-terra", prompt: "p", expected: { json: true, jsonKeys: ["status"], jsonShape: { status: "string" } } }] });
  assert.equal(validateLiveModelFitDataset(wrongSolModel).success, false);
  const wrongGeminiModel = liveDataset({ tasks: [{ id: "live-wrong-gemini", taskClass: "candidate_generation", candidate: "gemini_flash", target: "gemini_flash", model: "gemini_pro", prompt: "p", expected: { json: true, jsonKeys: ["candidates"], jsonShape: { candidates: "array" } } }] });
  assert.equal(validateLiveModelFitDataset(wrongGeminiModel).success, false);
  const editTask = { id: "live-edit-ok", taskClass: "controlled_edit_readiness", candidate: "deepseek_pro", target: "opencode", model: "deepseek/deepseek-v4-pro", prompt: "p", edit: { files: ["src/a.txt"], contextFiles: [], acceptanceCriteria: ["ok"] } };
  assert.equal(validateLiveModelFitDataset(liveDataset({ tasks: [editTask] })).success, true);
  const lunaTask = { id: "live-edit-luna", taskClass: "controlled_edit_readiness", candidate: "luna", target: "codex", model: "gpt-5.6-luna", profile: "luna_implementation", prompt: "p", edit: { files: ["src/a.txt"], contextFiles: [], acceptanceCriteria: ["ok"] } };
  assert.equal(validateLiveModelFitDataset(liveDataset({ tasks: [lunaTask] })).success, true);
  const lunaNoProfile = { ...lunaTask, id: "live-edit-luna-no-profile", profile: undefined };
  assert.equal(validateLiveModelFitDataset(liveDataset({ tasks: [lunaNoProfile] })).success, false);
  const profileOnRead = { id: "live-profile-read", taskClass: "strict_schema", candidate: "deepseek_pro", target: "opencode", model: "deepseek/deepseek-v4-pro", profile: "x", prompt: "p", expected: { json: true, jsonKeys: ["status"], jsonShape: { status: "string" } } };
  assert.equal(validateLiveModelFitDataset(liveDataset({ tasks: [profileOnRead] })).success, false);

  const keyed = liveDataset({
    tasks: [{ id: "live-keys", taskClass: "strict_schema", candidate: "deepseek_pro", target: "opencode", model: "deepseek/deepseek-v4-pro", prompt: "p", expected: { json: true, jsonKeys: ["status", "summary"], jsonShape: { status: "string", summary: "string" } } }]
  });
  const partial = await runLiveModelFitEvaluation({ dataset: keyed, executeTask: async () => ({ output: JSON.stringify({ status: "completed" }), resolvedModel: "deepseek/deepseek-v4-pro", failureClass: "none", durationMs: 1, costUsd: 0 }) });
  assert.equal(partial.candidates[0].schemaPassRate, 0);
  const complete = await runLiveModelFitEvaluation({ dataset: keyed, executeTask: async () => ({ output: JSON.stringify({ status: "completed", summary: "ok" }), resolvedModel: "deepseek/deepseek-v4-pro", failureClass: "none", durationMs: 1, costUsd: 0 }) });
  assert.equal(complete.candidates[0].schemaPassRate, 1);

  const shaped = liveDataset({
    tasks: [{ id: "live-shaped", taskClass: "strict_schema", candidate: "deepseek_pro", target: "opencode", model: "deepseek/deepseek-v4-pro", prompt: "p", expected: { json: true, jsonKeys: ["status", "count"], jsonShape: { status: "string", count: "number" }, jsonExact: { status: "completed" } } }]
  });
  const nullShape = await runLiveModelFitEvaluation({ dataset: shaped, executeTask: async () => ({ output: JSON.stringify({ status: "completed", count: null }), resolvedModel: "deepseek/deepseek-v4-pro", failureClass: "none", durationMs: 1, costUsd: 0 }) });
  assert.equal(nullShape.candidates[0].schemaPassRate, 0);
  const extraKey = await runLiveModelFitEvaluation({ dataset: shaped, executeTask: async () => ({ output: JSON.stringify({ status: "completed", count: 1, extra: true }), resolvedModel: "deepseek/deepseek-v4-pro", failureClass: "none", durationMs: 1, costUsd: 0 }) });
  assert.equal(extraKey.candidates[0].schemaPassRate, 0);
  const exactShape = await runLiveModelFitEvaluation({ dataset: shaped, executeTask: async () => ({ output: JSON.stringify({ status: "completed", count: 1 }), resolvedModel: "deepseek/deepseek-v4-pro", failureClass: "none", durationMs: 1, costUsd: 0 }) });
  assert.equal(exactShape.candidates[0].schemaPassRate, 1);
  assert.equal(exactShape.candidates[0].boundModel, "deepseek/deepseek-v4-pro");
});
