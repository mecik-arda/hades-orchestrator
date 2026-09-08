import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";
import { createFailureSubagentResult, createSuccessSubagentResult } from "../subagent-bridge/src/schemas/core-schemas.js";

function configuration(root) {
  return {
    allowedRoots: [root],
    statePaths: { logs: path.join(root, "logs"), state: path.join(root, "state"), cache: path.join(root, "cache") },
    observability: { maxMetricFileBytes: 1048576, maxMetricRetentionDays: 30 },
    reliability: { maxAttempts: 2, maxSchemaRepairAttempts: 0, baseRetryDelayMs: 1, maxRetryDelayMs: 2, maxTotalDurationMs: 60000, maxRetryCostUsd: 1, maxRetryCostReserveUsd: 0.1, maxUnknownAttemptCostUsd: 0.1 },
    orchestration: { taskProfiles: { resilient_edit: { target: "glm", model: "glm_5_2", mode: "edit", priority: 8, cacheable: false, fallbackTargets: [{ target: "opencode", model: "deepseek/deepseek-v4-pro" }] }, glm53_flash_resilient: { target: "glm", model: "glm_5_3_flash", mode: "edit", priority: 6, cacheable: false, fallbackTargets: [{ target: "glm", model: "glm_5_2" }, { target: "opencode", model: "deepseek/deepseek-v4-flash" }] } }, scheduler: { maxQueuedPerWorkspace: 10, staleLockMs: 60000, leaseHeartbeatMs: 1000 }, readOnlyCache: { enabled: false, ttlMs: 1000, maxEntryBytes: 1024 }, circuitBreaker: { failureThreshold: 5, windowMs: 60000, openMs: 30000 } },
    glm: { openCodeModel: "zai-coding-plan/glm-5.2", openCodeHighSpeedModel: "zai-coding-plan/glm-5.2-highspeed", openCode53Model: "zai-coding-plan/glm-5.3", openCode53FlashModel: "zai-coding-plan/glm-5.3-flash", timeoutMs: 30000 },
    opencode: { timeoutMs: 30000, maxRetries: 1, allowedModes: ["read_only", "edit"], allowedModels: ["zai-coding-plan/glm-5.2", "zai-coding-plan/glm-5.3-flash", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"], glmEditAgent: "glm-edit", deepSeekEditAgent: "deepseek-edit" }
  };
}

test("EDIT-FALLBACK-01: transient primary hatası temiz disposable workspace ile fallbacke geçer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edit-fallback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "src", "value.txt");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  const workspaces = [];
  const adapter = createAdapter("opencode", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    workspaces.push(request.workspace);
    if (request.model === "zai-coding-plan/glm-5.2") {
      fs.writeFileSync(path.join(request.workspace, "src", "value.txt"), "partial\n", "utf8");
      return createFailureSubagentResult("opencode", request.model, { error: "provider rate limited", reason: "rate_limited", retryable: true, exitCode: 1 });
    }
    assert.equal(fs.readFileSync(path.join(request.workspace, "src", "value.txt"), "utf8"), "before\n");
    fs.writeFileSync(path.join(request.workspace, "src", "value.txt"), "after\n", "utf8");
    return createSuccessSubagentResult("opencode", request.model, { result: "completed" });
  };
  const runtime = createBridgeRuntime({ configuration: configuration(root), adapters: { opencode: adapter }, sleep: async () => {} });
  const result = await runtime.runProfileEdit({ profile: "resilient_edit", taskId: "fallback", model: "glm_5_2", objective: "change", files: ["src/value.txt"], contextFiles: [], acceptanceCriteria: ["changed"] }, root);
  assert.equal(result.status, "completed");
  assert.equal(result.fallbacks, 1);
  assert.equal(result.cleanupCompleted, true);
  assert.notEqual(workspaces[0], workspaces[1]);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "after\n");
});

test("EDIT-FALLBACK-02: secret hatası fallback zincirini durdurur", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edit-fallback-secret-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "src", "value.txt");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  let attempts = 0;
  const adapter = createAdapter("opencode", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    attempts += 1;
    return createSuccessSubagentResult("opencode", request.model, { result: "api_key=abcdefghijklmnop" });
  };
  const runtime = createBridgeRuntime({ configuration: configuration(root), adapters: { opencode: adapter }, sleep: async () => {} });
  const result = await runtime.runProfileEdit({ profile: "resilient_edit", taskId: "fallback-secret", model: "glm_5_2", objective: "change", files: ["src/value.txt"], contextFiles: [], acceptanceCriteria: ["changed"] }, root);
  assert.equal(result.failureClass, "secret_detected");
  assert.equal(attempts, 1);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "before\n");
});

