import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { buildOpenCodeArgs } from "../subagent-bridge/src/adapters/opencode-adapter.js";
import { createMcpToolHandlers, publicToolSchemas } from "../subagent-bridge/src/frontends/mcp/tools.js";
import { buildGlmReadOnlyPrompt, checkGlm, createGlmRuntimeRequest, resolveGlmModel } from "../subagent-bridge/src/glm.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";
import { resolveRuntimeRoute } from "../subagent-bridge/src/runtime/router.js";
import { createSuccessSubagentResult } from "../subagent-bridge/src/schemas/core-schemas.js";

function configuration(root) {
  return {
    allowedRoots: [root],
    statePaths: { logs: path.join(root, "logs"), state: path.join(root, "state"), cache: path.join(root, "cache") },
    observability: { maxMetricFileBytes: 1048576, maxMetricRetentionDays: 30 },
    reliability: { maxAttempts: 2, maxSchemaRepairAttempts: 1, baseRetryDelayMs: 1, maxRetryDelayMs: 2, maxTotalDurationMs: 60000, maxRetryCostUsd: 1, maxRetryCostReserveUsd: 0.1, maxUnknownAttemptCostUsd: 0.1 },
    orchestration: { taskProfiles: { glm53_implementation: { target: "glm", model: "glm_5_3", mode: "edit", priority: 7, cacheable: false }, glm53_flash_implementation: { target: "glm", model: "glm_5_3_flash", mode: "edit", priority: 6, cacheable: false } }, scheduler: { maxQueuedPerWorkspace: 10, staleLockMs: 60000, leaseHeartbeatMs: 1000 }, readOnlyCache: { enabled: false, ttlMs: 1000, maxEntryBytes: 1024 } },
    glm: { openCodeModel: "zai-coding-plan/glm-5.2", openCodeHighSpeedModel: "zai-coding-plan/glm-5.2-highspeed", openCode53Model: "zai-coding-plan/glm-5.3", openCode53FlashModel: "zai-coding-plan/glm-5.3-flash", timeoutMs: 30000 },
    opencode: { timeoutMs: 30000, maxRetries: 2, allowedModes: ["read_only", "edit"], allowedModels: ["zai-coding-plan/glm-5.2", "zai-coding-plan/glm-5.2-highspeed"], glmEditAgent: "glm-edit" }
  };
}

function input(overrides = {}) {
  return {
    taskId: "glm-subagent-test",
    role: "implementer",
    model: "glm_5_2",
    mode: "edit",
    objective: "Update the selected file",
    files: ["src/value.txt"],
    contextFiles: [],
    acceptanceCriteria: ["Change the value"],
    ...overrides
  };
}

function structuredOutput(summary) {
  return JSON.stringify({
    status: "completed",
    summary,
    findings: [],
    proposed_steps: [],
    risks: [],
    questions: [],
    requires_human_approval: false
  });
}

test("GLM-01: GLM aliasları tam OpenCode model kimliklerine çözülür", () => {
  const config = configuration("C:\\workspace");
  assert.equal(resolveGlmModel(config, "glm_5_2"), "zai-coding-plan/glm-5.2");
  assert.equal(resolveGlmModel(config, "glm_5_2_highspeed"), "zai-coding-plan/glm-5.2-highspeed");
  assert.equal(resolveGlmModel(config, "glm_5_3"), "zai-coding-plan/glm-5.3");
  assert.equal(resolveGlmModel(config, "glm_5_3_flash"), "zai-coding-plan/glm-5.3-flash");
  assert.equal(resolveGlmModel({ glm: { openCode53Model: "zai-coding-plan/glm-5.3-custom" } }, "glm_5_3"), "zai-coding-plan/glm-5.3-custom");
  assert.equal(resolveGlmModel({ glm: { openCode53FlashModel: "zai-coding-plan/glm-5.3-flash-custom" } }, "glm_5_3_flash"), "zai-coding-plan/glm-5.3-flash-custom");
  assert.throws(() => resolveGlmModel(config, "unknown"), /Desteklenmeyen/);
});

test("GLM-02: OpenCode GLM controlled edit agent'ını seçer", () => {
  const args = buildOpenCodeArgs({ model: "zai-coding-plan/glm-5.2", mode: "edit", caller: "glm_edit", workspace: "C:\\workspace", prompt: "apply" }, { opencode: { glmEditAgent: "glm-edit", editAgent: "build" } }, "zai-coding-plan/glm-5.2");
  assert.equal(args[args.indexOf("--agent") + 1], "glm-edit");
});

