import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { createOpenCodeAdapter, resolveModel } from "../subagent-bridge/src/adapters/opencode-adapter.js";
import { parseSpaceBunnyCatalogOutput, SPACE_BUNNY_MODEL_ID } from "../subagent-bridge/src/space-bunny.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";
import { isPreparedEditApprovable } from "../subagent-bridge/src/services/approval-boundary.js";
import { createPreparedEditRegistry } from "../subagent-bridge/src/services/prepared-edit-registry.js";
import { createSuccessSubagentResult, validateControlledEditResult } from "../subagent-bridge/src/schemas/core-schemas.js";
import { publicToolSchemas } from "../subagent-bridge/src/frontends/mcp/tools.js";

function catalogEntry(overrides = {}) {
  return {
    id: "space-bunny-free",
    providerID: "opencode",
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: { toolcall: true },
    ...overrides
  };
}

function adapterConfiguration(modelOutput) {
  const script = `if (process.argv.includes("models")) { process.stdout.write(${JSON.stringify(`opencode/space-bunny-free\n${JSON.stringify(modelOutput, null, 2)}\n`)}); } else if (process.argv.includes("run")) { process.stdout.write(JSON.stringify({ type: "text", part: { text: process.argv.slice(1).join("|") + "\\n" + process.env.OPENCODE_DISABLE_PROJECT_CONFIG + "\\n" + process.env.OPENCODE_CONFIG_CONTENT } }) + "\\n"); } else { process.exit(9); }`;
  return {
    opencode: {
      executable: process.execPath,
      execArgs: ["-e", script],
      allowedModels: [SPACE_BUNNY_MODEL_ID]
    }
  };
}

function adapterRequest(overrides = {}) {
  return {
    executionId: "space-bunny-test",
    backend: "opencode",
    prompt: "Inspect the workspace",
    model: "space_bunny_free",
    mode: "read_only",
    workspace: process.cwd(),
    delegationDepth: 0,
    caller: "test",
    timeoutMs: 10000,
    ...overrides
  };
}

