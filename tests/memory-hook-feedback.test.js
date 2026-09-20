import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordMemoryHookDisposition, recordMemoryHookFeedback, recordMemoryHookSession, summarizeMemoryHookFeedback } from "../subagent-bridge/src/metrics.js";
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
  assert.equal(JSON.stringify(records).includes("prompt"), false);
  assert.equal(JSON.stringify(records).includes("workspace"), false);
  assert.equal(JSON.stringify(records).includes("session-1"), false);
  assert.equal(summarizeMetrics(records).memoryHookPilot.labeledSessions, 3);
  await assert.rejects(() => recordMemoryHookFeedback(configuration, { client: "codex", sessionId: "missing", outcome: "useful" }), /session not found/);
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
