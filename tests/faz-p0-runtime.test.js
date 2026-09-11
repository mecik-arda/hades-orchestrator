import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";
import { resolveRuntimeRoute } from "../subagent-bridge/src/runtime/router.js";
import { publicToolSchemas, createMcpToolHandlers } from "../subagent-bridge/src/frontends/mcp/tools.js";
import { resolveTrustedWorkspace } from "../subagent-bridge/src/frontends/mcp/workspace-context.js";
import { releaseAllLocks } from "./support/workspace-lock.js";
import { ensureRuntimeDirectories } from "../subagent-bridge/src/config.js";

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

function failureResult(backend, model, error, reason) {
  return {
    ok: false,
    backend,
    model,
    result: null,
    error,
    retryable: true,
    timedOut: reason === "timeout",
    exitCode: reason === "timeout" ? null : 1,
    durationMs: 1,
    reason,
    metrics: { retries: 0, totalCostUsd: 0 }
  };
}

function createFakeAdapter(id, execute) {
  const adapter = createAdapter(id, {
    canRead: true,
    canWrite: true,
    supportsSandbox: true,
    supportsModelSelection: true
  });
  adapter.execute = execute;
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
    antigravity: { timeoutMs: 30000, maxRetries: 1 },
    codex: { timeoutMs: 30000, maxRetries: 1 },
    claude_code: { timeoutMs: 30000, maxRetries: 1 },
    opencode: { timeoutMs: 30000, maxRetries: 1 },
    deepseek: {
      openCodeModel: "deepseek/deepseek-v4-pro",
      openCodeFlashModel: "deepseek/deepseek-v4-flash",
      timeoutMs: 30000
    }
  };
}

test("P0-ROUTE: canonical targets resolve to one backend", () => {
  assert.deepEqual(resolveRuntimeRoute({ target: "gemini_pro" }), { backend: "antigravity", model: "gemini_pro" });
  assert.deepEqual(resolveRuntimeRoute({ target: "gemini_flash" }), { backend: "antigravity", model: "gemini_flash" });
  assert.deepEqual(resolveRuntimeRoute({ target: "gemini_flash_3_7" }), { backend: "antigravity", model: "gemini_flash_3_7" });
  assert.deepEqual(resolveRuntimeRoute({ target: "gemini_flash_3_8" }), { backend: "antigravity", model: "gemini_flash_3_8" });
  assert.deepEqual(resolveRuntimeRoute({ target: "claude_sonnet" }), { backend: "antigravity", model: "claude_sonnet" });
  assert.deepEqual(resolveRuntimeRoute({ target: "codex" }), { backend: "codex", model: "default" });
  assert.deepEqual(resolveRuntimeRoute({ target: "native_claude", model: "sonnet" }), { backend: "claude_code", model: "sonnet" });
  assert.deepEqual(resolveRuntimeRoute({ target: "native_claude" }), { backend: "claude_code", model: "sonnet" });
  assert.deepEqual(resolveRuntimeRoute({ target: "opencode", model: "deepseek/deepseek-chat" }), { backend: "opencode", model: "deepseek/deepseek-chat" });
  assert.throws(() => resolveRuntimeRoute({ target: "opencode", model: "google/gemini-3-pro" }), /Antigravity/);
  assert.throws(() => resolveRuntimeRoute({ target: "opencode", model: "gemini_flash_3_7" }), /Antigravity/);
  assert.throws(() => resolveRuntimeRoute({ target: "opencode", model: "gemini-3.7-flash-high" }), /Antigravity/);
  assert.throws(() => resolveRuntimeRoute({ target: "opencode", model: "gemini-3.8-flash-high" }), /Antigravity/);
  assert.throws(() => resolveRuntimeRoute({ target: "opencode", model: "gemini" }), /Antigravity/);
  assert.throws(() => resolveRuntimeRoute({ target: "opencode", model: "google/gemini" }), /Antigravity/);
  assert.throws(() => resolveRuntimeRoute({ target: "opencode", model: "google/gemini_flash" }), /Antigravity/);
  assert.equal(publicToolSchemas.runAntigravity.safeParse({ prompt: "inspect", model: "gemini_flash_3_7", mode: "read_only" }).success, true);
  assert.equal(publicToolSchemas.runAntigravity.safeParse({ prompt: "inspect", model: "gemini_flash_3_8", mode: "read_only" }).success, true);
  assert.equal(publicToolSchemas.runAntigravity.safeParse({ prompt: "inspect", model: "gemini_flash_3_6", mode: "read_only" }).success, false);
});

