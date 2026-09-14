import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";
import { createSuccessSubagentResult } from "../subagent-bridge/src/schemas/core-schemas.js";

function configuration(root, taskProfiles) {
  return {
    statePaths: {
      logs: path.join(root, "logs"),
      state: path.join(root, "state"),
      cache: path.join(root, "cache")
    },
    allowedRoots: [root],
    codex: { timeoutMs: 30000, allowedModes: ["read_only", "edit"] },
    opencode: { timeoutMs: 30000, allowedModes: ["read_only", "edit"] },
    reliability: { maxAttempts: 1, maxSchemaRepairAttempts: 0, baseRetryDelayMs: 1, maxRetryDelayMs: 2, maxTotalDurationMs: 30000, maxRetryCostUsd: 1, maxRetryCostReserveUsd: 0.1, maxUnknownAttemptCostUsd: 0.1 },
    orchestration: {
      taskProfiles,
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

function pilotInput(overrides = {}) {
  return {
    taskId: "profile-edit-pilot-test",
    role: "implementer",
    mode: "edit",
    objective: "Change the value",
    files: ["src/value.txt"],
    contextFiles: [],
    acceptanceCriteria: ["Change the value"],
    ...overrides
  };
}

test("PILOT-PROFILE-01: codex profil pilotu yalniz disposable alanda onizleme uretir", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-edit-pilot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "src", "value.txt");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "before\n", "utf8");
  let codexExecutions = 0;
  const codexAdapter = createFakeAdapter("codex", async (request) => {
    codexExecutions += 1;
    fs.writeFileSync(path.join(request.workspace, "src", "value.txt"), "after\n", "utf8");
    return createSuccessSubagentResult("codex", request.model, { result: "Updated selected file", durationMs: 5 });
  });
  const opencodeAdapter = createFakeAdapter("opencode", async () => {
    throw new Error("fallback must not run");
  });
  const runtime = createBridgeRuntime({
    configuration: configuration(root, {
      luna_pilot: { target: "codex", model: "gpt-5.6-luna", mode: "edit", priority: 1, cacheable: false, fallbackTargets: [{ target: "opencode", model: "deepseek/deepseek-v4-pro" }] }
    }),
    adapters: { codex: codexAdapter, opencode: opencodeAdapter },
    sleep: async () => {}
  });
  const result = await runtime.runProfileEditPilot(pilotInput({ profile: "luna_pilot" }), root);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.preview, true);
  assert.equal(result.applied, false);
  assert.equal(result.cleanupCompleted, true);
  assert.deepEqual(result.filesChanged, ["src/value.txt"]);
  assert.equal(result.resolvedModel, "gpt-5.6-luna");
  assert.equal(codexExecutions, 1);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "before\n");
  assert.deepEqual(fs.readdirSync(path.join(root, "cache", "deepseek-edit-pilot")), []);
});

test("PILOT-PROFILE-03: codex edit cagrisi git deposu olmayan disposable alanda izinli", async (t) => {
  const { buildCodexArgs } = await import("../subagent-bridge/src/adapters/codex-adapter.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-edit-nongit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const editArgs = buildCodexArgs({ caller: "codex_edit", mode: "edit", model: "gpt-5.6-luna", workspace: root, prompt: "p" }, {});
  assert.equal(editArgs.args.includes("--skip-git-repo-check"), true);
  const readArgs = buildCodexArgs({ caller: "quick_read", mode: "read_only", model: "gpt-5.6-luna", workspace: root, prompt: "p" }, {});
  assert.equal(readArgs.args.includes("--skip-git-repo-check"), false);
});

test("PILOT-PROFILE-02: yalniz codex edit profilleri kabul edilir", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-edit-pilot-reject-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "value.txt"), "before\n", "utf8");
  const runtime = createBridgeRuntime({
    configuration: configuration(root, {
      read_only_profile: { target: "codex", model: "gpt-5.6-luna", mode: "read_only", priority: 1, cacheable: false },
      glm_pilot: { target: "glm", model: "glm_5_2", mode: "edit", priority: 1, cacheable: false },
      luna_pilot: { target: "codex", model: "gpt-5.6-luna", mode: "edit", priority: 1, cacheable: false }
    }),
    adapters: { codex: createFakeAdapter("codex", async () => createSuccessSubagentResult("codex", "gpt-5.6-luna", { result: "unused" })) },
    sleep: async () => {}
  });
  await assert.rejects(() => runtime.runProfileEditPilot(pilotInput({ profile: "read_only_profile" }), root), /edit task profile is required/);
  await assert.rejects(() => runtime.runProfileEditPilot(pilotInput({ profile: "glm_pilot" }), root), /must be codex/);
  await assert.rejects(() => runtime.runProfileEditPilot(pilotInput({ profile: "luna_pilot", model: "gpt-5.6-terra" }), root), /model does not match profile/);
});