function createSpaceBunnyRuntime(root, updateFile = () => {}) {
  const adapter = createAdapter("opencode", { canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    updateFile(request.workspace, request);
    return createSuccessSubagentResult("opencode", request.model, { requestedModel: request.model, resolvedModel: request.model, result: "Updated selected file" });
  };
  const configuration = {
    allowedRoots: [root],
    statePaths: {
      logs: path.join(root, "logs"),
      state: path.join(root, "state"),
      cache: path.join(root, "cache")
    },
    observability: { maxMetricFileBytes: 1048576, maxMetricRetentionDays: 30 },
    reliability: {
      maxAttempts: 1,
      maxSchemaRepairAttempts: 0,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 2,
      maxTotalDurationMs: 60000,
      maxRetryCostUsd: 1,
      maxRetryCostReserveUsd: 0,
      maxUnknownAttemptCostUsd: 0
    },
    orchestration: {
      taskProfiles: {},
      scheduler: { maxQueuedPerWorkspace: 10, staleLockMs: 60000, leaseHeartbeatMs: 1000 },
      readOnlyCache: { enabled: false, ttlMs: 1000, maxEntryBytes: 1024 }
    },
    deepseek: { openCodeModel: "deepseek/deepseek-v4-pro", openCodeFlashModel: "deepseek/deepseek-v4-flash", timeoutMs: 30000, deniedRootPaths: [] },
    opencode: { timeoutMs: 30000, allowedModes: ["read_only", "edit"], allowedModels: [SPACE_BUNNY_MODEL_ID] }
  };
  return createBridgeRuntime({ configuration, adapters: { opencode: adapter }, orchestratorApprovalEnabled: true, sleep: async () => {} });
}

test("Space Bunny alias resolves only to its exact allowlisted canonical model", () => {
  assert.equal(resolveModel("space_bunny_free", [SPACE_BUNNY_MODEL_ID]).model, SPACE_BUNNY_MODEL_ID);
  assert.equal(resolveModel("space_bunny_free", ["opencode/other-model"]).valid, false);
  assert.equal(resolveModel("opencode/space-bunny-free", [SPACE_BUNNY_MODEL_ID]).valid, true);
});

test("Space Bunny catalog parser requires exact active model, complete zero pricing, and tool calls", () => {
  const valid = parseSpaceBunnyCatalogOutput(`opencode/space-bunny-free\n${JSON.stringify(catalogEntry())}`);
  assert.equal(valid.available, true);
  assert.equal(valid.resolvedModel, SPACE_BUNNY_MODEL_ID);
  assert.equal(parseSpaceBunnyCatalogOutput(JSON.stringify(catalogEntry({ status: "disabled" }))).available, false);
  const incompletePrice = catalogEntry({ cost: { input: 0, output: 0, cache: { read: 0 } } });
  const nonzeroPrice = catalogEntry({ cost: { input: 0.01, output: 0, cache: { read: 0, write: 0 } } });
  assert.equal(parseSpaceBunnyCatalogOutput(JSON.stringify(incompletePrice)).available, false);
  assert.equal(parseSpaceBunnyCatalogOutput(JSON.stringify(nonzeroPrice)).available, false);
  assert.equal(parseSpaceBunnyCatalogOutput(JSON.stringify({ ...catalogEntry(), providerID: "other" })).available, false);
});

test("Space Bunny adapter gates catalog pricing and injects a restricted per-call agent config", async () => {
  const adapter = createOpenCodeAdapter(adapterConfiguration(catalogEntry()));
  const result = await adapter.execute(adapterRequest());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.result, /--agent\|space-bunny-readonly/);
  const inlineConfig = JSON.parse(result.result.split("\n").at(-1));
  assert.match(result.result, /run\|--pure\|/);
  assert.match(result.result, /\n1\n\{/);
  assert.equal(inlineConfig.small_model, SPACE_BUNNY_MODEL_ID);
  assert.equal(inlineConfig.agent["space-bunny-readonly"].mode, "primary");
  assert.equal(inlineConfig.agent["space-bunny-readonly"].permission["*"], "deny");
  assert.equal(inlineConfig.agent["space-bunny-readonly"].permission.read, "allow");
  assert.equal(inlineConfig.agent["space-bunny-readonly"].permission.edit, undefined);
  assert.equal(inlineConfig.agent["space-bunny-readonly"].permission.external_directory, "deny");
});

test("Space Bunny adapter refuses edits from non-dedicated callers before provider execution", async () => {
  const adapter = createOpenCodeAdapter(adapterConfiguration(catalogEntry()));
  const result = await adapter.execute(adapterRequest({ mode: "edit", caller: "controlled_edit" }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "mode_not_allowed");
});

test("Space Bunny adapter fails closed when refreshed pricing is nonzero", async () => {
  const adapter = createOpenCodeAdapter(adapterConfiguration(catalogEntry({ cost: { input: 0.1, output: 0, cache: { read: 0, write: 0 } } })));
  const result = await adapter.execute(adapterRequest());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "model_unavailable");
});

test("Space Bunny web research receives only web tools in its isolated agent config", async () => {
  const adapter = createOpenCodeAdapter(adapterConfiguration(catalogEntry()));
  const result = await adapter.execute(adapterRequest({ caller: "space_bunny_web_research" }));
  assert.equal(result.ok, true);
  assert.match(result.result, /--agent\|space-bunny-web-research/);
  const inlineConfig = JSON.parse(result.result.split("\n").at(-1));
  const permissions = inlineConfig.agent["space-bunny-web-research"].permission;
  assert.equal(permissions["*"], "deny");
  assert.equal(permissions.websearch, "allow");
  assert.equal(permissions.webfetch, "allow");
  assert.equal(permissions.read, undefined);
  assert.equal(permissions.edit, undefined);
  assert.equal(permissions.bash, undefined);
  assert.equal(permissions.external_directory, "deny");
});

test("Space Bunny edit approval is limited to exact model and allowed source classes", () => {
  const exactRoute = { approvalClass: "space_bunny_edit", backend: "opencode", model: SPACE_BUNNY_MODEL_ID, resolvedModel: SPACE_BUNNY_MODEL_ID, sourceApprovalClass: "low_impact" };
  assert.equal(isPreparedEditApprovable(exactRoute), true);
  assert.equal(isPreparedEditApprovable({ ...exactRoute, sourceApprovalClass: "policy_config" }), false);
  assert.equal(isPreparedEditApprovable({ ...exactRoute, backend: "codex" }), false);
  assert.equal(isPreparedEditApprovable({ ...exactRoute, resolvedModel: "opencode/other" }), false);
});

test("Space Bunny prepared approval stores source classification and validates pending binding", () => {
  const registry = createPreparedEditRegistry();
  const nextBytes = Buffer.from("after");
  const stored = registry.store({
    executionIdHash: "a".repeat(64),
    changeSetHash: "b".repeat(64),
    approvalClass: "space_bunny_edit",
    sourceApprovalClass: "low_impact",
    resolvedModel: SPACE_BUNNY_MODEL_ID,
    workspaceHash: "c".repeat(64),
    sourceStateHash: "d".repeat(64),
    sourceStateEntries: [{ relativePath: "src/example.js", state: "present", sha256: "e".repeat(64) }],
    changes: [{ relativePath: "src/example.js", changeType: "modified", diff: "diff", content: nextBytes }],
    filesChanged: ["src/example.js"],
    diff: "diff",
    backend: "opencode",
    model: SPACE_BUNNY_MODEL_ID,
    requestedModel: "space_bunny_free",
    providerLabel: "Space Bunny"
  });
  assert.equal(registry.peek(stored.approvalRequestId).sourceApprovalClass, "low_impact");
  assert.throws(() => registry.store({
    executionIdHash: "f".repeat(64),
    changeSetHash: "1".repeat(64),
    approvalClass: "space_bunny_edit",
    sourceApprovalClass: "policy_config",
    resolvedModel: SPACE_BUNNY_MODEL_ID,
    workspaceHash: "2".repeat(64),
    sourceStateHash: "3".repeat(64),
    sourceStateEntries: [{ relativePath: "src/example.js", state: "present", sha256: "e".repeat(64) }],
    changes: [{ relativePath: "src/example.js", changeType: "modified", diff: "diff", content: nextBytes }],
    filesChanged: ["src/example.js"],
    diff: "diff",
    backend: "opencode",
    model: SPACE_BUNNY_MODEL_ID,
    requestedModel: "space_bunny_free",
    providerLabel: "Space Bunny"
  }), /not approvable/);
  const pending = validateControlledEditResult({
    status: "failed",
    backend: "opencode",
    model: SPACE_BUNNY_MODEL_ID,
    requestedModel: "space_bunny_free",
    resolvedModel: SPACE_BUNNY_MODEL_ID,
    accessMode: "edit",
    summary: "Explicit approval required",
    failureClass: "approval_required",
    filesChanged: ["src/example.js"],
    diff: "diff",
    applied: false,
    fallbacks: 0,
    cleanupCompleted: true,
    executionIdHash: "a".repeat(64),
    changeSetHash: "b".repeat(64),
    approvalClass: "space_bunny_edit",
    sourceApprovalClass: "low_impact",
    approvalRequired: true,
    approvalRequestId: stored.approvalRequestId,
    approvalExpiresAt: new Date(Date.now() + 60000).toISOString()
  });
  assert.equal(pending.success, true);
  assert.equal(validateControlledEditResult({ ...pending.data, resolvedModel: "opencode/other-model" }).success, false);
});

test("Space Bunny edit remains pending until bound prepared approval is applied", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "space-bunny-approval-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relativePath = "src/example.js";
  const sourcePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  const runtime = createSpaceBunnyRuntime(root, (workspace) => fs.writeFileSync(path.join(workspace, relativePath), "after\n", "utf8"));
  const pending = await runtime.runSpaceBunny({
    taskId: "space-bunny-edit",
    role: "implementer",
    mode: "edit",
    objective: "Update the selected source file",
    files: [relativePath],
    contextFiles: [],
    acceptanceCriteria: ["Change the value"]
  }, root);
  assert.equal(pending.status, "failed");
  assert.equal(pending.approvalClass, "space_bunny_edit", JSON.stringify(pending));
  assert.equal(pending.sourceApprovalClass, "low_impact");
  assert.equal(pending.applied, false);
  assert.equal(typeof pending.approvalRequestId, "string", JSON.stringify(pending));
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "before\n");
  const approved = await runtime.approvePreparedEdit({ approvalRequestId: pending.approvalRequestId }, root);
  assert.equal(approved.status, "completed");
  assert.equal(approved.applied, true);
  assert.equal(approved.approvalClass, "space_bunny_edit");
  assert.equal(approved.sourceApprovalClass, "low_impact");
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "after\n");
});