test("P0-PUBLIC: bridge-owned metadata is rejected by every public schema", () => {
  const schemaCases = {
    runAntigravity: { input: { prompt: "inspect", model: "gemini_pro", mode: "read_only" }, allowedBridgeFields: ["workspace"] },
    runClaudeCode: { input: { prompt: "inspect", mode: "read_only" } },
    runOpenCode: { input: { prompt: "inspect", model: "deepseek/deepseek-v4-pro", mode: "read_only" } },
    runCodex: { input: { prompt: "inspect", mode: "read_only" } },
    runProfile: { input: { prompt: "inspect", profile: "quick_read" } },
    runDeepSeek: { input: { taskId: "task", role: "analyst", mode: "read_only", objective: "inspect", workspace: "C:\\trusted", acceptanceCriteria: ["report"] }, allowedBridgeFields: ["workspace"] },
    runDeepSeekEditPilot: { input: { taskId: "task", objective: "change", files: ["src/value.txt"], acceptanceCriteria: ["changed"] } },
    runGlm: { input: { taskId: "task", role: "analyst", mode: "read_only", objective: "inspect", acceptanceCriteria: ["report"] } },
    runGlmEditPilot: { input: { taskId: "task", objective: "change", files: ["src/value.txt"], acceptanceCriteria: ["changed"] } },
    runCatalogProvider: { input: { taskId: "task", role: "analyst", model: "kimi_k2_5_instruct", mode: "read_only", objective: "inspect", acceptanceCriteria: ["report"] } }
  };
  const bridgeFields = ["workspace", "cwd", "worktree", "projectRoot", "trustedWorkspace", "executable", "execArgs", "sandbox", "delegationDepth", "executionId", "caller", "statePaths"];
  for (const [schemaName, { input, allowedBridgeFields = [] }] of Object.entries(schemaCases)) {
    const schema = publicToolSchemas[schemaName];
    assert.equal(schema.safeParse(input).success, true, `${schemaName} fixture should be valid`);
    assert.equal(schema.safeParse({ ...input, unexpectedField: "injected" }).success, false, `${schemaName} should remain strict`);
    for (const field of bridgeFields.filter((candidate) => !allowedBridgeFields.includes(candidate))) {
      assert.equal(schema.safeParse({ ...input, [field]: "injected" }).success, false, `${schemaName}.${field} should be rejected`);
    }
  }
});

test("P0-INJECTION: rejected public metadata cannot reach execution", async () => {
  let runCount = 0;
  const handlers = createMcpToolHandlers({
    runtime: {
      async run() {
        runCount += 1;
        return successResult("codex", "default");
      }
    },
    trustedWorkspace: "C:\\trusted",
    caller: "openCode"
  });
  for (const injected of [
    { workspace: "C:\\other" },
    { executable: "malware.exe" },
    { execArgs: ["--unsafe"] },
    { sandbox: false },
    { delegationDepth: 9 }
  ]) {
    await assert.rejects(() => handlers.runCodex({ prompt: "inspect", mode: "read_only", ...injected }), /invalid public tool arguments/);
  }
  assert.equal(runCount, 0);
});

test("P0-ANTIGRAVITY-WORKSPACE: izinli harici workspace salt okunur Gemini çağrısına aktarılır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-antigravity-workspace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trustedWorkspace = path.join(root, "trusted");
  const externalWorkspace = path.join(root, "external");
  fs.mkdirSync(trustedWorkspace);
  fs.mkdirSync(externalWorkspace);
  let observedWorkspace = null;
  const handlers = createMcpToolHandlers({
    runtime: {
      async run(request) {
        observedWorkspace = request.trustedWorkspace;
        return successResult("antigravity", "gemini_pro");
      }
    },
    trustedWorkspace,
    caller: "openCode",
    configuration: { allowedRoots: [root], workspacePolicy: { antigravityDeniedRootPaths: [] } }
  });

  await handlers.runAntigravity({
    prompt: "inspect",
    model: "gemini_pro",
    mode: "read_only",
    workspace: externalWorkspace
  });

  assert.equal(observedWorkspace, fs.realpathSync(externalWorkspace));
});