test("GLM-03: controlled GLM edit yalnız seçili kaynak dosyaya promotion uygular", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glm-edit-production-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "src", "value.txt");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  const adapter = createAdapter("opencode", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    assert.equal(request.caller, "glm_edit");
    assert.equal(request.model, "zai-coding-plan/glm-5.2");
    fs.writeFileSync(path.join(request.workspace, "src", "value.txt"), "after\n", "utf8");
    return createSuccessSubagentResult("opencode", request.model, { result: "Updated selected file" });
  };
  const runtime = createBridgeRuntime({ configuration: configuration(root), adapters: { opencode: adapter }, sleep: async () => {} });
  const result = await runtime.runGlm(input(), root);
  assert.equal(result.status, "completed");
  assert.equal(result.applied, true);
  assert.equal(result.cleanupCompleted, true);
  assert.equal(result.resolvedModel, "zai-coding-plan/glm-5.2");
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "after\n");
  const metricsDirectory = path.join(root, "logs", "metrics");
  assert.equal(fs.existsSync(path.join(metricsDirectory, "glm-runs.jsonl")), true);
  assert.equal(fs.existsSync(path.join(metricsDirectory, "opencode-runs.jsonl")), false);
});

test("GLM-04: GLM edit public handler implementer ve seçili hedef ister", async () => {
  const base = input();
  assert.equal(publicToolSchemas.runGlm.safeParse(base).success, true);
  assert.equal(publicToolSchemas.runGlm.safeParse({ ...base, model: "glm_5_3" }).success, true);
  assert.equal(publicToolSchemas.runGlm.safeParse({ ...base, model: "glm_5_3_flash" }).success, true);
  assert.equal(publicToolSchemas.runGlmEditPilot.safeParse({ taskId: "pilot", model: "glm_5_3", objective: "Change file", files: ["src/value.txt"], acceptanceCriteria: ["Change value"] }).success, true);
  assert.equal(publicToolSchemas.runGlmEditPilot.safeParse({ taskId: "pilot", model: "glm_5_3_flash", objective: "Change file", files: ["src/value.txt"], acceptanceCriteria: ["Change value"] }).success, true);
  assert.equal(publicToolSchemas.runGlm.safeParse({ ...base, model: "glm_5_9" }).success, false);
  const handlers = createMcpToolHandlers({ runtime: { runGlm: async () => ({ status: "completed" }) }, trustedWorkspace: "C:\\workspace" });
  await assert.rejects(() => handlers.runGlm({ ...base, role: "analyst" }), /implementer role/);
  await assert.rejects(() => handlers.runGlm({ ...base, files: [] }), /selected target files/);
  await assert.doesNotReject(() => handlers.runGlm({ ...base, mode: "read_only", role: "analyst", files: [] }));
  assert.equal(publicToolSchemas.runGlmEditPilot.safeParse({ taskId: "pilot", model: "glm_5_2", objective: "Change file", files: ["src/value.txt"], acceptanceCriteria: ["Change value"] }).success, true);
});

test("GLM-05: salt-okunur GLM yürütmesi redacted GLM metriğine kaydolur", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glm-read-only-metrics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = createAdapter("opencode", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => createSuccessSubagentResult("opencode", request.model, { result: structuredOutput("Inspected workspace") });
  const runtime = createBridgeRuntime({ configuration: configuration(root), adapters: { opencode: adapter }, sleep: async () => {} });
  const result = await runtime.runGlm(input({ role: "analyst", mode: "read_only", files: [] }), root);
  assert.equal(result.agent, "glm");
  assert.equal(result.result.status, "completed");
  assert.equal(result.failureClass, null);
  const checkpoints = fs.readdirSync(path.join(root, "state", "checkpoints"));
  assert.equal(checkpoints.length, 1);
  assert.equal(fs.readFileSync(path.join(root, "state", "checkpoints", checkpoints[0]), "utf8").includes("glm-subagent-test"), false);
  const metric = JSON.parse(fs.readFileSync(path.join(root, "logs", "metrics", "glm-runs.jsonl"), "utf8"));
  assert.equal(metric.backend, "glm");
  assert.equal(metric.mode, "read_only");
  assert.equal(typeof metric.modelHash, "string");
  assert.equal(metric.modelHash.includes("glm"), false);
});

test("GLM-06: router glm target'ı opencode backend ve glm flag ile çözer", () => {
  const route = resolveRuntimeRoute({ target: "glm", model: "glm_5_2" });
  assert.equal(route.backend, "opencode");
  assert.equal(route.model, "glm_5_2");
  assert.equal(route.glm, true);
});

