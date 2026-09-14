import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { createMcpToolHandlers } from "../subagent-bridge/src/frontends/mcp/tools.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";
import { createFailureSubagentResult, createSuccessSubagentResult } from "../subagent-bridge/src/schemas/core-schemas.js";

function configuration(root) {
  return {
    statePaths: {
      logs: path.join(root, "logs"),
      state: path.join(root, "state"),
      cache: path.join(root, "cache")
    },
    allowedRoots: [root],
    antigravity: { timeoutMs: 30000 },
    codex: { timeoutMs: 30000 },
    claude_code: { timeoutMs: 30000 },
    opencode: { timeoutMs: 30000 },
    deepseek: { openCodeModel: "deepseek/deepseek-v4-pro", openCodeFlashModel: "deepseek/deepseek-v4-flash", timeoutMs: 30000 },
    reliability: { maxAttempts: 1, maxSchemaRepairAttempts: 0, baseRetryDelayMs: 1, maxRetryDelayMs: 2, maxTotalDurationMs: 30000, maxRetryCostUsd: 1, maxRetryCostReserveUsd: 0.1, maxUnknownAttemptCostUsd: 0.1 },
    orchestration: {
      taskProfiles: {},
      scheduler: { maxQueuedPerWorkspace: 10, staleLockMs: 60000, leaseHeartbeatMs: 1000 },
      readOnlyCache: { enabled: false, ttlMs: 1000, maxEntryBytes: 1024 }
    },
    observability: { maxMetricFileBytes: 1048576, maxMetricRetentionDays: 30 }
  };
}

function createFakeAdapter(id, execute) {
  const adapter = createAdapter(id, { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = execute;
  return adapter;
}

function readLiveObservation(root, backend = "codex") {
  const metricsDirectory = path.join(root, "logs", "metrics");
  const records = fs.readdirSync(metricsDirectory)
    .flatMap((entry) => fs.readFileSync(path.join(metricsDirectory, entry), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line));
  return records.find((record) => record.recordType === "live_observation" && record.backend === backend) || null;
}

test("CAP-PROBE-01: codex probe model erisimini ve araçsız yanıtı kaydeder", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-probe-codex-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = createFakeAdapter("codex", async (request) => createSuccessSubagentResult("codex", request.model || "gpt-5.6-sol", { result: "BRIDGE-PROBE-OK", durationMs: 5 }));
  const runtime = createBridgeRuntime({ configuration: configuration(root), adapters: { codex: adapter }, sleep: async () => {} });
  const probe = await runtime.probeCapability({ target: "codex", model: "gpt-5.6-sol", trustedWorkspace: root });
  assert.equal(probe.capabilities.modelAccess, "available");
  assert.equal(probe.capabilities.toolFreeResponse, "available");
  assert.equal(probe.failureClass, null);
  const record = readLiveObservation(root);
  assert.notEqual(record, null);
  assert.equal(record.capabilities.modelAccess, "available");
  assert.equal(record.capabilities.toolFreeResponse, "available");
});

test("CAP-PROBE-02: basarisiz probe unavailable durumunu ve hata sinifini kaydeder", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-probe-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = createFakeAdapter("codex", async (request) => createFailureSubagentResult("codex", request.model || "gpt-5.6-sol", { error: "auth failed", reason: "auth_invalid", durationMs: 5 }));
  const runtime = createBridgeRuntime({ configuration: configuration(root), adapters: { codex: adapter }, sleep: async () => {} });
  const probe = await runtime.probeCapability({ target: "codex", model: "gpt-5.6-sol", trustedWorkspace: root });
  assert.equal(probe.capabilities.modelAccess, "unavailable");
  assert.equal(probe.capabilities.toolFreeResponse, "not_probed");
  assert.equal(probe.failureClass, "authentication_failure");
  const record = readLiveObservation(root);
  assert.equal(record.capabilities.modelAccess, "unavailable");
  assert.equal(record.failureClass, "authentication_failure");
});

test("CAP-PROBE-03: MCP araci model zorunlulugunu ve saglayici eslemesini uygular", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-probe-handler-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handler = createMcpToolHandlers({
    runtime: { probeCapability: async ({ target, model }) => ({ provider: target, model: model || null, capabilities: {}, failureClass: null }) },
    trustedWorkspace: root
  });
  await assert.rejects(() => handler.checkProviderCapability({ provider: "antigravity" }), /requires a model/);
  await assert.rejects(() => handler.checkProviderCapability({ provider: "opencode" }), /requires a model/);
  await assert.rejects(() => handler.checkProviderCapability({ provider: "antigravity", model: "not-a-gemini" }), /not an Antigravity alias/);
  const codexProbe = await handler.checkProviderCapability({ provider: "codex", model: "gpt-5.6-sol" });
  assert.equal(codexProbe.structuredContent.provider, "codex");
  assert.equal(codexProbe.structuredContent.model, "gpt-5.6-sol");
  const claudeProbe = await handler.checkProviderCapability({ provider: "claude_code" });
  assert.equal(claudeProbe.structuredContent.provider, "claude_code");
});

test("CAP-PROBE-04: noktali ve egik cizgili model adlari live_observation kaydinda korunur", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-probe-dotted-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { appendRedactedRunMetric } = await import("../subagent-bridge/src/metrics.js");
  const configuration = { statePaths: { logs: path.join(root, "logs") }, observability: { maxMetricFileBytes: 1048576 } };
  for (const model of ["gemini-3.8-flash-high", "deepseek/deepseek-v4-pro"]) {
    await appendRedactedRunMetric(configuration, {
      recordType: "live_observation",
      recordedAt: "2026-09-13T00:00:00.000Z",
      backend: "antigravity",
      model,
      capabilities: { modelAccess: "available", toolFreeResponse: "available", workspaceRead: "not_probed", webRead: "not_probed" },
      failureClass: null,
      checkedAt: "2026-09-13T00:00:00.000Z"
    });
  }
  const metricsDirectory = path.join(root, "logs", "metrics");
  const records = fs.readdirSync(metricsDirectory).flatMap((entry) => fs.readFileSync(path.join(metricsDirectory, entry), "utf8").split("\n").filter(Boolean)).map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.model).sort(), ["deepseek/deepseek-v4-pro", "gemini-3.8-flash-high"]);
});

test("CAP-PROBE-05: gomulu token tam eslesme sayilmaz", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-probe-embedded-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = createFakeAdapter("codex", async (request) => createSuccessSubagentResult("codex", request.model || "gpt-5.6-sol", { result: "I could not return BRIDGE-PROBE-OK today", durationMs: 5 }));
  const runtime = createBridgeRuntime({ configuration: configuration(root), adapters: { codex: adapter }, sleep: async () => {} });
  const probe = await runtime.probeCapability({ target: "codex", model: "gpt-5.6-sol", trustedWorkspace: root });
  assert.equal(probe.capabilities.modelAccess, "available");
  assert.equal(probe.capabilities.toolFreeResponse, "unavailable");
});