test("P0-ANTIGRAVITY-WORKSPACE: harici workspace düzenleme modunda ve izinli kök dışında reddedilir", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-antigravity-workspace-policy-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-antigravity-outside-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const handlers = createMcpToolHandlers({
    runtime: { async run() { return successResult("antigravity", "gemini_pro"); } },
    trustedWorkspace: root,
    configuration: { allowedRoots: [root], workspacePolicy: { antigravityDeniedRootPaths: [] } }
  });

  await assert.rejects(
    () => handlers.runAntigravity({ prompt: "inspect", model: "gemini_pro", mode: "edit", workspace: root }),
    /only available in read_only mode/
  );
  await assert.rejects(
    () => handlers.runAntigravity({ prompt: "inspect", model: "gemini_pro", mode: "read_only", workspace: outside }),
    /izinli köklerin dışında/
  );
});

test("P0-ANTIGRAVITY-WORKSPACE: Gemini 3.8 Flash vault workspace'ini provider öncesi reddeder", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-antigravity-vault-"));
  const vault = path.join(root, "vault");
  const vaultChild = path.join(vault, "01_Projects");
  fs.mkdirSync(vaultChild, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let executions = 0;
  const handlers = createMcpToolHandlers({
    runtime: { async run() { executions += 1; return successResult("antigravity", "gemini-3.8-flash-high"); } },
    trustedWorkspace: root,
    configuration: { allowedRoots: [root], workspacePolicy: { antigravityDeniedRootPaths: [vault] } }
  });

  await assert.rejects(
    () => handlers.runAntigravity({ prompt: "inspect", model: "gemini_flash_3_8", mode: "read_only", workspace: vaultChild }),
    /korunan kökün içinde/
  );
  assert.equal(executions, 0);
});

test("P0-HOST: MCP trusted workspace requires explicit startup environment", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-host-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = { allowedRoots: [root], deepseek: { deniedRootPaths: [] } };
  assert.equal(resolveTrustedWorkspace(configuration, { SUBAGENT_BRIDGE_TRUSTED_WORKSPACE: `${root}${path.sep}` }), fs.realpathSync(root));
  assert.throws(() => resolveTrustedWorkspace(configuration, {}), /SUBAGENT_BRIDGE_TRUSTED_WORKSPACE is required/);
  assert.throws(() => resolveTrustedWorkspace({ allowedRoots: [], deepseek: { deniedRootPaths: [] } }, { SUBAGENT_BRIDGE_TRUSTED_WORKSPACE: root }), /requires at least one allowed root/);
});

test("P0-STATE: injected state paths own runtime directories", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "package");
  const stateRoot = path.join(root, "runtime");
  fs.mkdirSync(packageRoot);
  const configuration = createConfiguration(packageRoot, stateRoot);
  ensureRuntimeDirectories(configuration);
  assert.equal(fs.existsSync(path.join(configuration.statePaths.logs, "runs")), true);
  assert.equal(fs.existsSync(path.join(configuration.statePaths.logs, "metrics")), true);
  assert.equal(fs.existsSync(path.join(configuration.statePaths.state, "checkpoints")), true);
  assert.equal(fs.existsSync(configuration.statePaths.cache), true);
  assert.deepEqual(fs.readdirSync(packageRoot), []);
});