test("Space Bunny policy-config edit never becomes orchestrator-approvable", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "space-bunny-policy-edit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relativePath = "config/settings.json";
  const sourcePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  const runtime = createSpaceBunnyRuntime(root, (workspace) => fs.writeFileSync(path.join(workspace, relativePath), "after\n", "utf8"));
  const pending = await runtime.runSpaceBunny({
    taskId: "space-bunny-policy-edit",
    role: "implementer",
    mode: "edit",
    objective: "Update the selected policy file",
    files: [relativePath],
    contextFiles: [],
    acceptanceCriteria: ["Change the value"]
  }, root);
  assert.equal(pending.status, "failed");
  assert.equal(pending.approvalClass, "policy_config", JSON.stringify(pending));
  assert.equal(pending.approvalRequestId, undefined);
  assert.equal(pending.applied, false);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "before\n");
});

test("Space Bunny edit pilot cleans the disposable workspace without promoting", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "space-bunny-edit-pilot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relativePath = "src/example.js";
  const sourcePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  const runtime = createSpaceBunnyRuntime(root, (workspace) => fs.writeFileSync(path.join(workspace, relativePath), "after\n", "utf8"));
  const pilot = await runtime.runSpaceBunnyEditPilot({
    taskId: "space-bunny-edit-pilot",
    role: "implementer",
    objective: "Update the selected source file",
    files: [relativePath],
    contextFiles: [],
    acceptanceCriteria: ["Change the value"]
  }, root);
  assert.equal(pilot.status, "completed", JSON.stringify(pilot));
  assert.equal(pilot.applied, false);
  assert.equal(pilot.preview, true);
  assert.equal(pilot.cleanupCompleted, true);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "before\n");
});

