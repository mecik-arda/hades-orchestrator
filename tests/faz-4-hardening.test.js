import test from "node:test";
import assert from "node:assert/strict";
import { appendRedactedRunMetric, createRedactedRunMetric } from "../subagent-bridge/src/metrics.js";
import { validateAgentsConfig, loadAgentsConfig, loadRuntimeConfiguration } from "../subagent-bridge/src/config.js";
import { createClaudeCodeAdapter } from "../subagent-bridge/src/adapters/claude-code-adapter.js";
import { createAntigravityAdapter } from "../subagent-bridge/src/adapters/antigravity-adapter.js";
import { createOpenCodeAdapter } from "../subagent-bridge/src/adapters/opencode-adapter.js";
import { createCodexAdapter } from "../subagent-bridge/src/adapters/codex-adapter.js";
import { checkCapability } from "../subagent-bridge/src/services/capability-service.js";
import { createDelegationGuard } from "../subagent-bridge/src/services/delegation-guard.js";
import { acquireReadLock, releaseReadLock, acquireWriteLock, releaseWriteLock, releaseAllLocks } from "./support/workspace-lock.js";
import { shouldRetry, isMutationStateUnknown } from "../subagent-bridge/src/services/retry-service.js";
import { validateSubagentResult, validateHealthResult, subagentExecutionRequestSchema } from "../subagent-bridge/src/schemas/core-schemas.js";

const configuration = {
  packageRoot: process.cwd(),
  statePaths: {
    logs: process.cwd(),
    state: process.cwd(),
    cache: process.cwd()
  },
  observability: { maxMetricFileBytes: 20971520 }
};

const claudeAdapter = createClaudeCodeAdapter(configuration);
const agyAdapter = createAntigravityAdapter(configuration);
const opencodeAdapter = createOpenCodeAdapter(configuration);
const codexAdapter = createCodexAdapter(configuration);

const allAdapters = [claudeAdapter, agyAdapter, opencodeAdapter, codexAdapter];

test("HARDEN-01: tüm adapter AgentAdapter kontratını uygular", () => {
  for (const adapter of allAdapters) {
    assert.equal(typeof adapter.id, "string");
    assert.ok(adapter.capabilities.canRead);
    assert.equal(typeof adapter.healthCheck, "function");
    assert.equal(typeof adapter.execute, "function");
    assert.equal(typeof adapter.cancel, "function");
  }
});

test("HARDEN-02: tüm adapter sağlık kontrolü yanıt verir", async () => {
  for (const adapter of allAdapters) {
    const health = await adapter.healthCheck();
    assert.equal(typeof health.installed, "boolean");
    assert.equal(validateHealthResult(health).success, true);
  }
});

test("HARDEN-03: tüm adapter capability check doğru mod eşleşir", () => {
  for (const adapter of allAdapters) {
    const readCheck = checkCapability(adapter, "read_only");
    assert.ok(readCheck.allowed);

    if (adapter.capabilities.canWrite) {
      const editCheck = checkCapability(adapter, "edit");
      assert.ok(editCheck.allowed);
    }
  }
});

test("HARDEN-04: tüm adapter edit mutation_state_unknown no retry", () => {
  for (const adapter of allAdapters) {
    if (adapter.capabilities.canWrite) {
      assert.equal(isMutationStateUnknown("edit", "timeout"), true);
      assert.equal(shouldRetry("timeout", "edit", 1, 3).retryable, false);
    }
  }
});

test("HARDEN-05: tüm backend için SubagentResult valid", () => {
  for (const adapter of allAdapters) {
    const result = {
      ok: true,
      backend: adapter.id,
      model: "test-model",
      result: "test output",
      error: null,
      retryable: false,
      timedOut: false,
      exitCode: 0,
      durationMs: 100,
      metrics: { retries: 0 }
    };
    assert.equal(validateSubagentResult(result).success, true);
  }
});

test("HARDEN-06: aynı workspace üzerinde write lock tüm okuma ve yazmayı bloke eder", async () => {
  releaseAllLocks();
  const workspace = configuration.packageRoot;

  const read1 = acquireReadLock(workspace);
  const read2 = acquireReadLock(workspace);
  assert.ok(read1);
  assert.ok(read2);
  releaseReadLock(workspace);
  releaseReadLock(workspace);

  const write = acquireWriteLock(workspace);
  assert.ok(write);
  assert.equal(acquireReadLock(workspace), false);
  assert.equal(acquireWriteLock(workspace), false);
  releaseWriteLock(workspace);
});