test("P0-PORTABILITY: trusted workspace wins over package and sibling repositories", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-portability-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "bridge-package");
  const repoA = path.join(root, "repo-A");
  const repoB = path.join(root, "repo-B");
  const stateRoot = path.join(root, "runtime-data");
  for (const directory of [packageRoot, repoA, repoB, stateRoot]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(repoA, "TEST_MARKER.txt"), "MARKER-A", "utf8");
  fs.writeFileSync(path.join(repoB, "TEST_MARKER.txt"), "MARKER-B", "utf8");

  const observed = [];
  const codex = createFakeAdapter("codex", async (request) => {
    observed.push(request.workspace);
    return successResult("codex", request.model, fs.readFileSync(path.join(request.workspace, "TEST_MARKER.txt"), "utf8"));
  });
  const runtime = createBridgeRuntime({
    configuration: createConfiguration(packageRoot, stateRoot),
    adapters: { codex }
  });

  const resultA = await runtime.run({ target: "codex", prompt: "read marker", mode: "read_only", trustedWorkspace: repoA, caller: "test", delegationDepth: 0 });
  const resultB = await runtime.run({ target: "codex", prompt: "read marker", mode: "read_only", trustedWorkspace: repoB, caller: "test", delegationDepth: 0 });

  assert.equal(resultA.result, "MARKER-A");
  assert.equal(resultB.result, "MARKER-B");
  assert.deepEqual(observed, [fs.realpathSync(repoA), fs.realpathSync(repoB)]);
  assert.ok(observed.every((workspace) => workspace !== fs.realpathSync(packageRoot)));
});

test("P0-RETRY: read-only transient failure retries and edit failure does not", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let readAttempts = 0;
  const codex = createFakeAdapter("codex", async (request) => {
    readAttempts += 1;
    if (readAttempts === 1) return failureResult("codex", request.model, "network error", "network");
    return successResult("codex", request.model);
  });
  const runtime = createBridgeRuntime({
    configuration: createConfiguration(root, root),
    adapters: { codex },
    sleep: async () => {}
  });
  const readResult = await runtime.run({ target: "codex", prompt: "inspect", mode: "read_only", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  assert.equal(readResult.ok, true);
  assert.equal(readAttempts, 2);
  assert.equal(readResult.metrics.retries, 1);

  let editAttempts = 0;
  codex.execute = async (request) => {
    editAttempts += 1;
    return failureResult("codex", request.model, "timed out", "timeout");
  };
  const editResult = await runtime.run({ target: "codex", prompt: "edit", mode: "edit", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  assert.equal(editResult.ok, false);
  assert.equal(editAttempts, 1);
  assert.equal(editResult.reason, "mutation_state_unknown");
});

test("P0-ANTIGRAVITY-RETRY: Antigravity retry backoff beklemesini uygular", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-antigravity-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let attempts = 0;
  const antigravity = createFakeAdapter("antigravity", async (request) => {
    attempts += 1;
    return attempts === 1
      ? failureResult("antigravity", request.model, "rate limited", "rate_limited")
      : successResult("antigravity", request.model);
  });
  const delays = [];
  const configuration = createConfiguration(root, root);
  configuration.reliability = { maxAttempts: 2, maxTotalDurationMs: 60000, maxRetryCostUsd: 1, maxRetryCostReserveUsd: 0.1, maxUnknownAttemptCostUsd: 0.1, baseRetryDelayMs: 10, maxRetryDelayMs: 10 };
  const runtime = createBridgeRuntime({
    configuration,
    adapters: { antigravity },
    sleep: async (delayMs) => { delays.push(delayMs); }
  });

  const result = await runtime.run({ target: "gemini_pro", prompt: "inspect", mode: "read_only", trustedWorkspace: root, caller: "test", delegationDepth: 0 });

  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= 0 && delays[0] <= 10);
});

test("P0-THROWN-EDIT: thrown timeout mutation state unknown olarak döner", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-thrown-edit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codex = createFakeAdapter("codex", async () => {
    throw new Error("execution timed out");
  });
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters: { codex } });
  const result = await runtime.run({ target: "codex", prompt: "edit", mode: "edit", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "mutation_state_unknown");
});

test("P0-COST-BUDGET: retry toplam maliyet sınırını aşmaz", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-cost-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = createConfiguration(root, root);
  configuration.codex.maxRetries = 2;
  configuration.reliability = { maxAttempts: 3, maxTotalDurationMs: 60000, maxRetryCostUsd: 1, baseRetryDelayMs: 0, maxRetryDelayMs: 0 };
  let attempts = 0;
  const codex = createFakeAdapter("codex", async (request) => {
    attempts += 1;
    return { ...failureResult("codex", request.model, "network error", "network"), metrics: { retries: 0, totalCostUsd: 0.6 } };
  });
  const runtime = createBridgeRuntime({ configuration, adapters: { codex }, sleep: async () => {} });
  const result = await runtime.run({ target: "codex", prompt: "inspect", mode: "read_only", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  assert.equal(result.ok, false);
  assert.equal(attempts, 1);
  assert.equal(result.metrics.totalCostUsd, 0.6);
});

test("P0-UNKNOWN-COST: bilinmeyen maliyet sınırlı retry rezervini kullanır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-unknown-cost-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let attempts = 0;
  const codex = createFakeAdapter("codex", async (request) => {
    attempts += 1;
    return { ...failureResult("codex", request.model, "network error", "network"), metrics: { retries: 0, totalCostUsd: null } };
  });
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters: { codex }, sleep: async () => {} });
  const result = await runtime.run({ target: "codex", prompt: "inspect", mode: "read_only", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "network");
  assert.equal(attempts, 2);
});

