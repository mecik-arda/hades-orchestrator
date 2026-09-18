import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendRedactedRunMetric,
  classifyLegacyDirectEditFeedback,
  directEditDispositions,
  listDirectEditDispositions,
  listPendingDirectEditFeedback,
  recordDirectEditDisposition,
  recordDirectEditFeedback
} from "../subagent-bridge/src/metrics.js";
import { readMetricsDirectory, summarizeMetrics } from "../scripts/report-metrics.js";

function createState(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-edit-disposition-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, configuration: { statePaths: { logs: root }, observability: { maxMetricFileBytes: 65536 } } };
}

function seedExecution(configuration, recordedAt, label) {
  const metricsDirectory = path.join(configuration.statePaths.logs, "metrics");
  fs.mkdirSync(metricsDirectory, { recursive: true });
  const executionIdHash = crypto.createHash("sha256").update(label).digest("hex");
  const record = {
    schemaVersion: 2,
    recordedAt,
    backend: "opencode",
    executionIdHash,
    mode: "edit",
    profile: "implementation",
    outcomeStatus: "completed",
    usage: { durationMs: 100, totalCostUsd: 0.001 },
    attempts: [{}]
  };
  fs.appendFileSync(path.join(metricsDirectory, "opencode-runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
  return executionIdHash;
}

test("DISP-01: uygun olmayan kayıt etiketlenemez ve kuyruktan çıkar", async (context) => {
  assert.deepEqual(directEditDispositions, [
    "eligible_real_user",
    "ineligible_instrumentation",
    "ineligible_synthetic",
    "ineligible_duplicate",
    "indeterminate_legacy"
  ]);
  const { configuration } = createState(context);
  const ineligibleId = seedExecution(configuration, "2026-09-01T00:00:00.000Z", "instrumentation-run");
  const eligibleId = seedExecution(configuration, "2026-09-02T00:00:00.000Z", "real-run");
  assert.equal(listPendingDirectEditFeedback(configuration).length, 2);
  const disposed = await recordDirectEditDisposition(configuration, ineligibleId.slice(0, 12), "ineligible_instrumentation", "internal_test_run");
  assert.equal(disposed.disposition, "ineligible_instrumentation");
  const pending = listPendingDirectEditFeedback(configuration);
  assert.deepEqual(pending.map((entry) => entry.feedbackId), [eligibleId.slice(0, 12)]);
  await assert.rejects(
    () => recordDirectEditFeedback(configuration, ineligibleId.slice(0, 12), "accepted"),
    /not eligible for outcome labeling/
  );
  await recordDirectEditFeedback(configuration, eligibleId.slice(0, 12), "accepted");
  assert.deepEqual(listPendingDirectEditFeedback(configuration), []);
  await assert.rejects(
    () => recordDirectEditDisposition(configuration, ineligibleId.slice(0, 12), "indeterminate_legacy", "late_change"),
    /already/
  );
  await assert.rejects(
    () => recordDirectEditDisposition(configuration, eligibleId.slice(0, 12), "eligible_real_user", "late_change"),
    /already labeled/
  );
  const raw = fs.readFileSync(path.join(configuration.statePaths.logs, "metrics", "direct-edit-baseline-runs.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const dispositionRecord = raw.find((record) => record.recordType === "direct_edit_disposition");
  assert.deepEqual(Object.keys(dispositionRecord).sort(), ["backend", "disposition", "executionIdHash", "reason", "recordType", "recordedAt"]);
});

test("DISP-02: eligible_real_user uygunluk kaydı etiketlemeyi engellemez", async (context) => {
  const { configuration } = createState(context);
  const eligibleId = seedExecution(configuration, "2026-09-01T00:00:00.000Z", "reviewed-real-run");
  await recordDirectEditDisposition(configuration, eligibleId.slice(0, 12), "eligible_real_user", "user_confirmed");
  assert.deepEqual(listPendingDirectEditFeedback(configuration).map((entry) => entry.feedbackId), [eligibleId.slice(0, 12)]);
  const labeled = await recordDirectEditFeedback(configuration, eligibleId.slice(0, 12), "minor_fix");
  assert.equal(labeled.outcome, "minor_fix");
  assert.deepEqual(listPendingDirectEditFeedback(configuration), []);
});

test("DISP-03: toplu sınıflandırma yalnız kesim öncesi kayıtları işaretler ve idempotent kalır", async (context) => {
  const { configuration } = createState(context);
  const firstId = seedExecution(configuration, "2026-01-01T00:00:00.000Z", "legacy-one");
  const secondId = seedExecution(configuration, "2026-02-01T00:00:00.000Z", "legacy-two");
  const thirdId = seedExecution(configuration, "2026-03-01T00:00:00.000Z", "fresh-one");
  const result = await classifyLegacyDirectEditFeedback(configuration, { before: "2026-02-15T00:00:00.000Z" });
  assert.equal(result.classified, 2);
  assert.equal(result.disposition, "indeterminate_legacy");
  assert.equal(result.reason, "provenance_unverifiable_legacy");
  assert.deepEqual(result.classifiedFeedbackIds.sort(), [secondId.slice(0, 12), firstId.slice(0, 12)].sort());
  assert.deepEqual(listPendingDirectEditFeedback(configuration).map((entry) => entry.feedbackId), [thirdId.slice(0, 12)]);
  const dispositions = listDirectEditDispositions(configuration);
  assert.equal(dispositions.count, 2);
  assert.equal(dispositions.counts.indeterminate_legacy, 2);
  const repeat = await classifyLegacyDirectEditFeedback(configuration, { before: "2026-02-15T00:00:00.000Z" });
  assert.equal(repeat.classified, 0);
  await assert.rejects(
    () => recordDirectEditFeedback(configuration, firstId.slice(0, 12), "accepted"),
    /not eligible for outcome labeling/
  );
  await recordDirectEditFeedback(configuration, thirdId.slice(0, 12), "accepted");
  const summary = summarizeMetrics(readMetricsDirectory(path.join(configuration.statePaths.logs, "metrics")));
  assert.equal(summary.directEditBaseline.totalEditRuns, 3);
  assert.equal(summary.directEditBaseline.eligibleEditRuns, 1);
  assert.equal(summary.directEditBaseline.ineligibleEditRuns, 2);
  assert.equal(summary.directEditBaseline.labeledEditRuns, 1);
  assert.equal(summary.directEditBaseline.pendingFeedback, 0);
  assert.deepEqual(summary.directEditBaseline.dispositionCounts, { indeterminate_legacy: 2 });
  assert.equal(summary.directEditBaseline.decisionReady, false);
});

test("DISP-04: geçersiz uygunluk girdileri fail-closed reddedilir", async (context) => {
  const { configuration } = createState(context);
  const executionId = seedExecution(configuration, "2026-09-01T00:00:00.000Z", "validation-run");
  await assert.rejects(
    () => recordDirectEditDisposition(configuration, executionId.slice(0, 12), "totally_fine", "x"),
    /unsupported direct edit disposition/
  );
  await assert.rejects(
    () => recordDirectEditDisposition(configuration, "not-an-id", "indeterminate_legacy", "x"),
    /invalid feedback ID/
  );
  await assert.rejects(
    () => recordDirectEditDisposition(configuration, executionId.slice(0, 12), "indeterminate_legacy", "Has Space"),
    /invalid disposition reason/
  );
  await assert.rejects(
    () => classifyLegacyDirectEditFeedback(configuration, { before: "not-a-date" }),
    /invalid classification cutoff/
  );
  await assert.rejects(
    () => classifyLegacyDirectEditFeedback(configuration, { before: "2026-09-02T00:00:00.000Z", disposition: "unknown_kind" }),
    /unsupported direct edit disposition/
  );
  await assert.rejects(
    () => classifyLegacyDirectEditFeedback(configuration, { before: "2026-09-02T00:00:00.000Z", disposition: "eligible_real_user" }),
    /cannot grant eligibility/
  );
});

test("DISP-05: uygun olmayan kayda ham sonuç etiketi karar paydasını etkilemez", async (context) => {
  const { configuration } = createState(context);
  const ineligibleId = seedExecution(configuration, "2026-09-01T00:00:00.000Z", "instrumentation-conflict");
  await recordDirectEditDisposition(configuration, ineligibleId.slice(0, 12), "ineligible_instrumentation", "internal_test_run");
  await appendRedactedRunMetric(configuration, {
    recordType: "direct_edit_feedback",
    recordedAt: "2026-09-02T00:00:00.000Z",
    backend: "direct-edit-baseline",
    executionIdHash: ineligibleId,
    outcome: "accepted"
  });
  const summary = summarizeMetrics(readMetricsDirectory(path.join(configuration.statePaths.logs, "metrics")));
  assert.equal(summary.directEditBaseline.totalEditRuns, 1);
  assert.equal(summary.directEditBaseline.eligibleEditRuns, 0);
  assert.equal(summary.directEditBaseline.ineligibleEditRuns, 1);
  assert.equal(summary.directEditBaseline.labeledEditRuns, 0);
  assert.equal(summary.directEditBaseline.conflictingLabeledRuns, 1);
  assert.equal(summary.directEditBaseline.pendingFeedback, 0);
  assert.equal(summary.directEditBaseline.decisionReady, false);
});
