import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordMemoryHookDisposition, recordMemoryHookFeedback, recordMemoryHookSession, summarizeMemoryHookFeedback } from "../subagent-bridge/src/metrics.js";
import { resolveMemoryHookProjectCohort } from "../subagent-bridge/src/services/memory-hook-cohort.js";
import { readMetricsDirectory, summarizeMetrics } from "../scripts/report-metrics.js";

function createConfiguration(rootPath) {
  return {
    statePaths: { logs: path.join(rootPath, "logs") },
    observability: { maxMetricFileBytes: 1048576 }
  };
}

test("HOOK-FEEDBACK-01: redakte hook sonucu ve sure ozeti kaydedilir", async (context) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-hook-feedback-"));
  context.after(() => fs.rmSync(rootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(rootPath);
  await recordMemoryHookSession(configuration, { client: "codex", sessionId: "session-1", durationMs: 120 });
  await recordMemoryHookSession(configuration, { client: "codex", sessionId: "session-1", durationMs: 999 });
  await recordMemoryHookSession(configuration, { client: "opencode", sessionId: "session-2", durationMs: 180 });
  await recordMemoryHookSession(configuration, { client: "codex", sessionId: "session-3", durationMs: null });
  await recordMemoryHookDisposition(configuration, { client: "codex", sessionId: "session-1", disposition: "eligible_real_user" });
  await recordMemoryHookDisposition(configuration, { client: "opencode", sessionId: "session-2", disposition: "eligible_real_user" });
  await recordMemoryHookDisposition(configuration, { client: "codex", sessionId: "session-3", disposition: "eligible_real_user" });
  await recordMemoryHookFeedback(configuration, { client: "codex", sessionId: "session-1", outcome: "useful" });
  await recordMemoryHookFeedback(configuration, { client: "opencode", sessionId: "session-2", outcome: "partial" });
  await recordMemoryHookFeedback(configuration, { client: "codex", sessionId: "session-3", outcome: "not_useful" });
  const records = readMetricsDirectory(path.join(configuration.statePaths.logs, "metrics"));
  const summary = summarizeMemoryHookFeedback(records);
  assert.deepEqual(summary.outcomes, { useful: 1, partial: 1, not_useful: 1 });
  assert.equal(summary.labeledSessions, 3);
  assert.equal(summary.usefulOrPartialRate, 0.6667);
  assert.equal(summary.averageDurationMs, 150);
  assert.equal(summary.p95DurationMs, 180);
  assert.equal(summary.pilotWindowElapsed, false);
  assert.equal(summary.decisionReady, false);
  assert.equal(summary.byProjectCohort.unassigned.labeledSessions, 3);
  assert.equal(Object.values(summary.byProjectCohort).reduce((total, cohort) => total + cohort.labeledSessions, 0), summary.labeledSessions);
  assert.equal(summary.attributionConflictSessionCount, 0);
  assert.equal(summary.attributionConflictEventCount, 0);
  assert.equal(JSON.stringify(records).includes("prompt"), false);
  assert.equal(JSON.stringify(records).includes("workspace"), false);
  assert.equal(JSON.stringify(records).includes("session-1"), false);
  assert.equal(summarizeMetrics(records).memoryHookPilot.labeledSessions, 3);
  await assert.rejects(() => recordMemoryHookFeedback(configuration, { client: "codex", sessionId: "missing", outcome: "useful" }), /session not found/);
});

test("HOOK-FEEDBACK-COHORT-01: ilk cohort immutable, conflict tekilleşir ve etiket conflict kovasına gider", async (context) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-hook-cohort-conflict-"));
  context.after(() => fs.rmSync(rootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(rootPath);
  const initial = await recordMemoryHookSession(configuration, { client: "opencode", sessionId: "cohort-session", durationMs: 55, projectCohort: "unassigned" });
  const conflictOne = await recordMemoryHookSession(configuration, { client: "opencode", sessionId: "cohort-session", durationMs: 77, projectCohort: "project_alpha" });
  const conflictTwo = await recordMemoryHookSession(configuration, { client: "opencode", sessionId: "cohort-session", durationMs: 88, projectCohort: "project_beta" });
  assert.equal(initial.projectCohort, "unassigned");
  assert.equal(conflictOne.conflict, true);
  assert.equal(conflictTwo.conflict, true);
  await recordMemoryHookDisposition(configuration, { client: "opencode", sessionId: "cohort-session", disposition: "eligible_real_user" });
  await recordMemoryHookFeedback(configuration, { client: "opencode", sessionId: "cohort-session", outcome: "not_useful" });
  await recordMemoryHookSession(configuration, { client: "codex", sessionId: "unlabeled-conflict", projectCohort: "project_alpha" });
  await recordMemoryHookSession(configuration, { client: "codex", sessionId: "unlabeled-conflict", projectCohort: "unassigned" });
  const records = readMetricsDirectory(path.join(configuration.statePaths.logs, "metrics"));
  const sessionRecords = records.filter((record) => record.recordType === "memory_hook_session");
  const originalSessionRecord = sessionRecords.find((record) => record.durationMs === 55);
  const conflictRecords = records.filter((record) => record.recordType === "memory_hook_attribution_conflict");
  assert.equal(sessionRecords.length, 2);
  assert.equal(originalSessionRecord.projectCohort, "unassigned");
  assert.equal(originalSessionRecord.durationMs, 55);
  assert.equal(conflictRecords.length, 2);
  assert.equal(Object.hasOwn(conflictRecords[0], "projectCohort"), false);
  assert.equal(JSON.stringify(records).includes("cohort-session"), false);
  const summary = summarizeMemoryHookFeedback(records);
  assert.equal(summary.labeledSessions, 1);
  assert.equal(summary.byProjectCohort.attribution_conflict.labeledSessions, 1);
  assert.equal(summary.byProjectCohort.unassigned.labeledSessions, 0);
  assert.equal(summary.attributionConflictSessionCount, 2);
  assert.equal(summary.attributionConflictEventCount, 2);
  assert.equal(summarizeMetrics(records).memoryHookPilot.attributionConflictEventCount, 2);
});

test("HOOK-FEEDBACK-COHORT-02: legacy session tekrarında cohort eklenmez ve legacy bucket korunur", async (context) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-hook-legacy-cohort-"));
  context.after(() => fs.rmSync(rootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(rootPath);
  const sessionIdHash = (await import("node:crypto")).createHash("sha256").update("legacy-cohort-session").digest("hex");
  const metricsPath = path.join(configuration.statePaths.logs, "metrics", "memory-hook-runs.jsonl");
  fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
  fs.writeFileSync(metricsPath, `${JSON.stringify({
    recordType: "memory_hook_session",
    recordedAt: "2026-09-20T00:00:00.000Z",
    backend: "memory-hook",
    sessionIdHash,
    client: "opencode",
    durationMs: 70
  })}\n`, "utf8");
  const repeated = await recordMemoryHookSession(configuration, { client: "opencode", sessionId: "legacy-cohort-session", durationMs: 99, projectCohort: "project_alpha" });
  assert.equal(repeated.recorded, false);
  assert.equal(repeated.legacyUnattributed, true);
  const records = readMetricsDirectory(path.join(configuration.statePaths.logs, "metrics"));
  const sessionRecords = records.filter((record) => record.recordType === "memory_hook_session");
  assert.equal(sessionRecords.length, 1);
  assert.equal(Object.hasOwn(sessionRecords[0], "projectCohort"), false);
  assert.equal(records.some((record) => record.recordType === "memory_hook_attribution_conflict"), false);
});

test("HOOK-FEEDBACK-COHORT-03: OpenCode ve Codex global/project kayıt sıraları idempotent veya conflict olarak çözülür", async (context) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-hook-cohort-order-"));
  context.after(() => fs.rmSync(rootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(rootPath);
  const registeredRoot = path.join(rootPath, "registered-root");
  fs.mkdirSync(registeredRoot);
  const registryPath = path.join(rootPath, "memory-hook-cohorts.json");
  fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, projects: [{ cohort: "project_alpha", roots: [registeredRoot] }] }), "utf8");
  const globalCohort = resolveMemoryHookProjectCohort({ projectRoots: [registeredRoot], registryPath }).projectCohort;
  const projectCohort = resolveMemoryHookProjectCohort({ projectRoots: [registeredRoot], requestedCohort: "project_alpha", registryPath }).projectCohort;
  for (const client of ["opencode", "codex"]) {
    for (const order of ["global_first", "project_first"]) {
      const sessionId = `${client}-${order}`;
      const cohortSequence = order === "global_first" ? [globalCohort, projectCohort] : [projectCohort, globalCohort];
      await recordMemoryHookSession(configuration, { client, sessionId, projectCohort: cohortSequence[0] });
      const repeated = await recordMemoryHookSession(configuration, { client, sessionId, projectCohort: cohortSequence[1] });
      assert.equal(repeated.recorded, false);
      assert.equal(repeated.conflict, false);
    }
    for (const order of ["global_first", "project_first"]) {
      const sessionId = `${client}-mismatch-${order}`;
      const cohortSequence = order === "global_first" ? [globalCohort, "unassigned"] : ["unassigned", globalCohort];
      await recordMemoryHookSession(configuration, { client, sessionId, projectCohort: cohortSequence[0] });
      const repeated = await recordMemoryHookSession(configuration, { client, sessionId, projectCohort: cohortSequence[1] });
      assert.equal(repeated.conflict, true);
    }
  }
  const records = readMetricsDirectory(path.join(configuration.statePaths.logs, "metrics"));
  const sessions = records.filter((record) => record.recordType === "memory_hook_session");
  const conflicts = records.filter((record) => record.recordType === "memory_hook_attribution_conflict");
  assert.equal(sessions.filter((record) => record.projectCohort === "project_alpha").length, 6);
  assert.equal(sessions.filter((record) => record.projectCohort === "unassigned").length, 2);
  assert.equal(conflicts.length, 4);
  assert.equal(resolveMemoryHookProjectCohort({ projectRoots: [path.join(rootPath, "not-registered")], registryPath }).projectCohort, "unassigned");
});

test("HOOK-FEEDBACK-ELIGIBILITY: ineligible and unclassified sessions cannot be labeled", async (context) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-hook-eligibility-"));
  context.after(() => fs.rmSync(rootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(rootPath);
  await recordMemoryHookSession(configuration, { client: "codex", sessionId: "unclassified" });
  await assert.rejects(() => recordMemoryHookFeedback(configuration, { client: "codex", sessionId: "unclassified", outcome: "useful" }), /not eligible/);
  await recordMemoryHookSession(configuration, { client: "codex", sessionId: "technical" });
  await recordMemoryHookDisposition(configuration, { client: "codex", sessionId: "technical", disposition: "ineligible_instrumentation" });
  await assert.rejects(() => recordMemoryHookFeedback(configuration, { client: "codex", sessionId: "technical", outcome: "useful" }), /not eligible/);
});

test("HOOK-FEEDBACK-02: istemci session anahtarı çakışmaları ayrıştırılır", () => {
  const hash = (value) => value.padStart(64, "0");
  const records = [
    { recordType: "memory_hook_session", client: "codex", sessionIdHash: hash("same"), recordedAt: "2026-09-01T00:00:00.000Z", durationMs: 100 },
    { recordType: "memory_hook_session", client: "opencode", sessionIdHash: hash("same"), recordedAt: "2026-09-01T00:01:00.000Z", durationMs: 200 },
    { recordType: "memory_hook_disposition", client: "codex", sessionIdHash: hash("same"), disposition: "eligible_real_user" },
    { recordType: "memory_hook_disposition", client: "opencode", sessionIdHash: hash("same"), disposition: "eligible_real_user" },
    { recordType: "memory_hook_feedback", client: "codex", sessionIdHash: hash("same"), outcome: "useful" },
    { recordType: "memory_hook_feedback", client: "opencode", sessionIdHash: hash("same"), outcome: "partial" }
  ];
  const summary = summarizeMemoryHookFeedback(records, { now: Date.parse("2026-09-02T00:00:00.000Z") });
  assert.equal(summary.labeledSessions, 2);
  assert.equal(summary.averageDurationMs, 150);
});

test("HOOK-FEEDBACK-03: iki haftalık pencere yalnız etiketli session ile başlar", () => {
  const hash = (value) => value.padStart(64, "0");
  const records = [
    { recordType: "memory_hook_session", client: "opencode", sessionIdHash: hash("technical"), recordedAt: "2026-08-01T00:00:00.000Z", durationMs: 100 },
    { recordType: "memory_hook_session", client: "opencode", sessionIdHash: hash("real"), recordedAt: "2026-09-01T00:00:00.000Z", durationMs: 100 },
    { recordType: "memory_hook_disposition", client: "opencode", sessionIdHash: hash("real"), disposition: "eligible_real_user" },
    { recordType: "memory_hook_feedback", client: "opencode", sessionIdHash: hash("real"), outcome: "useful" }
  ];
  const beforeWindow = summarizeMemoryHookFeedback(records, { now: Date.parse("2026-09-14T23:59:59.000Z") });
  const afterWindow = summarizeMemoryHookFeedback(records, { now: Date.parse("2026-09-15T00:00:00.000Z") });
  assert.equal(beforeWindow.pilotWindowElapsed, false);
  assert.equal(beforeWindow.decisionReady, false);
  assert.equal(afterWindow.pilotWindowElapsed, true);
  assert.equal(afterWindow.decisionReady, true);
});
