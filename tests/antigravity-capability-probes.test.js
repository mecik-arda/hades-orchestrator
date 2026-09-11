import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAntigravityAdapter } from "../subagent-bridge/src/adapters/antigravity-adapter.js";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { validateAgentsConfig } from "../subagent-bridge/src/config.js";
import { antigravityProbeSchema } from "../subagent-bridge/src/frontends/mcp/tools.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";
import { capabilityProbeSchema } from "../subagent-bridge/src/schemas/core-schemas.js";

const fixturePath = fileURLToPath(new URL("./fixtures/antigravity-provider-fixture.js", import.meta.url));

function createProbeAdapter(scenario, overrides = {}) {
  return createAntigravityAdapter({
    antigravity: {
      executable: process.execPath,
      execArgs: [fixturePath, scenario],
      probeTimeoutMs: 30000,
      ...overrides
    }
  });
}

function successResult(backend, model, result = "ok") {
  return {
    ok: true,
    backend,
    model,
    result,
    error: null,
    retryable: false,
    timedOut: false,
    exitCode: 0,
    durationMs: 1,
    metrics: { retries: 0, totalCostUsd: 0 }
  };
}

function createFakeAdapter(id, probeCapabilities) {
  const adapter = createAdapter(id, {
    canRead: true,
    canWrite: true,
    supportsSandbox: true,
    supportsModelSelection: true
  });
  adapter.execute = async (request) => successResult(id, request.model);
  adapter.healthCheck = async () => ({
    installed: true,
    version: "1.0",
    authValid: id === "antigravity" ? null : true,
    executable: id,
    probes: {
      cli: "available",
      modelAccess: "not_probed",
      toolFreeResponse: "not_probed",
      workspaceRead: "not_probed",
      webRead: "not_probed"
    }
  });
  if (probeCapabilities) adapter.probeCapabilities = probeCapabilities;
  return adapter;
}

function createConfiguration(packageRoot, stateRoot) {
  return {
    packageRoot,
    statePaths: {
      logs: path.join(stateRoot, "logs"),
      state: path.join(stateRoot, "state"),
      cache: path.join(stateRoot, "cache")
    },
    antigravity: { timeoutMs: 30000, maxRetries: 0 },
    reliability: {},
    orchestration: {}
  };
}

function probeFixtureResult(overrides = {}) {
  return {
    modelAccess: "not_probed",
    toolFreeResponse: "not_probed",
    workspaceRead: "not_probed",
    webRead: "not_probed",
    failureClass: null,
    checkedAt: new Date().toISOString(),
    ...overrides
  };
}