test("HARDEN-06b: lock workspace domain ortaktır, backend bazlı bağımsız değildir", () => {
  releaseAllLocks();
  const workspaceA = configuration.packageRoot;
  const fakeWorkspaceB = configuration.packageRoot + "\\diger";

  const writeA = acquireWriteLock(workspaceA);
  assert.ok(writeA);

  const readSameWs = acquireReadLock(workspaceA);
  assert.equal(readSameWs, false, "ayni workspace uzerinde write lock read bloke eder");

  releaseWriteLock(workspaceA);

  const readAfter = acquireReadLock(workspaceA);
  assert.ok(readAfter, "write release sonrasi okuma izin verilir");
  releaseReadLock(workspaceA);
});

test("HARDEN-07: delegation guard tüm backend için çalışır", () => {
  const guard = createDelegationGuard();
  for (const adapter of allAdapters) {
    const check = guard.check(0, adapter.id);
    assert.ok(check.allowed);
    assert.equal(check.nextDepth, 1);

    const deepCheck = guard.check(1, adapter.id);
    assert.equal(deepCheck.allowed, false);
  }
});

test("HARDEN-08: SubagentExecutionRequest strict schema tüm backend için", () => {
  for (const adapter of allAdapters) {
    const valid = subagentExecutionRequestSchema.safeParse({
      executionId: "test-1",
      backend: adapter.id,
      prompt: "test",
      model: "test-model",
      mode: "read_only",
      workspace: configuration.packageRoot,
      delegationDepth: 0,
      caller: "test",
      timeoutMs: 30000
    });
    assert.equal(valid.success, true);

    const injected = subagentExecutionRequestSchema.safeParse({
      executionId: "test-2",
      backend: "injected",
      prompt: "test",
      model: "test-model",
      mode: "read_only",
      workspace: configuration.packageRoot,
      delegationDepth: 0,
      caller: "test",
      timeoutMs: 30000,
      hackedField: "should-be-stripped"
    });
    assert.equal(injected.success, false);
  }
});

test("HARDEN-09: metrics backend ayrımı doğru dosyalanır", () => {
  const checkpoint = {
    runId: "test-run",
    taskId: "test-task",
    agent: "subagent",
    role: "analyst",
    model: "test-model",
    result: { status: "completed" },
    failureClass: null,
    usage: { durationMs: 100 },
    attempts: []
  };

  for (const adapter of allAdapters) {
    const metric = createRedactedRunMetric(checkpoint, adapter.id);
    assert.equal(metric.backend, adapter.id);
    assert.equal(typeof metric.recordedAt, "string");
    assert.equal(typeof metric.runIdHash, "string");
  }
});

test("HARDEN-10: agents.json valid yapılandırma kabul edilir", () => {
  const valid = validateAgentsConfig({
    agents: {
      claude_code: { enabled: true, executable: "C:\\tools\\claude.exe", timeoutMs: 900000, maxRetries: 2, mode: "read_only" },
      opencode: { enabled: true, executable: "C:\\tools\\opencode.exe", timeoutMs: 900000, maxRetries: 1 }
    }
  });
  assert.equal(valid.success, true);
});

test("HARDEN-11: agents.json geçersiz backend reddedilir", () => {
  const invalid1 = validateAgentsConfig({
    agents: { bad: { enabled: true, executable: "" } }
  });
  assert.equal(invalid1.success, false);

  const invalid2 = validateAgentsConfig({
    agents: { bad: { enabled: true, executable: "test", mode: "write_only" } }
  });
  assert.equal(invalid2.success, false);

  const invalid3 = validateAgentsConfig({
    agents: { opencode: { enabled: true, executable: "cmd", execArgs: ["/c", "opencode"] } }
  });
  assert.equal(invalid3.success, false);
});

test("HARDEN-12: agents.json production config yüklenir", () => {
  const config = loadAgentsConfig();
  assert.ok(config.agents);
  assert.equal(typeof config.agents, "object");
  const keys = Object.keys(config.agents);
  assert.ok(keys.length >= 3, `expected at least 3 agents, got ${keys.length}`);
  for (const [name, agent] of Object.entries(config.agents)) {
    assert.equal(typeof agent.enabled, "boolean");
    assert.ok(typeof agent.executable === "string" && agent.executable.length > 0);
  }
});

test("HARDEN-13: agents.json runtime adapter yapılandırmasına aktarılır", () => {
  const agents = loadAgentsConfig();
  const runtime = loadRuntimeConfiguration();

  for (const [name, agent] of Object.entries(agents.agents)) {
    assert.deepEqual(runtime[name], agent);
  }
});
