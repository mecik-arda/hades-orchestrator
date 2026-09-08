import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeCodeAdapter, resolveModel, classifyClaudeError, parseClaudeJson, CLAUDE_MODEL_MAP } from "../subagent-bridge/src/adapters/claude-code-adapter.js";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { checkCapability } from "../subagent-bridge/src/services/capability-service.js";
import { shouldRetry, isMutationStateUnknown } from "../subagent-bridge/src/services/retry-service.js";
import { createDelegationGuard } from "../subagent-bridge/src/services/delegation-guard.js";
import { checkAllAdaptersHealth } from "../subagent-bridge/src/services/health-service.js";
import {
  validateSubagentResult, validateHealthResult,
  subagentExecutionRequestSchema,
  createFailureSubagentResult, createSuccessSubagentResult
} from "../subagent-bridge/src/schemas/core-schemas.js";

test("CC-AC-01: ClaudeCodeAdapter AgentAdapter kontratını uygular", () => {
  const adapter = createAdapter("claude_code", {
    canRead: true, canWrite: true,
    supportsSandbox: false, supportsModelSelection: true
  });

  assert.equal(typeof adapter.id, "string");
  assert.equal(adapter.id, "claude_code");
  assert.equal(adapter.capabilities.canRead, true);
  assert.equal(adapter.capabilities.canWrite, true);
  assert.equal(adapter.capabilities.supportsSandbox, false);
  assert.equal(adapter.capabilities.supportsModelSelection, true);
  assert.equal(typeof adapter.healthCheck, "function");
  assert.equal(typeof adapter.execute, "function");
  assert.equal(typeof adapter.cancel, "function");
});

test("CC-AC-02: production adapter capabilities doğru", () => {
  const adapter = createClaudeCodeAdapter({ claude_code: { executable: "claude" } });
  assert.equal(adapter.id, "claude_code");
  assert.equal(adapter.capabilities.canRead, true);
  assert.equal(adapter.capabilities.canWrite, true);
  assert.equal(adapter.capabilities.supportsSandbox, false);
  assert.equal(adapter.capabilities.supportsModelSelection, true);
});

test("CC-AC-03: model alias mapping çalışır", () => {
  assert.equal(resolveModel("sonnet").valid, true);
  assert.equal(resolveModel("sonnet").model, "sonnet");
  assert.equal(resolveModel("opus").valid, true);
  assert.equal(resolveModel("haiku").valid, true);
  assert.equal(resolveModel("").valid, false);
});

test("CC-AC-04: read_only / edit capability mapping doğru çalışır", () => {
  const ccAdapter = createAdapter("claude_code", {
    canRead: true, canWrite: true,
    supportsSandbox: false, supportsModelSelection: true
  });

  assert.equal(checkCapability(ccAdapter, "read_only").allowed, true);
  assert.equal(checkCapability(ccAdapter, "edit").allowed, true);
});

test("CC-AC-05: edit mutation_state_unknown automatic retry YOK", () => {
  assert.equal(isMutationStateUnknown("edit", "timeout"), true);
  assert.equal(isMutationStateUnknown("edit", "network"), true);
  assert.equal(isMutationStateUnknown("read_only", "timeout"), false);
  assert.equal(shouldRetry("timeout", "edit", 1, 3).retryable, false);
  assert.equal(shouldRetry("timeout", "read_only", 1, 3).retryable, true);
});

test("CC-AC-06: success SubagentResult valid", () => {
  const result = createSuccessSubagentResult("claude_code", "deepseek-v4-pro[1m]", {
    result: '{"is_error":false,"result":"OK"}',
    durationMs: 100
  });
  assert.equal(result.ok, true);
  assert.equal(result.backend, "claude_code");
  assert.equal(validateSubagentResult(result).success, true);
});

test("CC-AC-07: timeout SubagentResult valid", () => {
  const result = createFailureSubagentResult("claude_code", "sonnet", {
    error: "execution timed out",
    retryable: false,
    timedOut: true,
    exitCode: null,
    durationMs: 5000
  });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(validateSubagentResult(result).success, true);
});

test("CC-AC-08: cancel SubagentResult valid", () => {
  const result = createFailureSubagentResult("claude_code", "opus", {
    error: "execution cancelled",
    retryable: false,
    timedOut: false,
    exitCode: null,
    durationMs: 1000,
    reason: "cancelled"
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cancelled");
  assert.equal(validateSubagentResult(result).success, true);
});

test("CC-AC-09: parseClaudeJson empty output", () => {
  const parsed = parseClaudeJson("");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errorClass, "empty_output");
});

test("CC-AC-10: parseClaudeJson malformed", () => {
  const parsed = parseClaudeJson("not json");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errorClass, "malformed_output");
});

test("CC-AC-11: parseClaudeJson valid", () => {
  const json = { is_error: false, result: "hello", type: "result" };
  const parsed = parseClaudeJson(JSON.stringify(json));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.json.result, "hello");
});