function fixtureDirectory(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cap-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("CAP-01: tool-free probe model erişimini ve araçsız yanıtı bağımsız işaretler", async () => {
  const adapter = createProbeAdapter("probe-ready");
  const result = await adapter.probeCapabilities({ model: "gemini_flash_3_8", capabilities: ["modelAccess", "toolFreeResponse"] });
  assert.equal(result.modelAccess, "available");
  assert.equal(result.toolFreeResponse, "available");
  assert.equal(result.workspaceRead, "not_probed");
  assert.equal(result.webRead, "not_probed");
  assert.equal(result.failureClass, null);
  assert.equal(capabilityProbeSchema.safeParse(result).success, true);
});

test("CAP-02: auth hatası capability kaydında authentication_failure olur", async () => {
  const adapter = createProbeAdapter("probe-auth");
  const result = await adapter.probeCapabilities({ model: "gemini_flash_3_7", capabilities: ["modelAccess", "toolFreeResponse"] });
  assert.equal(result.modelAccess, "unavailable");
  assert.equal(result.toolFreeResponse, "unavailable");
  assert.equal(result.failureClass, "authentication_failure");
  assert.equal(capabilityProbeSchema.safeParse(result).success, true);
});

test("CAP-03: workspace-read probe marker içeriğini doğrular", async () => {
  const adapter = createProbeAdapter("probe-workspace");
  const result = await adapter.probeCapabilities({ model: "gemini_flash_3_8", capabilities: ["workspaceRead"] });
  assert.equal(result.workspaceRead, "available");
  assert.equal(result.modelAccess, "not_probed");
  assert.equal(result.failureClass, null);
});

test("CAP-04: workspace-read beklenmeyen yanıtta unclassified olur", async () => {
  const adapter = createProbeAdapter("probe-workspace-wrong");
  const result = await adapter.probeCapabilities({ model: "gemini_flash_3_8", capabilities: ["workspaceRead"] });
  assert.equal(result.workspaceRead, "unavailable");
  assert.equal(result.failureClass, "unclassified");
});

test("CAP-05: web-read başarısı ve izin reddi ayrı raporlanır", async () => {
  const availableAdapter = createProbeAdapter("probe-web");
  const available = await availableAdapter.probeCapabilities({ model: "gemini_flash_3_8", capabilities: ["webRead"] });
  assert.equal(available.webRead, "available");
  assert.equal(available.failureClass, null);
  const deniedAdapter = createProbeAdapter("probe-web-denied");
  const denied = await deniedAdapter.probeCapabilities({ model: "gemini_flash_3_8", capabilities: ["webRead"] });
  assert.equal(denied.webRead, "not_probed");
  assert.equal(denied.failureClass, null);
});

test("CAP-06: bir capability hatası diğer capability sonucunu bozmaz", async () => {
  const adapter = createProbeAdapter("probe-ready");
  const result = await adapter.probeCapabilities({ model: "gemini_flash_3_8", capabilities: ["modelAccess", "workspaceRead"] });
  assert.equal(result.modelAccess, "available");
  assert.equal(result.workspaceRead, "unavailable");
  assert.equal(result.failureClass, "unclassified");
});

test("CAP-07: probe timeout sınıflandırılır ve capability unavailable kalır", async () => {
  const adapter = createProbeAdapter("hang", { probeTimeoutMs: 1000 });
  const result = await adapter.probeCapabilities({ model: "gemini_flash_3_8", capabilities: ["modelAccess"] });
  assert.equal(result.modelAccess, "unavailable");
  assert.equal(result.failureClass, "timeout");
  assert.equal(capabilityProbeSchema.safeParse(result).success, true);
});

test("CAP-08: geçersiz model süreç çalıştırmadan invalid_model döner", async () => {
  const adapter = createProbeAdapter("probe-ready");
  const result = await adapter.probeCapabilities({ model: "not_a_model", capabilities: ["modelAccess"] });
  assert.equal(result.modelAccess, "unavailable");
  assert.equal(result.failureClass, "invalid_model");
});

test("CAP-09: capability listesi boşsa hiçbir probe çalışmaz", async () => {
  const adapter = createProbeAdapter("probe-ready");
  const result = await adapter.probeCapabilities({ model: "gemini_flash_3_8", capabilities: [] });
  assert.deepEqual({
    modelAccess: result.modelAccess,
    toolFreeResponse: result.toolFreeResponse,
    workspaceRead: result.workspaceRead,
    webRead: result.webRead
  }, {
    modelAccess: "not_probed",
    toolFreeResponse: "not_probed",
    workspaceRead: "not_probed",
    webRead: "not_probed"
  });
  assert.equal(result.failureClass, null);
  assert.equal(capabilityProbeSchema.safeParse(result).success, true);
});

test("CAP-10: probe sonucu workspace yolu veya çıktı metni taşımaz", async () => {
  const adapter = createProbeAdapter("probe-workspace-wrong");
  const result = await adapter.probeCapabilities({ model: "gemini_flash_3_8", capabilities: ["workspaceRead"] });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("agy-capability-probe"), false);
  assert.equal(serialized.includes("NOT_THE_MARKER"), false);
  assert.equal(serialized.includes(fixturePath), false);
});

