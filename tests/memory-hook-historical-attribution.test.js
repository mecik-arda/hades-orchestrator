import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendRedactedRunMetric, recordMemoryHookHistoricalAttribution, summarizeMemoryHookFeedback } from "../subagent-bridge/src/metrics.js";
import { readMetricsDirectory, summarizeMetrics } from "../scripts/report-metrics.js";

function createConfiguration(root) {
  return { statePaths: { logs: path.join(root, "logs") }, observability: { maxMetricFileBytes: 1048576 } };
}

async function addLegacyLabel(configuration, { sessionId, outcome, client = "opencode", durationMs = 34, disposition = "eligible_real_user", projectCohort }) {
  const sessionIdHash = crypto.createHash("sha256").update(sessionId).digest("hex");
  const recordedAt = "2026-09-23T08:38:32.347Z";
  await appendRedactedRunMetric(configuration, {
    recordType: "memory_hook_session",
    recordedAt,
    backend: "memory-hook",
    sessionIdHash,
    client,
    durationMs,
    ...(projectCohort === undefined ? {} : { projectCohort })
  });
  if (disposition) {
    await appendRedactedRunMetric(configuration, {
      recordType: "memory_hook_disposition",
      recordedAt,
      backend: "memory-hook",
      sessionIdHash,
      client,
      disposition,
      reason: "user_confirmed_real_session"
    });
  }
  if (outcome) {
    await appendRedactedRunMetric(configuration, {
      recordType: "memory_hook_feedback",
      recordedAt,
      backend: "memory-hook",
      sessionIdHash,
      client,
      outcome
    });
  }
  return { sessionIdHash };
}

function globalFields(summary) {
  return Object.fromEntries([
    "labeledSessions",
    "outcomes",
    "usefulOrPartialRate",
    "averageDurationMs",
    "p95DurationMs",
    "pilotStartAt",
    "pilotWindowElapsed",
    "decisionReady"
  ].map((field) => [field, summary[field]]));
}

test("HOOK-HISTORY-01: projectBeta historic attribution is supplemental and leaves canonical metrics unchanged", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-hook-history-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = createConfiguration(root);
  const targetSession = await addLegacyLabel(configuration, { sessionId: "confirmed-project_beta-session", outcome: "not_useful" });
  await addLegacyLabel(configuration, { sessionId: "unattributed-partial-session", outcome: "partial", durationMs: 33 });
  await addLegacyLabel(configuration, { sessionId: "unattributed-not-useful-session", outcome: "not_useful", durationMs: 18 });
  const initialRecords = readMetricsDirectory(path.join(configuration.statePaths.logs, "metrics"));
  const before = summarizeMemoryHookFeedback(initialRecords);
  const sessionRowsBefore = initialRecords.filter((record) => ["memory_hook_session", "memory_hook_disposition", "memory_hook_feedback"].includes(record.recordType));
  const result = await recordMemoryHookHistoricalAttribution(configuration, {
    client: "opencode",
    sessionId: "confirmed-project_beta-session",
    confirmationSessionId: " confirmed-project_beta-session ",
    expectedSessionIdHash: targetSession.sessionIdHash,
    projectCohort: "project_beta",
    attributionBasis: "user_confirmed"
  });
  assert.deepEqual(result, {
    recorded: true,
    idempotent: false,
    client: "opencode",
    projectCohort: "project_beta",
    attributionBasis: "user_confirmed"
  });
  const records = readMetricsDirectory(path.join(configuration.statePaths.logs, "metrics"));
  const after = summarizeMemoryHookFeedback(records);
  const sessionRowsAfter = records.filter((record) => ["memory_hook_session", "memory_hook_disposition", "memory_hook_feedback"].includes(record.recordType));
  const historicalRows = records.filter((record) => record.recordType === "memory_hook_historical_attribution");
  assert.deepEqual(globalFields(after), globalFields(before));
  assert.deepEqual(after.byProjectCohort, before.byProjectCohort);
  assert.equal(after.historicalAttribution.attributedLabeledSessions, 1);
  assert.equal(after.historicalAttribution.byProjectCohort.project_beta.labeledSessions, 1);
  assert.deepEqual(after.historicalAttribution.byProjectCohort.project_beta.outcomes, { useful: 0, partial: 0, not_useful: 1 });
  assert.equal(after.historicalAttribution.unattributedLegacyLabeledSessions, 2);
  assert.deepEqual(sessionRowsAfter, sessionRowsBefore);
  assert.equal(historicalRows.length, 1);
  assert.deepEqual(Object.keys(historicalRows[0]).sort(), [
    "attributionBasis",
    "backend",
    "client",
    "projectCohort",
    "recordType",
    "recordedAt",
    "sessionIdHash"
  ]);
  assert.equal(JSON.stringify(historicalRows).includes("confirmed-project_beta-session"), false);
  assert.equal(JSON.stringify(historicalRows).includes(root), false);
  assert.equal(summarizeMetrics(records).memoryHookPilot.historicalAttribution.byProjectCohort.project_beta.labeledSessions, 1);
  const repeated = await recordMemoryHookHistoricalAttribution(configuration, {
    client: "opencode",
    sessionId: "confirmed-project_beta-session",
    confirmationSessionId: "confirmed-project_beta-session",
    expectedSessionIdHash: targetSession.sessionIdHash,
    projectCohort: "project_beta",
    attributionBasis: "user_confirmed"
  });
  assert.equal(repeated.recorded, false);
  assert.equal(repeated.idempotent, true);
  assert.equal(readMetricsDirectory(path.join(configuration.statePaths.logs, "metrics")).filter((record) => record.recordType === "memory_hook_historical_attribution").length, 1);
});

