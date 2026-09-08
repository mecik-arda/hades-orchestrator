import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { buildAntigravityArgs } from "../subagent-bridge/src/adapters/antigravity-adapter.js";
import { buildEncapsulatedPrompt, resolveClaudeResultModel } from "../subagent-bridge/src/adapters/claude-code-adapter.js";
import { buildOpenCodeArgs } from "../subagent-bridge/src/adapters/opencode-adapter.js";
import { validateAgentsConfig } from "../subagent-bridge/src/config.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";
import { createSuccessSubagentResult } from "../subagent-bridge/src/schemas/core-schemas.js";
import { checkModePolicy, resolveAllowedModes } from "../subagent-bridge/src/services/mode-policy.js";

function configuration(root) {
  return {
    statePaths: {
      logs: path.join(root, "logs"),
      state: path.join(root, "state"),
      cache: path.join(root, "cache")
    },
    observability: { maxMetricFileBytes: 1024 * 1024 },
    reliability: {
      maxAttempts: 1,
      maxSchemaRepairAttempts: 0,
      baseRetryDelayMs: 0,
      maxRetryDelayMs: 1,
      maxTotalDurationMs: 60000,
      maxRetryCostUsd: 1,
      maxRetryCostReserveUsd: 0.1,
      maxUnknownAttemptCostUsd: 0.1
    },
    antigravity: { timeoutMs: 30000, allowedModes: ["read_only", "edit"] },
    codex: { timeoutMs: 30000, allowedModes: ["read_only", "edit"] },
    claude_code: { timeoutMs: 30000, allowedModes: ["read_only"] },
    opencode: { timeoutMs: 30000, allowedModes: ["read_only"] },
    deepseek: {
      openCodeModel: "deepseek/deepseek-v4-pro",
      openCodeFlashModel: "deepseek/deepseek-v4-flash",
      timeoutMs: 30000
    }
  };
}