test("CAP-11: healthCheck recovery opsiyonunu kabul eder", async () => {
  const adapter = createProbeAdapter("probe-ready");
  const health = await adapter.healthCheck({ recoverStaleSettings: false });
  assert.equal(health.installed, true);
  assert.equal(health.authValid, null);
  assert.equal(health.probes.cli, "available");
});

test("CAP-RT-01: runtime probe sonuçlarını model bazında seri toplar", async (t) => {
  const root = fixtureDirectory(t, "runtime-models");
  const calls = [];
  const antigravity = createFakeAdapter("antigravity", async ({ model }) => {
    calls.push(model);
    if (model === "gemini_flash_3_7") return probeFixtureResult({ modelAccess: "unavailable", failureClass: "authentication_failure" });
    return probeFixtureResult({ modelAccess: "available" });
  });
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters: { antigravity } });
  const health = await runtime.health(["antigravity"], {
    probeModels: ["gemini_flash_3_7", "gemini_flash_3_8"],
    probeCapabilities: ["modelAccess"]
  });
  assert.deepEqual(calls, ["gemini_flash_3_7", "gemini_flash_3_8"]);
  const records = health.adapters.antigravity.health.capabilityProbes;
  assert.equal(records.gemini_flash_3_7.modelAccess, "unavailable");
  assert.equal(records.gemini_flash_3_7.failureClass, "authentication_failure");
  assert.equal(records.gemini_flash_3_8.modelAccess, "available");
  assert.equal(records.gemini_flash_3_8.failureClass, null);
});

test("CAP-RT-02: probe girdileri birlikte verilmelidir", async (t) => {
  const root = fixtureDirectory(t, "runtime-mismatch");
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters: { antigravity: createFakeAdapter("antigravity") } });
  await assert.rejects(() => runtime.health(["antigravity"], { probeModels: ["gemini_flash_3_8"], probeCapabilities: [] }), /provided together/);
  await assert.rejects(() => runtime.health(["antigravity"], { probeModels: [], probeCapabilities: ["modelAccess"] }), /provided together/);
});

test("CAP-RT-03: probe istenmediğinde capability kaydı ve çağrı oluşmaz", async (t) => {
  const root = fixtureDirectory(t, "runtime-off");
  let probeCalls = 0;
  const antigravity = createFakeAdapter("antigravity", async () => {
    probeCalls += 1;
    return probeFixtureResult();
  });
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters: { antigravity } });
  const health = await runtime.health(["antigravity"]);
  assert.equal(health.adapters.antigravity.health.capabilityProbes, undefined);
  assert.equal(probeCalls, 0);
});

test("CAP-RT-04: probe isteği health cache'ini bypass eder", async (t) => {
  const root = fixtureDirectory(t, "runtime-cache");
  let healthChecks = 0;
  let probeCalls = 0;
  const antigravity = createFakeAdapter("antigravity", async () => {
    probeCalls += 1;
    return probeFixtureResult({ modelAccess: "available" });
  });
  antigravity.healthCheck = async () => {
    healthChecks += 1;
    return { installed: true, version: "1.0", authValid: null, executable: "agy" };
  };
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters: { antigravity } });
  await runtime.health(["antigravity"]);
  const probed = await runtime.health(["antigravity"], { probeModels: ["gemini_flash_3_8"], probeCapabilities: ["modelAccess"] });
  assert.equal(probed.adapters.antigravity.health.capabilityProbes.gemini_flash_3_8.modelAccess, "available");
  assert.equal(healthChecks, 2);
  assert.equal(probeCalls, 1);
});