test("HOOK-HISTORY-02: exact OpenCode metadata binding can add two projectAlpha labels as a distinct basis", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-hook-history-project_alpha-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = createConfiguration(root);
  const partial = await addLegacyLabel(configuration, { sessionId: "verified-project_alpha-partial", outcome: "partial", durationMs: 33 });
  const notUseful = await addLegacyLabel(configuration, { sessionId: "verified-project_alpha-not-useful", outcome: "not_useful", durationMs: 18 });
  await addLegacyLabel(configuration, { sessionId: "confirmed-project_beta", outcome: "not_useful" });
  const beforeRecords = readMetricsDirectory(path.join(configuration.statePaths.logs, "metrics"));
  const before = summarizeMemoryHookFeedback(beforeRecords);
  for (const [sessionId, expectedSessionIdHash] of [
    ["verified-project_alpha-partial", partial.sessionIdHash],
    ["verified-project_alpha-not-useful", notUseful.sessionIdHash]
  ]) {
    const result = await recordMemoryHookHistoricalAttribution(configuration, {
      client: "opencode",
      sessionId,
      confirmationSessionId: sessionId,
      expectedSessionIdHash,
      projectCohort: "project_alpha",
      attributionBasis: "session_metadata_verified"
    });
    assert.equal(result.recorded, true);
  }
  const records = readMetricsDirectory(path.join(configuration.statePaths.logs, "metrics"));
  const after = summarizeMemoryHookFeedback(records);
  assert.deepEqual(globalFields(after), globalFields(before));
  assert.deepEqual(after.byProjectCohort, before.byProjectCohort);
  assert.equal(after.historicalAttribution.attributedLabeledSessions, 2);
  assert.equal(after.historicalAttribution.byProjectCohort.project_alpha.labeledSessions, 2);
  assert.deepEqual(after.historicalAttribution.byProjectCohort.project_alpha.byAttributionBasis.session_metadata_verified.outcomes, {
    useful: 0,
    partial: 1,
    not_useful: 1
  });
  assert.equal(after.historicalAttribution.unattributedLegacyLabeledSessions, 1);
  assert.equal(records.filter((record) => record.recordType === "memory_hook_historical_attribution").length, 2);
});