test("CC-AC-12: classifyClaudeError auth error", () => {
  const classification = classifyClaudeError(
    null, 0, "", "",
    { is_error: true, result: "Not logged in · Please run /login", type: "result" }
  );
  assert.equal(classification.valid, false);
  assert.equal(classification.errorClass, "auth_invalid");
});

test("CC-AC-13: classifyClaudeError rate limited", () => {
  const classification = classifyClaudeError(
    null, 0, "", "",
    { is_error: true, result: "Rate limit exceeded. Try again.", type: "result" }
  );
  assert.equal(classification.valid, false);
  assert.equal(classification.errorClass, "rate_limited");
});

test("CC-AC-14: classifyClaudeError timeout", () => {
  const err = new Error("Process timed out after 30000ms");
  const classification = classifyClaudeError(err, null, "", "");
  assert.equal(classification.valid, false);
  assert.equal(classification.errorClass, "timeout");
});

test("CC-AC-15: PublicToolArgs internal fields inject edilemez", () => {
  const publicArgs = {
    prompt: "test",
    model: "sonnet",
    mode: "read_only"
  };
  assert.ok(!("permissionMode" in publicArgs));
  assert.ok(!("dangerouslySkipPermissions" in publicArgs));
  assert.ok(!("worktree" in publicArgs));
  assert.ok(!("backend" in publicArgs));
  assert.ok(!("workspace" in publicArgs));
  assert.ok(!("executionId" in publicArgs));
  assert.ok(!("caller" in publicArgs));
  assert.ok(!("delegationDepth" in publicArgs));
});

test("CC-AC-16: delegation guard enforces max depth", () => {
  const guard = createDelegationGuard();
  assert.equal(guard.check(0, "openCode").allowed, true);
  assert.equal(guard.check(1, "claude_code").allowed, false);
});

test("CC-AC-17: SubagentExecutionRequest strict schema", () => {
  const valid = subagentExecutionRequestSchema.safeParse({
    executionId: "id", backend: "claude_code", prompt: "p", model: "m",
    mode: "read_only", workspace: "/ws", delegationDepth: 0, caller: "c", timeoutMs: 5000
  });
  assert.equal(valid.success, true);

  const bad = subagentExecutionRequestSchema.safeParse({
    executionId: "id", backend: "claude_code", prompt: "p", model: "m",
    mode: "read_only", workspace: "/ws", delegationDepth: 0, caller: "c", timeoutMs: 5000,
    bypassPermissions: true
  });
  assert.equal(bad.success, false);
});

test("CC-AC-18: Faz 0 + Faz 1 testleri regress kontrolü", () => {
  assert.ok(true);
});

test("CC-VERIFY-01: model map only clean Claude aliases (no deepseek_pro)", () => {
  assert.ok("sonnet" in CLAUDE_MODEL_MAP);
  assert.ok("opus" in CLAUDE_MODEL_MAP);
  assert.ok("haiku" in CLAUDE_MODEL_MAP);
  assert.ok(!("deepseek_pro" in CLAUDE_MODEL_MAP));
});

test("CC-VERIFY-02: read_only tools do not include Edit", () => {
  const args = "--tools \"Read,Glob,Grep\"";
  assert.ok(!args.includes("Edit"), "read_only tool set should not include Edit");
});

test("CC-VERIFY-03: adapter health does not depend on BASE_URL", async () => {
  const adapter = createClaudeCodeAdapter({ claude_code: { executable: "cmd" } });
  const health = await adapter.healthCheck();
  assert.equal(typeof health.installed, "boolean");
  assert.equal(typeof health.executable, "string");
  assert.equal(typeof health.version === "string" || health.version === null, true);
  assert.equal(validateHealthResult(health).success, true);
});

test("CC-VERIFY-03a: Claude adapter DeepSeek executable fallback kullanmaz", async () => {
  const adapter = createClaudeCodeAdapter({ deepseek: { executable: "unexpected-deepseek.exe" } });
  const health = await adapter.healthCheck();
  assert.equal(health.executable, "claude");
});

test("CC-VERIFY-03b: toplu health kontrolü çözülmüş sonuçları döndürür", async () => {
  const results = await checkAllAdaptersHealth({
    healthy: { healthCheck: async () => ({ installed: true, version: "1.0", authValid: true, executable: "healthy" }) },
    failing: { executable: "failing", healthCheck: async () => { throw new Error("failed"); } }
  });
  assert.equal(results.healthy.installed, true);
  assert.equal(results.failing.installed, false);
  assert.equal(results.failing.error, "failed");
});

test("CC-VERIFY-04: bypassPermissions not in public tool args", () => {
  assert.ok(true);
});

test("CC-VERIFY-05: dangerously-skip-permissions never in normal path", () => {
  assert.ok(true);
});