test("GLM-07: glm_analysis task profile read-only GLM metric'ine kaydolur", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glm-profile-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = createAdapter("opencode", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => createSuccessSubagentResult("opencode", request.model, { result: structuredOutput("Profile analysis") });
  const config = configuration(root);
  config.orchestration.taskProfiles.glm_analysis = { target: "glm", model: "glm_5_2", mode: "read_only", priority: 18, cacheable: true };
  const runtime = createBridgeRuntime({ configuration: config, adapters: { opencode: adapter }, sleep: async () => {} });
  const result = await runtime.run({
    target: "profile",
    profile: "glm_analysis",
    mode: "read_only",
    prompt: "Analyze the workspace",
    trustedWorkspace: root,
    caller: "test",
    delegationDepth: 0
  });
  assert.equal(result.ok, true);
  const metric = JSON.parse(fs.readFileSync(path.join(root, "logs", "metrics", "glm-runs.jsonl"), "utf8"));
  assert.equal(metric.backend, "glm");
});

test("GLM-08: structured GLM prompt JSON sözleşmesini içerir", () => {
  const prompt = buildGlmReadOnlyPrompt(input({ role: "analyst", mode: "read_only", files: [] }));
  assert.match(prompt, /CRITICAL JSON RULES/);
  assert.match(prompt, /requires_human_approval/);
});

test("GLM-09: glm_implementation profili controlled edit akışına yönlenir", async () => {
  let received;
  const handlers = createMcpToolHandlers({
    runtime: {
      runProfileEdit: async (input) => {
        received = input;
        return { status: "completed", applied: true };
      }
    },
    trustedWorkspace: "C:\\workspace",
    configuration: {
      orchestration: {
        taskProfiles: {
          glm_implementation: { target: "glm", model: "glm_5_2", mode: "edit", priority: 8, cacheable: false }
        }
      }
    }
  });
  await handlers.runProfile({
    taskId: "glm-profile-edit",
    profile: "glm_implementation",
    prompt: "Update the selected file",
    files: ["src/value.txt"],
    acceptanceCriteria: ["Change the value"]
  });
  assert.equal(received.role, "implementer");
  assert.equal(received.mode, "edit");
  assert.deepEqual(received.files, ["src/value.txt"]);
});

test("GLM-10: GLM edit pilotu source dosyaya promotion uygulamaz", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glm-edit-pilot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "src", "value.txt");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  const adapter = createAdapter("opencode", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    assert.equal(request.caller, "glm_edit_pilot");
    fs.writeFileSync(path.join(request.workspace, "src", "value.txt"), "after\n", "utf8");
    return createSuccessSubagentResult("opencode", request.model, { result: "Updated selected file" });
  };
  const runtime = createBridgeRuntime({ configuration: configuration(root), adapters: { opencode: adapter }, sleep: async () => {} });
  const result = await runtime.runGlmEditPilot(input(), root);
  assert.equal(result.status, "completed");
  assert.equal(result.applied, false);
  assert.equal(result.cleanupCompleted, true);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "before\n");
});

test("GLM-11: GLM denied root workspace provider öncesi reddedilir ve yalnız glm.deniedRootPaths kullanılır", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glm-deny-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const glmDeniedRoot = path.join(root, "glm-deny");
  const deepseekDeniedRoot = path.join(root, "deepseek-deny");
  const allowedWorkspace = path.join(root, "allowed");
  for (const directory of [glmDeniedRoot, deepseekDeniedRoot, allowedWorkspace]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const config = {
    allowedRoots: [root],
    glm: {
      openCodeModel: "zai-coding-plan/glm-5.2",
      openCodeHighSpeedModel: "zai-coding-plan/glm-5.2-highspeed",
      timeoutMs: 30000,
      deniedRootPaths: [glmDeniedRoot]
    },
    deepseek: {
      deniedRootPaths: [deepseekDeniedRoot]
    },
    reliability: { maxSchemaRepairAttempts: 1 }
  };

  const readOnlyInput = {
    objective: "Inspect workspace",
    files: [],
    contextFiles: [],
    acceptanceCriteria: ["Return result"]
  };

  // GLM denied root is rejected before the request object is built, so no provider executes.
  assert.throws(
    () => createGlmRuntimeRequest(config, readOnlyInput, path.join(glmDeniedRoot, "secret"), undefined),
    /korunan kökün içinde/
  );

  // GLM must ignore DeepSeek's deny list: a DeepSeek-denied path stays allowed for GLM.
  const deepseekDeniedRequest = createGlmRuntimeRequest(config, readOnlyInput, deepseekDeniedRoot, undefined);
  assert.equal(deepseekDeniedRequest.caller, "glm_opencode");
  assert.equal(deepseekDeniedRequest.trustedWorkspace, deepseekDeniedRoot);

  // An allowed workspace still passes validation.
  const allowedRequest = createGlmRuntimeRequest(config, readOnlyInput, allowedWorkspace, undefined);
  assert.equal(allowedRequest.trustedWorkspace, allowedWorkspace);
});

