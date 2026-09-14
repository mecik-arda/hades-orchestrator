import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendRedactedRunMetric, createRedactedExecutionMetric } from "../subagent-bridge/src/metrics.js";
import { projectRunManifest, replayManifestKeys, selectReplayRecord } from "../subagent-bridge/src/replay.js";
import { createFailureSubagentResult, createSuccessSubagentResult } from "../subagent-bridge/src/schemas/core-schemas.js";

const hashPattern = /^[a-f0-9]{64}$/;

function configuration(root) {
  return {
    statePaths: {
      logs: path.join(root, "logs"),
      state: path.join(root, "state"),
      cache: path.join(root, "cache")
    },
    observability: { maxMetricFileBytes: 1048576, maxMetricRetentionDays: 30 }
  };
}

function metric(result, overrides = {}) {
  return createRedactedExecutionMetric({
    executionId: "execution-identity",
    workspace: "C:\\workspace-root",
    mode: "read_only",
    result,
    ...overrides
  });
}

test("MANIFEST-01: basari, rate limit, izin, iptal ve sema hatalari ayni manifest semasini uretir", () => {
  const cases = [
    createSuccessSubagentResult("codex", "gpt-5.6-sol", { result: "ok result", durationMs: 5 }),
    createFailureSubagentResult("codex", "gpt-5.6-sol", { error: "rate", reason: "rate_limited", durationMs: 5 }),
    createFailureSubagentResult("claude_code", "claude-sonnet", { error: "denied", reason: "permission_denied", durationMs: 5 }),
    createFailureSubagentResult("opencode", "deepseek/deepseek-v4-pro", { error: "cancelled", reason: "cancelled", durationMs: 5 }),
    createFailureSubagentResult("opencode", "deepseek/deepseek-v4-pro", { error: "schema", reason: "schema_invalid", durationMs: 5 })
  ];
  const keySets = cases.map((result) => Object.keys(metric(result)).sort());
  for (const keys of keySets) assert.deepEqual(keys, keySets[0]);

  const base = cases[0];
  const enriched = metric({
    ...base,
    requestedModel: "gpt-5.6-terra",
    resolvedModel: "gpt-5.6-sol",
    accessMode: "edit",
    artifacts: { filesChanged: ["src/a.js", "src/b.js"] },
    metrics: {
      ...base.metrics,
      capability: { canRead: true, canWrite: false, supportsSandbox: true, supportsModelSelection: false }
    }
  });
  assert.equal(enriched.manifestVersion, 2);
  assert.match(enriched.requestedModelHash, hashPattern);
  assert.match(enriched.modelHash, hashPattern);
  assert.notEqual(enriched.requestedModelHash, enriched.modelHash);
  assert.equal(enriched.accessMode, "edit");
  assert.deepEqual(enriched.capability, { canRead: true, canWrite: false, supportsSandbox: true, supportsModelSelection: false });
  assert.equal(enriched.artifactHashes.length, 2);
  assert.equal(enriched.artifactHashes.every((hash) => hashPattern.test(hash)), true);
  assert.equal(JSON.stringify(enriched).includes("src/a.js"), false);
});

test("MANIFEST-02: yazici prompt, output, URL, workspace, gorev ve secret sentinel degerlerini tasimaz", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-manifest-writer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const baseResult = createSuccessSubagentResult("codex", "gpt-5.6-sol", { result: "OUTPUT_SENTINEL" });
  const record = metric({ ...baseResult, metrics: { ...baseResult.metrics, webEvidenceRepair: true } }, {
    executionId: "EXECUTION_ID_SENTINEL",
    workspace: "C:\\WORKSPACE_SENTINEL"
  });
  await appendRedactedRunMetric(config, {
    ...record,
    prompt: "PROMPT_SENTINEL",
    url: "https://URL_SENTINEL.example/path",
    taskId: "TASK_ID_SENTINEL",
    apiKey: "API_KEY_SENTINEL",
    workspacePath: "WORKSPACE_PATH_SENTINEL"
  });
  const metricsDirectory = path.join(root, "logs", "metrics");
  const serialized = fs.readdirSync(metricsDirectory).map((entry) => fs.readFileSync(path.join(metricsDirectory, entry), "utf8")).join("\n");
  for (const sentinel of ["PROMPT_SENTINEL", "OUTPUT_SENTINEL", "URL_SENTINEL", "WORKSPACE_SENTINEL", "WORKSPACE_PATH_SENTINEL", "EXECUTION_ID_SENTINEL", "TASK_ID_SENTINEL", "API_KEY_SENTINEL"]) {
    assert.equal(serialized.includes(sentinel), false);
  }
  const written = JSON.parse(serialized.split("\n").filter(Boolean).at(-1));
  assert.equal(written.manifestVersion, 2);
  assert.match(written.requestedModelHash, hashPattern);
  assert.equal(written.accessMode, "read_only");
  assert.equal(written.webEvidenceRepair, true);
});

test("REPLAY-01: replay projeksiyonu yalniz allowlist alanlarini gosterir ve kaydi hash ile secer", () => {
  const record = metric(createSuccessSubagentResult("codex", "gpt-5.6-sol", { result: "ok result", durationMs: 5 }));
  const projected = projectRunManifest(record);
  assert.deepEqual(Object.keys(projected).sort(), [...replayManifestKeys].sort());
  assert.throws(() => projectRunManifest({ ...record, prompt: "PROMPT_SENTINEL" }), /not a run manifest/);
  const older = { ...record, recordedAt: "2026-09-13T09:00:00.000Z" };
  const newer = { ...record, executionIdHash: "f".repeat(64), recordedAt: "2026-09-13T11:00:00.000Z" };
  const invalid = { ...record, executionIdHash: "e".repeat(64), recordedAt: "not-a-date" };
  const badHash = { ...record, executionIdHash: "zz", recordedAt: "2026-09-13T12:00:00.000Z" };
  assert.equal(selectReplayRecord([older, newer, invalid, badHash], { latest: true }).recordedAt, "2026-09-13T11:00:00.000Z");
  assert.equal(selectReplayRecord([older, newer], { executionIdHash: older.executionIdHash }).executionIdHash, older.executionIdHash);
  assert.equal(selectReplayRecord([older, newer], { executionIdHash: "a".repeat(64) }), null);
  assert.throws(() => projectRunManifest(badHash), /not a run manifest/);
  const hardened = projectRunManifest({
    ...record,
    capability: { canRead: true, canWrite: false, supportsSandbox: true, supportsModelSelection: false },
    artifactHashes: ["a".repeat(64)]
  });
  assert.deepEqual(hardened.capability, { canRead: true, canWrite: false, supportsSandbox: true, supportsModelSelection: false });
  assert.deepEqual(hardened.artifactHashes, ["a".repeat(64)]);
});

test("REPLAY-02: replay modulu runtime veya adapter cagrisi icermez", () => {
  const source = fs.readFileSync(new URL("../subagent-bridge/src/replay.js", import.meta.url), "utf8");
  assert.equal(/createBridgeRuntime|provider-adapters|execution-service|child_process/.test(source), false);
});