test("P0-CANCEL-BACKOFF: cancellation prevents a post-backoff execution", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-cancel-backoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let attempts = 0;
  let releaseBackoff;
  const backoffStarted = new Promise((resolve) => {
    releaseBackoff = resolve;
  });
  let continueBackoff;
  const backoffGate = new Promise((resolve) => {
    continueBackoff = resolve;
  });
  const codex = createFakeAdapter("codex", async (request) => {
    attempts += 1;
    if (attempts === 1) return failureResult("codex", request.model, "network error", "network");
    return successResult("codex", request.model);
  });
  const runtime = createBridgeRuntime({
    configuration: createConfiguration(root, root),
    adapters: { codex },
    sleep: async () => {
      releaseBackoff();
      await backoffGate;
    }
  });
  const executionId = "cancel-during-backoff";
  const running = runtime.run({ target: "codex", prompt: "inspect", mode: "read_only", trustedWorkspace: root, caller: "test", delegationDepth: 0, executionId });
  await backoffStarted;
  assert.equal(await runtime.cancel(executionId), true);
  continueBackoff();
  const result = await running;
  assert.equal(result.reason, "cancelled");
  assert.equal(attempts, 1);
});

test("P0-TIMEOUT: returned read-only timeout retains classification and retries", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-timeout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let attempts = 0;
  const codex = createFakeAdapter("codex", async (request) => {
    attempts += 1;
    if (attempts === 1) return failureResult("codex", request.model, "execution timed out", "timeout");
    return successResult("codex", request.model);
  });
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters: { codex }, sleep: async () => {} });
  const result = await runtime.run({ target: "codex", prompt: "inspect", mode: "read_only", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.metrics.retries, 1);
  assert.equal(attempts, 2);
});

test("P0-EDIT-EXIT: provider non-zero exit maps to unknown mutation state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-edit-exit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let attempts = 0;
  const codex = createFakeAdapter("codex", async (request) => {
    attempts += 1;
    return failureResult("codex", request.model, "process failed", "non_zero_exit");
  });
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters: { codex } });
  const result = await runtime.run({ target: "codex", prompt: "edit", mode: "edit", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "mutation_state_unknown");
  assert.equal(result.retryable, false);
  assert.equal(result.metrics.attempts.at(-1).failureClass, "process_exit");
  assert.equal(result.metrics.attempts.at(-1).retryDecision, "stop");
  assert.equal(result.metrics.attempts.at(-1).retryStopReason, "mutation_state_unknown");
  assert.equal(attempts, 1);
});