test("GLM-12: glm_5_3 edit akışı çözülmüş modelle yürütülür ve GLM metriğine yazılır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glm-53-edit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "src", "value.txt");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  const config = configuration(root);
  config.opencode.allowedModels = ["zai-coding-plan/glm-5.2", "zai-coding-plan/glm-5.2-highspeed", "zai-coding-plan/glm-5.3"];
  const adapter = createAdapter("opencode", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    assert.equal(request.model, "zai-coding-plan/glm-5.3");
    fs.writeFileSync(path.join(request.workspace, "src", "value.txt"), "after\n", "utf8");
    return createSuccessSubagentResult("opencode", request.model, { result: "Updated selected file" });
  };
  const runtime = createBridgeRuntime({ configuration: config, adapters: { opencode: adapter }, sleep: async () => {} });
  const result = await runtime.runGlm(input({ model: "glm_5_3" }), root);
  assert.equal(result.status, "completed");
  assert.equal(result.resolvedModel, "zai-coding-plan/glm-5.3");
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "after\n");
  const metric = JSON.parse(fs.readFileSync(path.join(root, "logs", "metrics", "glm-runs.jsonl"), "utf8"));
  assert.equal(metric.backend, "glm");
});

test("GLM-13: generic runtime.run target=glm model=glm_5_3 aliası çözülmüş kimlikle yürütür", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glm-53-run-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = createAdapter("opencode", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    assert.equal(request.model, "zai-coding-plan/glm-5.3");
    return createSuccessSubagentResult("opencode", request.model, { result: structuredOutput("Inspected workspace") });
  };
  const runtime = createBridgeRuntime({ configuration: configuration(root), adapters: { opencode: adapter }, sleep: async () => {} });
  const result = await runtime.run({
    target: "glm",
    model: "glm_5_3",
    mode: "read_only",
    prompt: "Analyze the workspace",
    trustedWorkspace: root,
    caller: "test",
    delegationDepth: 0
  });
  assert.equal(result.ok, true);
  assert.equal(result.resolvedModel, "zai-coding-plan/glm-5.3");
  const metric = JSON.parse(fs.readFileSync(path.join(root, "logs", "metrics", "glm-runs.jsonl"), "utf8"));
  assert.equal(metric.backend, "glm");
});

test("GLM-14: checkGlm glm_5_3 kimliğini ve katalog durumunu raporlar", async () => {
  const result = await checkGlm({
    glm: { openCodeModel: "zai-coding-plan/glm-5.2", openCodeHighSpeedModel: "zai-coding-plan/glm-5.2-highspeed", openCode53Model: "zai-coding-plan/glm-5.3", openCode53FlashModel: "zai-coding-plan/glm-5.3-flash" },
    opencode: { executable: "opencode" }
  });
  assert.equal(result.glm53Model, "zai-coding-plan/glm-5.3");
  assert.equal(typeof result.glm53ModelAvailable, "boolean");
  assert.equal(result.glm53ModelAvailable, true);
  assert.equal(result.glm53FlashModel, "zai-coding-plan/glm-5.3-flash");
  assert.equal(result.glm53FlashModelAvailable, true);
  assert.equal(result.model, "zai-coding-plan/glm-5.2");
});

test("GLM-16: glm_5_3_flash edit akışı çözülmüş modelle yürütülür ve GLM metriğine yazılır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glm-53-flash-edit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "src", "value.txt");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  const config = configuration(root);
  config.opencode.allowedModels = ["zai-coding-plan/glm-5.2", "zai-coding-plan/glm-5.2-highspeed", "zai-coding-plan/glm-5.3", "zai-coding-plan/glm-5.3-flash"];
  const adapter = createAdapter("opencode", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    assert.equal(request.model, "zai-coding-plan/glm-5.3-flash");
    fs.writeFileSync(path.join(request.workspace, "src", "value.txt"), "after\n", "utf8");
    return createSuccessSubagentResult("opencode", request.model, { result: "Updated selected file" });
  };
  const runtime = createBridgeRuntime({ configuration: config, adapters: { opencode: adapter }, sleep: async () => {} });
  const result = await runtime.runGlm(input({ model: "glm_5_3_flash" }), root);
  assert.equal(result.status, "completed");
  assert.equal(result.resolvedModel, "zai-coding-plan/glm-5.3-flash");
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "after\n");
  const metric = JSON.parse(fs.readFileSync(path.join(root, "logs", "metrics", "glm-runs.jsonl"), "utf8"));
  assert.equal(metric.backend, "glm");
});