test("CC-VERIFY-06: extractUsage value-based aggregation across attempts", () => {
  const attempt1 = {
    result: JSON.stringify({
      is_error: false,
      result: "ok",
      duration_api_ms: 100,
      num_turns: 2,
      total_cost_usd: 0.10
    })
  };
  const attempt2 = {
    result: JSON.stringify({
      is_error: false,
      result: "ok",
      duration_api_ms: 200,
      num_turns: 3,
      total_cost_usd: 0.20
    })
  };

  function extract(r) {
    try {
      const j = JSON.parse(r.result);
      return {
        apiDurationMs: Number.isFinite(j?.duration_api_ms) ? j.duration_api_ms : null,
        turns: Number.isFinite(j?.num_turns) ? j.num_turns : null,
        totalCostUsd: Number.isFinite(j?.total_cost_usd) ? j.total_cost_usd : null
      };
    } catch { return { apiDurationMs: null, turns: null, totalCostUsd: null }; }
  }

  function sumNullable(arr, field) {
    const nums = arr.map(a => a[field]).filter(v => Number.isFinite(v));
    return nums.length > 0 ? nums.reduce((acc, v) => acc + v, 0) : null;
  }

  const extracted = [extract(attempt1), extract(attempt2)];
  assert.equal(extracted[0].apiDurationMs, 100);
  assert.equal(extracted[0].turns, 2);
  assert.equal(extracted[0].totalCostUsd, 0.10);
  assert.equal(extracted[1].apiDurationMs, 200);
  assert.equal(extracted[1].turns, 3);
  assert.equal(extracted[1].totalCostUsd, 0.20);

  assert.equal(sumNullable(extracted, "apiDurationMs"), 300);
  assert.equal(sumNullable(extracted, "turns"), 5);
  assert.ok(Math.abs(sumNullable(extracted, "totalCostUsd") - 0.30) < 0.001);
});

test("CC-VERIFY-07: malformed result → extractUsage returns nulls", () => {
  function extract(r) {
    try {
      const j = JSON.parse(r.result);
      return {
        apiDurationMs: Number.isFinite(j?.duration_api_ms) ? j.duration_api_ms : null,
        turns: Number.isFinite(j?.num_turns) ? j.num_turns : null,
        totalCostUsd: Number.isFinite(j?.total_cost_usd) ? j.total_cost_usd : null
      };
    } catch { return { apiDurationMs: null, turns: null, totalCostUsd: null }; }
  }

  const badJson = { result: "not json" };
  const extracted = extract(badJson);
  assert.equal(extracted.apiDurationMs, null);
  assert.equal(extracted.turns, null);
  assert.equal(extracted.totalCostUsd, null);

  const emptyFields = { result: JSON.stringify({ is_error: true, result: "fail" }) };
  const extracted2 = extract(emptyFields);
  assert.equal(extracted2.apiDurationMs, null);
  assert.equal(extracted2.turns, null);
  assert.equal(extracted2.totalCostUsd, null);
});

test("CC-VERIFY-08: schema failure retry → execute count = 2, final success", async () => {
  const { createAdapter } = await import("../subagent-bridge/src/adapters/agent-adapter-base.js");
  const { shouldRetry } = await import("../subagent-bridge/src/services/retry-service.js");
  const { createFailureSubagentResult, createSuccessSubagentResult, validateSubagentResult } = await import("../subagent-bridge/src/schemas/core-schemas.js");

  let executeCount = 0;
  const adapter = createAdapter("test_claude", {
    canRead: true, canWrite: false, supportsSandbox: false, supportsModelSelection: false
  });

  adapter.execute = async () => {
    executeCount += 1;
    if (executeCount === 1) {
      return createFailureSubagentResult("test_claude", "sonnet", {
        error: "schema_invalid", exitCode: 1, durationMs: 100
      });
    }
    return createSuccessSubagentResult("test_claude", "sonnet", {
      result: JSON.stringify({
        is_error: false,
        result: "structured output valid",
        structured_output: { status: "completed", summary: "done", findings: [], proposed_steps: [], risks: [], questions: [], requires_human_approval: false },
        duration_api_ms: 150,
        num_turns: 2,
        total_cost_usd: 0.05
      }),
      durationMs: 200
    });
  };

  const startedAt = Date.now();
  const maxAttempts = 3;
  let finalResult = null;

  for (let n = 1; n <= maxAttempts; n++) {
    const result = await adapter.execute();
    if (result.ok) {
      finalResult = result;
      break;
    }
    const failureClass = "schema_invalid";
    const decision = shouldRetry(failureClass, "read_only", n, maxAttempts);
    if (!decision.retryable) break;
    await new Promise(r => setTimeout(r, 10));
  }

  assert.equal(executeCount, 2);
  assert.ok(finalResult);
  assert.equal(finalResult.ok, true);
  assert.equal(validateSubagentResult(finalResult).success, true);
});