test("CAP-RT-05: capability kayıtları health snapshot'a redakte edilerek yazılır", async (t) => {
  const root = fixtureDirectory(t, "runtime-snapshot");
  const antigravity = createFakeAdapter("antigravity", async () => probeFixtureResult({
    modelAccess: "available",
    workspaceRead: "unavailable",
    failureClass: "PERMISSION SENTINEL free text",
    prompt: "PROMPT_SENTINEL",
    stdout: "STDOUT_SENTINEL",
    checkedAt: new Date().toISOString()
  }));
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters: { antigravity } });
  await runtime.health(["antigravity"], { probeModels: ["gemini_flash_3_8"], probeCapabilities: ["modelAccess", "workspaceRead"] });
  const serialized = fs.readFileSync(path.join(root, "logs", "metrics", "bridge-health-runs.jsonl"), "utf8");
  assert.equal(serialized.includes("PROMPT_SENTINEL"), false);
  assert.equal(serialized.includes("STDOUT_SENTINEL"), false);
  assert.equal(serialized.includes("PERMISSION SENTINEL"), false);
  const [record] = serialized.trim().split("\n").map((line) => JSON.parse(line));
  const probes = record.adapters.antigravity.capabilityProbes.gemini_flash_3_8;
  assert.equal(record.adapters.antigravity.authValid, null);
  assert.equal(probes.modelAccess, "available");
  assert.equal(probes.workspaceRead, "unavailable");
  assert.equal(probes.failureClass, "unclassified");
  assert.match(probes.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("CAP-RT-06: probe yeteneği olmayan adapter sessizce atlanır", async (t) => {
  const root = fixtureDirectory(t, "runtime-unsupported");
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters: { antigravity: createFakeAdapter("antigravity") } });
  const health = await runtime.health(["antigravity"], { probeModels: ["gemini_flash_3_8"], probeCapabilities: ["modelAccess"] });
  assert.equal(health.adapters.antigravity.health.capabilityProbes, undefined);
});

test("CAP-RT-07: probe çağrısı healthCheck recovery davranışını kapatır", async (t) => {
  const root = fixtureDirectory(t, "runtime-recovery");
  const observedOptions = [];
  const antigravity = createFakeAdapter("antigravity", async () => probeFixtureResult({ modelAccess: "available" }));
  antigravity.healthCheck = async (options) => {
    observedOptions.push(options);
    return { installed: true, version: "1.0", authValid: null, executable: "agy" };
  };
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters: { antigravity } });
  await runtime.health(["antigravity"], { probeModels: ["gemini_flash_3_8"], probeCapabilities: ["modelAccess"] });
  assert.deepEqual(observedOptions, [{ recoverStaleSettings: false }]);
  observedOptions.length = 0;
  await runtime.health(["antigravity"]);
  assert.deepEqual(observedOptions, [undefined]);
});

test("CAP-MCP-01: MCP probe girdisi kapalı enum ve strict sınırlarla doğrulanır", () => {
  assert.deepEqual(antigravityProbeSchema.parse({}), { probeModels: [], probeCapabilities: [] });
  assert.equal(antigravityProbeSchema.safeParse({ probeModels: ["gemini_flash_3_8"], probeCapabilities: ["modelAccess"] }).success, true);
  assert.equal(antigravityProbeSchema.safeParse({ probeModels: ["gemini_flash_3_6"], probeCapabilities: ["modelAccess"] }).success, false);
  assert.equal(antigravityProbeSchema.safeParse({ probeModels: ["gemini_flash_3_8"], probeCapabilities: ["promptInjection"] }).success, false);
  assert.equal(antigravityProbeSchema.safeParse({ probeModels: Array(6).fill("gemini_flash_3_8"), probeCapabilities: ["modelAccess"] }).success, false);
  assert.equal(antigravityProbeSchema.safeParse({ probeModels: ["gemini_flash_3_8"], probeCapabilities: ["modelAccess"], executionId: "injected" }).success, false);
});

test("CAP-12: agents.json probeTimeoutMs alanı doğrulanır", () => {
  assert.equal(validateAgentsConfig({ agents: { antigravity: { enabled: true, executable: "agy", probeTimeoutMs: 300000 } } }).success, true);
  assert.equal(validateAgentsConfig({ agents: { antigravity: { enabled: true, executable: "agy", probeTimeoutMs: 0 } } }).success, false);
  assert.equal(validateAgentsConfig({ agents: { antigravity: { enabled: true, executable: "agy", probeTimeoutMs: "300000" } } }).success, false);
});