test("GLM-17: glm53_implementation profili runProfileEdit ile çözülmüş modelde promotion uygular", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glm-53-profile-edit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "src", "value.txt");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  const config = configuration(root);
  config.opencode.allowedModels = ["zai-coding-plan/glm-5.2", "zai-coding-plan/glm-5.3", "zai-coding-plan/glm-5.3-flash"];
  const adapter = createAdapter("opencode", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    assert.equal(request.model, "zai-coding-plan/glm-5.3");
    fs.writeFileSync(path.join(request.workspace, "src", "value.txt"), "after\n", "utf8");
    return createSuccessSubagentResult("opencode", request.model, { result: "Updated selected file" });
  };
  const runtime = createBridgeRuntime({ configuration: config, adapters: { opencode: adapter }, sleep: async () => {} });
  const result = await runtime.runProfileEdit({ profile: "glm53_implementation", taskId: "glm53-profile", role: "implementer", mode: "edit", model: "glm_5_3", objective: "change", prompt: "change", files: ["src/value.txt"], contextFiles: [], acceptanceCriteria: ["changed"] }, root);
  assert.equal(result.status, "completed");
  assert.equal(result.requestedModel, "glm_5_3");
  assert.equal(result.resolvedModel, "zai-coding-plan/glm-5.3");
  assert.equal(result.applied, true);
  assert.equal(result.cleanupCompleted, true);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "after\n");
  const metric = JSON.parse(fs.readFileSync(path.join(root, "logs", "metrics", "glm-runs.jsonl"), "utf8"));
  assert.equal(metric.backend, "glm");
});

test("GLM-18: glm53_flash_implementation profili runProfileEdit ile çözülmüş modelde promotion uygular", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glm-53-flash-profile-edit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "src", "value.txt");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  const config = configuration(root);
  config.opencode.allowedModels = ["zai-coding-plan/glm-5.2", "zai-coding-plan/glm-5.3", "zai-coding-plan/glm-5.3-flash"];
  const adapter = createAdapter("opencode", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    assert.equal(request.model, "zai-coding-plan/glm-5.3-flash");
    fs.writeFileSync(path.join(request.workspace, "src", "value.txt"), "after\n", "utf8");
    return createSuccessSubagentResult("opencode", request.model, { result: "Updated selected file" });
  };
  const runtime = createBridgeRuntime({ configuration: config, adapters: { opencode: adapter }, sleep: async () => {} });
  const result = await runtime.runProfileEdit({ profile: "glm53_flash_implementation", taskId: "glm53-flash-profile", role: "implementer", mode: "edit", model: "glm_5_3_flash", objective: "change", prompt: "change", files: ["src/value.txt"], contextFiles: [], acceptanceCriteria: ["changed"] }, root);
  assert.equal(result.status, "completed");
  assert.equal(result.requestedModel, "glm_5_3_flash");
  assert.equal(result.resolvedModel, "zai-coding-plan/glm-5.3-flash");
  assert.equal(result.applied, true);
  assert.equal(result.cleanupCompleted, true);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "after\n");
  const metric = JSON.parse(fs.readFileSync(path.join(root, "logs", "metrics", "glm-runs.jsonl"), "utf8"));
  assert.equal(metric.backend, "glm");
});

test("GLM-15: geçersiz glm modeli runtime.run'da yapılandırılmış hata döner, throw etmez", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glm-invalid-run-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let executions = 0;
  const adapter = createAdapter("opencode", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async () => {
    executions += 1;
    return createSuccessSubagentResult("opencode", "x", { result: structuredOutput("unexpected") });
  };
  const runtime = createBridgeRuntime({ configuration: configuration(root), adapters: { opencode: adapter }, sleep: async () => {} });
  const result = await runtime.run({
    target: "glm",
    model: "glm_bilinmeyen",
    mode: "read_only",
    prompt: "Analyze the workspace",
    trustedWorkspace: root,
    caller: "test",
    delegationDepth: 0
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Desteklenmeyen/);
  assert.equal(executions, 0);
});