test("Space Bunny web research uses and removes an OS-temp workspace", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "space-bunny-web-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let observedWorkspace;
  let observedRequest;
  const runtime = createSpaceBunnyRuntime(root, (workspace, request) => {
    observedWorkspace = workspace;
    observedRequest = request;
  });
  const result = await runtime.runSpaceBunny({
    taskId: "space-bunny-web-research",
    role: "researcher",
    mode: "read_only",
    webResearch: true,
    objective: "Research official provider pricing",
    files: [],
    contextFiles: [],
    acceptanceCriteria: ["Use current sources"]
  }, root);
  assert.equal(result.ok, true);
  assert.equal(observedRequest.caller, "space_bunny_web_research");
  assert.equal(observedRequest.workspace, observedWorkspace);
  assert.equal(path.relative(os.tmpdir(), observedWorkspace).startsWith(".."), false);
  assert.equal(fs.existsSync(observedWorkspace), false);
});

test("Space Bunny MCP schemas enforce selected files and implementer role for edits", () => {
  const readOnly = publicToolSchemas.runSpaceBunny.safeParse({ taskId: "task-1", role: "analyst", mode: "read_only", objective: "Inspect" });
  assert.equal(readOnly.success, true);
  assert.equal(publicToolSchemas.runSpaceBunny.safeParse({ taskId: "task-1", role: "researcher", mode: "read_only", webResearch: true, objective: "Research" }).success, true);
  assert.equal(publicToolSchemas.runSpaceBunny.safeParse({ taskId: "task-1", role: "analyst", mode: "read_only", webResearch: true, objective: "Research" }).success, false);
  assert.equal(publicToolSchemas.runSpaceBunny.safeParse({ taskId: "task-1", role: "researcher", mode: "read_only", objective: "Research" }).success, false);
  assert.equal(publicToolSchemas.runSpaceBunny.safeParse({ taskId: "task-1", role: "analyst", mode: "edit", objective: "Edit", files: ["a.js"], acceptanceCriteria: ["Pass"] }).success, false);
  assert.equal(publicToolSchemas.runSpaceBunny.safeParse({ taskId: "task-1", role: "implementer", mode: "edit", objective: "Edit", files: ["a.js"], acceptanceCriteria: ["Pass"] }).success, true);
  assert.equal(publicToolSchemas.runSpaceBunnyEditPilot.safeParse({ taskId: "task-1", role: "implementer", objective: "Edit", files: ["a.js"], acceptanceCriteria: ["Pass"] }).success, true);
});