test("P0-DIAG: runtime adapter attempt tanısını ve retry kararını attempt kaydına taşır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-diagnostics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = createConfiguration(root, root);
  configuration.orchestration = { circuitBreaker: { failureThreshold: 5, windowMs: 60000, openMs: 30000 } };
  const antigravity = createFakeAdapter("antigravity", async (request) => ({
    ...failureResult("antigravity", request.model, "process failed", "process_exit"),
    metrics: {
      retries: 0,
      totalCostUsd: 0,
      diagnostics: {
        failureStage: "provider_execution",
        providerCode: "process_exit",
        settingsLockWaitMs: 5,
        providerExecutionMs: 25,
        stdoutBytes: 0,
        stderrBytes: 2048
      }
    }
  }));
  const runtime = createBridgeRuntime({ configuration, adapters: { antigravity }, sleep: async () => {} });
  const result = await runtime.run({ target: "gemini_flash_3_8", prompt: "inspect", mode: "read_only", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  const record = result.metrics.attempts.at(-1);
  assert.equal(result.ok, false);
  assert.equal(record.failureClass, "process_exit");
  assert.equal(record.failureStage, "provider_execution");
  assert.equal(record.providerCode, "process_exit");
  assert.equal(record.retryDecision, "stop");
  assert.equal(record.retryStopReason, "non_retryable_failure_class");
  assert.equal(record.settingsLockWaitMs, 5);
  assert.equal(record.providerExecutionMs, 25);
  assert.equal(record.stdoutBucket, "empty");
  assert.equal(record.stderrBucket, "lte_64_kib");
});

test("P0-EXECUTION-ID: duplicate active execution IDs are rejected", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-duplicate-id-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoA = path.join(root, "repo-A");
  const repoB = path.join(root, "repo-B");
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
  let releaseExecution;
  const gate = new Promise((resolve) => {
    releaseExecution = resolve;
  });
  let attempts = 0;
  const codex = createFakeAdapter("codex", async (request) => {
    attempts += 1;
    await gate;
    return successResult("codex", request.model);
  });
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters: { codex } });
  const executionId = "duplicate-id";
  const first = runtime.run({ target: "codex", prompt: "first", mode: "read_only", trustedWorkspace: repoA, caller: "test", delegationDepth: 0, executionId });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const duplicate = await runtime.run({ target: "codex", prompt: "second", mode: "read_only", trustedWorkspace: repoB, caller: "test", delegationDepth: 0, executionId });
  releaseExecution();
  await first;
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, "duplicate_execution_id");
  assert.equal(attempts, 1);
});

test("P0-LOCK: same canonical workspace blocks conflicting work and different workspace proceeds", async (t) => {
  releaseAllLocks();
  t.after(() => releaseAllLocks());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoA = path.join(root, "repo-A");
  const repoB = path.join(root, "repo-B");
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let executions = 0;
  const codex = createFakeAdapter("codex", async (request) => {
    executions += 1;
    if (request.prompt === "hold") await gate;
    return successResult("codex", request.model);
  });
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters: { codex } });

  const holding = runtime.run({ target: "codex", prompt: "hold", mode: "edit", trustedWorkspace: `${repoA}${path.sep}`, caller: "test", delegationDepth: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const queued = runtime.run({ target: "codex", prompt: "same", mode: "read_only", trustedWorkspace: repoA, caller: "test", delegationDepth: 0 });
  const parallel = await runtime.run({ target: "codex", prompt: "other", mode: "read_only", trustedWorkspace: repoB, caller: "test", delegationDepth: 0 });
  releaseFirst();
  await holding;
  const queuedResult = await queued;

  assert.equal(queuedResult.ok, true);
  assert.ok(queuedResult.metrics.queueWaitMs > 0);
  assert.equal(parallel.ok, true);
  assert.equal(executions, 3);
});

test("P0-CANCEL: runtime delegates cancellation by execution ID", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let cancelledExecutionId = null;
  let resolveExecution;
  const codex = createFakeAdapter("codex", async (request) => new Promise((resolve) => {
    resolveExecution = () => resolve(failureResult("codex", request.model, "execution cancelled", "cancelled"));
  }));
  codex.cancel = async (executionId) => {
    cancelledExecutionId = executionId;
    resolveExecution();
  };
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters: { codex } });
  const executionId = "frontend-owned-execution";
  const running = runtime.run({ target: "codex", prompt: "wait", mode: "read_only", trustedWorkspace: root, caller: "test", delegationDepth: 0, executionId });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await runtime.cancel(executionId), true);
  const result = await running;
  assert.equal(cancelledExecutionId, executionId);
  assert.equal(result.reason, "cancelled");
});