function fakeAdapter(id, execute) {
  const adapter = createAdapter(id, { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = execute;
  return adapter;
}

test("MODE-01: yeni ve legacy provider mode policy deterministik çözülür", () => {
  const capabilities = { canRead: true, canWrite: true };
  assert.deepEqual(resolveAllowedModes({ allowedModes: ["read_only", "edit"] }, capabilities), ["read_only", "edit"]);
  assert.deepEqual(resolveAllowedModes({ mode: "read_only" }, capabilities), ["read_only"]);
  assert.deepEqual(resolveAllowedModes({ mode: "edit" }, capabilities), ["read_only", "edit"]);
  assert.equal(checkModePolicy({ allowedModes: ["read_only"] }, capabilities, "edit").allowed, false);
});

test("MODE-02: defaultMode allowedModes dışında olduğunda agents config reddedilir", () => {
  const base = { enabled: true, executable: "provider.exe", defaultMode: "edit", allowedModes: ["read_only"] };
  assert.equal(validateAgentsConfig({ agents: { provider: base } }).success, false);
  assert.equal(validateAgentsConfig({ agents: { provider: { ...base, allowedModes: ["read_only", "edit"] } } }).success, true);
});

test("MODE-03: runtime policy edit isteğini provider başlamadan reddeder", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mode-policy-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let executions = 0;
  const config = configuration(root);
  config.codex.allowedModes = ["read_only"];
  const runtime = createBridgeRuntime({
    configuration: config,
    adapters: { codex: fakeAdapter("codex", async () => {
      executions += 1;
      return createSuccessSubagentResult("codex", "gpt-test", { result: "unexpected" });
    }) }
  });
  const result = await runtime.run({ target: "codex", model: "gpt-test", prompt: "edit", mode: "edit", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "mode_not_allowed");
  assert.equal(executions, 0);
});

test("MODEL-01: runtime requested ve resolved model kimliğini ayırır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-identity-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = createBridgeRuntime({
    configuration: configuration(root),
    adapters: { antigravity: fakeAdapter("antigravity", async () => createSuccessSubagentResult("antigravity", "gemini-3.1-pro-high", { result: "ok" })) }
  });
  const result = await runtime.run({ target: "gemini_pro", prompt: "inspect", mode: "read_only", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  assert.equal(result.requestedModel, "gemini_pro");
  assert.equal(result.resolvedModel, "gemini-3.1-pro-high");
  assert.equal(result.accessMode, "read_only");
  const health = await runtime.health(["antigravity"]);
  assert.deepEqual(health.adapters.antigravity.modePolicy, { defaultMode: "read_only", allowedModes: ["read_only", "edit"] });
  assert.equal(health.adapters.antigravity.configuredModels.find((entry) => entry.requestedModel === "gemini_pro").resolvedModel, "gemini-3.1-pro-high");
  assert.equal(health.adapters.antigravity.configuredModels.find((entry) => entry.requestedModel === "gemini_flash").resolvedModel, "gemini-3.8-flash-high");
  assert.equal(health.adapters.antigravity.configuredModels.find((entry) => entry.requestedModel === "gemini_flash_3_7").resolvedModel, "gemini-3.7-flash-high");
  assert.equal(health.adapters.antigravity.configuredModels.find((entry) => entry.requestedModel === "gemini_flash_3_8").resolvedModel, "gemini-3.8-flash-high");
});

test("MODEL-02: Codex default kesin model olarak raporlanmaz", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-default-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = createBridgeRuntime({
    configuration: configuration(root),
    adapters: { codex: fakeAdapter("codex", async () => createSuccessSubagentResult("codex", "default", { result: "ok" })) }
  });
  const result = await runtime.run({ target: "codex", prompt: "inspect", mode: "read_only", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  assert.equal(result.requestedModel, "default");
  assert.equal(result.resolvedModel, null);
  const health = await runtime.health(["codex"]);
  assert.deepEqual(health.adapters.codex.configuredModels[0], { requestedModel: "default", resolvedModel: null });
});

test("MODEL-03: Claude modelUsage tek gerçek modeli çözer", () => {
  assert.equal(resolveClaudeResultModel({ modelUsage: { "claude-sonnet-5": { inputTokens: 10 } } }), "claude-sonnet-5");
  assert.equal(resolveClaudeResultModel({ modelUsage: { first: {}, second: {} } }), null);
  assert.equal(resolveClaudeResultModel({}), null);
});

test("MODE-04: provider CLI argümanları explicit access mode kullanır", () => {
  const readAgy = buildAntigravityArgs({ model: "gemini_pro", mode: "read_only", workspace: "C:\\workspace", prompt: "inspect" }, { antigravity: { executable: "agy", defaultSandbox: true } });
  const editAgy = buildAntigravityArgs({ model: "gemini_pro", mode: "edit", workspace: "C:\\workspace", prompt: "apply" }, { antigravity: { executable: "agy", defaultSandbox: true } });
  assert.deepEqual(readAgy.args.slice(readAgy.args.indexOf("--mode"), readAgy.args.indexOf("--mode") + 2), ["--mode", "plan"]);
  assert.deepEqual(editAgy.args.slice(editAgy.args.indexOf("--mode"), editAgy.args.indexOf("--mode") + 2), ["--mode", "accept-edits"]);
  assert.match(readAgy.args.at(-1), /Resolved model: gemini-3\.1-pro-high/);
  const readOpenCode = buildOpenCodeArgs({ mode: "read_only", caller: "deepseek_opencode", workspace: "C:\\workspace", prompt: "inspect" }, { opencode: { deepSeekReadOnlyAgent: "deepseek-readonly", editAgent: "build" } }, "deepseek/deepseek-v4-pro");
  const editOpenCode = buildOpenCodeArgs({ mode: "edit", caller: "test", workspace: "C:\\workspace", prompt: "apply" }, { opencode: { deepSeekReadOnlyAgent: "deepseek-readonly", editAgent: "controlled-edit" } }, "deepseek/deepseek-v4-pro");
  const pilotOpenCode = buildOpenCodeArgs({ mode: "edit", caller: "deepseek_edit_pilot", workspace: "C:\\workspace", prompt: "apply" }, { opencode: { deepSeekReadOnlyAgent: "deepseek-readonly", deepSeekEditAgent: "deepseek-edit", editAgent: "controlled-edit" } }, "deepseek/deepseek-v4-pro");
  assert.equal(readOpenCode[readOpenCode.indexOf("--agent") + 1], "deepseek-readonly");
  assert.equal(editOpenCode[editOpenCode.indexOf("--agent") + 1], "controlled-edit");
  assert.equal(pilotOpenCode[pilotOpenCode.indexOf("--agent") + 1], "deepseek-edit");
  assert.match(editOpenCode.at(-1), /Access mode: edit/);
});

test("MODE-05: Claude prompt sözleşmesi access mode ile çelişmez", () => {
  const readPrompt = buildEncapsulatedPrompt({ executionId: "read", prompt: "inspect", mode: "read_only" });
  const editPrompt = buildEncapsulatedPrompt({ executionId: "edit", prompt: "apply", mode: "edit" });
  assert.match(readPrompt, /salt okunur/);
  assert.doesNotMatch(editPrompt, /Sen salt okunur/);
  assert.match(editPrompt, /değişiklik uygulayabilen/);
});