test("HOOK-HISTORY-03: authorization binding and eligibility failures do not write attribution", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-hook-history-reject-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = createConfiguration(root);
  const legacy = await addLegacyLabel(configuration, { sessionId: "approved-target", outcome: "not_useful" });
  const partial = await addLegacyLabel(configuration, { sessionId: "partial-target", outcome: "partial" });
  const ineligible = await addLegacyLabel(configuration, { sessionId: "ineligible-target", outcome: "not_useful", disposition: "ineligible_instrumentation" });
  const canonical = await addLegacyLabel(configuration, { sessionId: "canonical-target", outcome: "not_useful", projectCohort: "unassigned" });
  const base = {
    client: "opencode",
    sessionId: "approved-target",
    confirmationSessionId: "approved-target",
    expectedSessionIdHash: legacy.sessionIdHash,
    projectCohort: "project_beta",
    attributionBasis: "user_confirmed"
  };
  await assert.rejects(() => recordMemoryHookHistoricalAttribution(configuration, { ...base, expectedSessionIdHash: partial.sessionIdHash }), /not authorized/);
  await assert.rejects(() => recordMemoryHookHistoricalAttribution(configuration, { ...base, confirmationSessionId: "other-target" }), /confirmation mismatch/);
  await assert.rejects(() => recordMemoryHookHistoricalAttribution(configuration, { ...base, client: "codex" }), /client is not authorized/);
  await assert.rejects(() => recordMemoryHookHistoricalAttribution(configuration, { ...base, projectCohort: "project_alpha" }), /cohort and basis are not authorized/);
  await assert.rejects(() => recordMemoryHookHistoricalAttribution(configuration, { ...base, attributionBasis: "inferred" }), /cohort and basis are not authorized/);
  await assert.rejects(() => recordMemoryHookHistoricalAttribution(configuration, { ...base, sessionId: "ineligible-target", confirmationSessionId: "ineligible-target", expectedSessionIdHash: ineligible.sessionIdHash }), /not eligible/);
  await assert.rejects(() => recordMemoryHookHistoricalAttribution(configuration, { ...base, sessionId: "canonical-target", confirmationSessionId: "canonical-target", expectedSessionIdHash: canonical.sessionIdHash }), /not legacy/);
  await assert.rejects(() => recordMemoryHookHistoricalAttribution(configuration, { ...base, expectedSessionIdHash: null }), /authorization unavailable/);
  const records = readMetricsDirectory(path.join(configuration.statePaths.logs, "metrics"));
  assert.equal(records.some((record) => record.recordType === "memory_hook_historical_attribution"), false);
});

test("HOOK-HISTORY-04: historical attribution CLI requires exact session confirmation arguments", () => {
  const scriptPath = path.resolve("scripts/attribute-memory-hook-history.js");
  const missing = childProcess.spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.deepEqual(JSON.parse(missing.stdout), { recorded: false, reason: "session_confirmation_required" });
  const unknown = childProcess.spawnSync(process.execPath, [scriptPath, "--session-id=opaque", "--confirm-session-id=opaque", "--cohort=project_alpha"], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.deepEqual(JSON.parse(unknown.stdout), { recorded: false, reason: "session_confirmation_required" });
  const missingExpectedHash = childProcess.spawnSync(process.execPath, [scriptPath, "--session-id=opaque", "--confirm-session-id=opaque", "--cohort=project_beta", "--basis=user_confirmed"], { encoding: "utf8" });
  assert.equal(missingExpectedHash.status, 1);
  assert.deepEqual(JSON.parse(missingExpectedHash.stdout), { recorded: false, reason: "historical attribution authorization unavailable" });
  assert.equal(missing.stdout.includes("opaque"), false);
  assert.equal(unknown.stdout.includes("opaque"), false);
  assert.equal(missingExpectedHash.stdout.includes("opaque"), false);
});