test("EDIT-FALLBACK-03: abortSignal iptali fallback denemelerini durdurur ve kaynak dosyayı korur", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edit-fallback-abort-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "src", "value.txt");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  let attempts = 0;
  const abortController = new AbortController();
  const adapter = createAdapter("opencode", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    attempts += 1;
    if (attempts === 1) {
      return createFailureSubagentResult("opencode", request.model, { error: "provider rate limited", reason: "rate_limited", retryable: true, exitCode: 1 });
    }
    abortController.abort();
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  };
  const runtime = createBridgeRuntime({ configuration: configuration(root), adapters: { opencode: adapter }, sleep: async () => {} });
  const result = await runtime.runProfileEdit({ profile: "resilient_edit", taskId: "fallback-abort", model: "glm_5_2", objective: "change", files: ["src/value.txt"], contextFiles: [], acceptanceCriteria: ["changed"] }, root, abortController.signal);
  assert.equal(result.status, "failed");
  assert.ok(["cancelled", "pilot_failed"].includes(result.failureClass));
  assert.equal(result.applied, false);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "before\n");
});

test("EDIT-FALLBACK-04: glm 5.3 flash profili transient hatada glm_5_2 fallbackine geçer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edit-fallback-glm53-flash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "src", "value.txt");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  const adapter = createAdapter("opencode", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    if (request.model === "zai-coding-plan/glm-5.3-flash") {
      return createFailureSubagentResult("opencode", request.model, { error: "provider rate limited", reason: "rate_limited", retryable: true, exitCode: 1 });
    }
    assert.equal(request.model, "zai-coding-plan/glm-5.2");
    fs.writeFileSync(path.join(request.workspace, "src", "value.txt"), "after\n", "utf8");
    return createSuccessSubagentResult("opencode", request.model, { result: "completed" });
  };
  const runtime = createBridgeRuntime({ configuration: configuration(root), adapters: { opencode: adapter }, sleep: async () => {} });
  const result = await runtime.runProfileEdit({ profile: "glm53_flash_resilient", taskId: "glm53-flash-fallback", model: "glm_5_3_flash", objective: "change", files: ["src/value.txt"], contextFiles: [], acceptanceCriteria: ["changed"] }, root);
  assert.equal(result.status, "completed");
  assert.equal(result.fallbacks, 1);
  assert.equal(result.resolvedModel, "zai-coding-plan/glm-5.2");
  assert.equal(result.applied, true);
  assert.equal(result.cleanupCompleted, true);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "after\n");
});

test("EDIT-CODEX-01: Codex profili seçili dosyayı disposable workspace üzerinden uygular", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edit-codex-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "src", "value.txt");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  const config = configuration(root);
  config.codex = { timeoutMs: 30000, allowedModes: ["read_only", "edit"], allowNonGitWorkspace: true };
  config.orchestration.taskProfiles.luna_implementation = { target: "codex", model: "gpt-5.6-luna", mode: "edit", priority: 12, cacheable: false };
  const adapter = createAdapter("codex", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    assert.equal(request.model, "gpt-5.6-luna");
    assert.equal(request.mode, "edit");
    assert.equal(request.caller, "codex_edit");
    assert.match(request.prompt, /salt-okunur dosya komutları kullanabilirsin/);
    assert.match(request.prompt, /Test, build, script, paket yöneticisi/);
    assert.doesNotMatch(request.prompt, /Shell, dış dizin/);
    assert.notEqual(request.workspace, root);
    fs.writeFileSync(path.join(request.workspace, "src", "value.txt"), "after\n", "utf8");
    return createSuccessSubagentResult("codex", request.model, { result: "completed" });
  };
  const runtime = createBridgeRuntime({ configuration: config, adapters: { codex: adapter }, sleep: async () => {} });
  const result = await runtime.runProfileEdit({ profile: "luna_implementation", taskId: "codex-profile", model: "gpt-5.6-luna", objective: "change", files: ["src/value.txt"], contextFiles: [], acceptanceCriteria: ["changed"] }, root);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.backend, "codex");
  assert.equal(result.applied, true);
  assert.deepEqual(result.filesChanged, ["src/value.txt"]);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "after\n");
});

test("EDIT-CODEX-02: Astra profili seçili dosyayı çözülmüş gpt-6-astra modeliyle uygular", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edit-codex-astra-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "src", "value.txt");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  const config = configuration(root);
  config.codex = { timeoutMs: 30000, allowedModes: ["read_only", "edit"], allowNonGitWorkspace: true };
  config.orchestration.taskProfiles.astra_implementation = { target: "codex", model: "gpt-6-astra", mode: "edit", priority: 4, cacheable: false, fallbackTargets: [{ target: "codex", model: "gpt-5.6-sol" }] };
  const adapter = createAdapter("codex", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    assert.equal(request.model, "gpt-6-astra");
    assert.equal(request.mode, "edit");
    assert.equal(request.caller, "codex_edit");
    fs.writeFileSync(path.join(request.workspace, "src", "value.txt"), "after\n", "utf8");
    return createSuccessSubagentResult("codex", request.model, { result: "completed" });
  };
  const runtime = createBridgeRuntime({ configuration: config, adapters: { codex: adapter }, sleep: async () => {} });
  const result = await runtime.runProfileEdit({ profile: "astra_implementation", taskId: "astra-profile", model: "gpt-6-astra", objective: "change", files: ["src/value.txt"], contextFiles: [], acceptanceCriteria: ["changed"] }, root);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.backend, "codex");
  assert.equal(result.requestedModel, "gpt-6-astra");
  assert.equal(result.resolvedModel, "gpt-6-astra");
  assert.equal(result.applied, true);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "after\n");
});