test("P0-DEEPSEEK: public workspace ignored ve canonical runtime kullanılır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trustedWorkspace = path.join(root, "trusted");
  const injectedWorkspace = path.join(root, "injected");
  fs.mkdirSync(trustedWorkspace);
  fs.mkdirSync(injectedWorkspace);
  let observedRequest = null;
  const structuredResult = JSON.stringify({
    status: "completed",
    summary: "checkpoint-secret-marker-should-not-persist",
    findings: [],
    proposed_steps: [],
    risks: [],
    questions: [],
    requires_human_approval: false
  });
  const opencode = createFakeAdapter("opencode", async (request) => {
    observedRequest = request;
    return successResult("opencode", request.model, structuredResult);
  });
  const runtime = createBridgeRuntime({
    configuration: createConfiguration(root, root),
    adapters: { opencode }
  });
  const handlers = createMcpToolHandlers({ runtime, trustedWorkspace, caller: "openCode" });
  const deepSeekResponse = await handlers.runDeepSeek({
    taskId: "legacy-workspace-test",
    role: "analyst",
    model: "deepseek_flash",
    objective: "inspect",
    workspace: injectedWorkspace,
    files: [],
    contextFiles: [],
    skills: [],
    acceptanceCriteria: ["trusted workspace wins"]
  });
  assert.equal(observedRequest.workspace, fs.realpathSync(trustedWorkspace));
  assert.notEqual(observedRequest.workspace, fs.realpathSync(injectedWorkspace));
  assert.equal(observedRequest.model, "deepseek/deepseek-v4-flash");
  assert.equal(deepSeekResponse.structuredContent.result.summary, "checkpoint-secret-marker-should-not-persist");
  const checkpointDirectory = path.join(root, "state", "checkpoints");
  const checkpointEntry = fs.readdirSync(checkpointDirectory)[0];
  const checkpoint = fs.readFileSync(path.join(checkpointDirectory, checkpointEntry), "utf8");
  assert.equal(checkpoint.includes("checkpoint-secret-marker-should-not-persist"), false);
  assert.equal(checkpoint.includes("legacy-workspace-test"), false);
  assert.equal(checkpointEntry.includes("legacy-workspace-test"), false);
});

test("P0-DEEPSEEK-SCHEMA: geçersiz çıktı canonical runtime tarafından onarılır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-deepseek-schema-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let attempts = 0;
  const prompts = [];
  const opencode = createFakeAdapter("opencode", async (request) => {
    attempts += 1;
    prompts.push(request.prompt);
    const result = attempts === 1 ? JSON.stringify({ status: "completed" }) : JSON.stringify({
      status: "completed",
      summary: "completed",
      findings: [],
      proposed_steps: [],
      risks: [],
      questions: [],
      requires_human_approval: false
    });
    return successResult("opencode", request.model, result);
  });
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters: { opencode }, sleep: async () => {} });
  const result = await runtime.runDeepSeek({
    taskId: "deepseek-schema-repair",
    role: "analyst",
    model: "deepseek_pro",
    objective: "inspect",
    workspace: root,
    files: [],
    contextFiles: [],
    skills: [],
    acceptanceCriteria: ["structured output"]
  }, root);
  assert.equal(result.result.status, "completed");
  assert.equal(attempts, 2);
  assert.match(prompts[1], /previous response failed/i);
  assert.match(prompts[1], /schema repair attempt 1/i);
  assert.match(prompts[1], /summary:/i);
});

test("P0-HEALTH: runtime returns canonical adapter health", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-health-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapters = {};
  for (const id of ["antigravity", "codex", "claude_code", "opencode"]) {
    const adapter = createFakeAdapter(id, async () => successResult(id, "test"));
    adapter.healthCheck = async () => ({ installed: true, version: "1.0", authValid: true, executable: id });
    adapters[id] = adapter;
  }
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters });
  const health = await runtime.health();
  await runtime.health();
  assert.deepEqual(Object.keys(health.adapters).sort(), ["antigravity", "claude_code", "codex", "opencode"]);
  assert.ok(Object.values(health.adapters).every((entry) => entry.health.installed));
  assert.ok(Object.hasOwn(health.circuits, "antigravity"));
  assert.ok(Object.hasOwn(health.circuits, "antigravity:gemini_flash_3_8"));
  const healthMetricsPath = path.join(root, "logs", "metrics", "bridge-health-runs.jsonl");
  assert.equal(fs.readFileSync(healthMetricsPath, "utf8").trim().split("\n").length, 1);
});

test("P0-MCP-PARITY: MCP handler and direct runtime preserve canonical result fields", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-parity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codex = createFakeAdapter("codex", async (request) => successResult("codex", request.model, request.workspace));
  const runtime = createBridgeRuntime({ configuration: createConfiguration(root, root), adapters: { codex } });
  const direct = await runtime.run({ target: "codex", prompt: "inspect", mode: "read_only", trustedWorkspace: root, caller: "openCode", delegationDepth: 0 });
  const handlers = createMcpToolHandlers({ runtime, trustedWorkspace: root, caller: "openCode" });
  const mcp = await handlers.runCodex({ prompt: "inspect", mode: "read_only" });
  const fields = ["backend", "model", "ok", "retryable", "timedOut", "reason", "result"];
  for (const field of fields) assert.equal(mcp.structuredContent[field], direct[field]);
  assert.equal(mcp.structuredContent.metrics.retries, direct.metrics.retries);
});

test("P0-CIRCUIT: named provider circuit açıldığında fallback yapmadan fail-fast döner", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-circuit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = createConfiguration(root, root);
  configuration.orchestration = { circuitBreaker: { failureThreshold: 1, windowMs: 60000, openMs: 30000 } };
  let codexAttempts = 0;
  let antigravityAttempts = 0;
  const codex = createFakeAdapter("codex", async (request) => {
    codexAttempts += 1;
    return failureResult("codex", request.model, "network error", "network");
  });
  const antigravity = createFakeAdapter("antigravity", async (request) => {
    antigravityAttempts += 1;
    return successResult("antigravity", request.model);
  });
  const runtime = createBridgeRuntime({ configuration, adapters: { codex, antigravity }, sleep: async () => {} });
  const first = await runtime.run({ target: "codex", prompt: "inspect", mode: "read_only", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  const second = await runtime.run({ target: "codex", prompt: "inspect", mode: "read_only", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  assert.equal(first.ok, false);
  assert.equal(second.reason, "provider_circuit_open");
  assert.equal(codexAttempts, 2);
  assert.equal(antigravityAttempts, 0);
});

test("P0-CIRCUIT: Antigravity circuit modeli diğer Gemini modellerinden ayırır", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-antigravity-circuit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = createConfiguration(root, root);
  configuration.orchestration = { circuitBreaker: { failureThreshold: 1, windowMs: 60000, openMs: 30000 } };
  const antigravity = createFakeAdapter("antigravity", async (request) => request.model === "gemini_flash_3_7"
    ? failureResult("antigravity", request.model, "network error", "network")
    : successResult("antigravity", request.model));
  const runtime = createBridgeRuntime({ configuration, adapters: { antigravity }, sleep: async () => {} });
  await runtime.run({ target: "gemini_flash_3_7", prompt: "inspect", mode: "read_only", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  const blocked = await runtime.run({ target: "gemini_flash_3_7", prompt: "inspect", mode: "read_only", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  const available = await runtime.run({ target: "gemini_flash_3_8", prompt: "inspect", mode: "read_only", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  assert.equal(blocked.reason, "provider_circuit_open");
  assert.equal(available.ok, true);
});

test("P0-FALLBACK: yalnız read-only task profile policy hedeflerine geçer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-p0-profile-fallback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = createConfiguration(root, root);
  configuration.orchestration = {
    taskProfiles: {
      resilient_review: {
        target: "codex",
        mode: "read_only",
        priority: 10,
        cacheable: false,
        fallbackTargets: [{ target: "gemini_flash" }]
      }
    },
    circuitBreaker: { failureThreshold: 5, windowMs: 60000, openMs: 30000 }
  };
  let codexAttempts = 0;
  let antigravityAttempts = 0;
  const codex = createFakeAdapter("codex", async (request) => {
    codexAttempts += 1;
    return failureResult("codex", request.model, "network error", "network");
  });
  const antigravity = createFakeAdapter("antigravity", async (request) => {
    antigravityAttempts += 1;
    return successResult("antigravity", request.model, "fallback-result");
  });
  const runtime = createBridgeRuntime({ configuration, adapters: { codex, antigravity }, sleep: async () => {} });
  const result = await runtime.run({ target: "profile", profile: "resilient_review", prompt: "inspect", mode: "read_only", trustedWorkspace: root, caller: "test", delegationDepth: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.backend, "antigravity");
  assert.equal(result.result, "fallback-result");
  assert.equal(result.metrics.fallbacks, 1);
  assert.equal(codexAttempts, 2);
  assert.equal(antigravityAttempts, 1);
});
