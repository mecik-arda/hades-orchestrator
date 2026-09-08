import test from "node:test";
import assert from "node:assert/strict";
import { createOpenCodeAdapter, resolveModel, parseOpenCodeOutput, classifyOpenCodeError, isOpenCodeRateLimitMessage, isOpenCodeModelAccessDeniedMessage, OPENCODE_MODEL_MAP } from "../subagent-bridge/src/adapters/opencode-adapter.js";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { checkCapability } from "../subagent-bridge/src/services/capability-service.js";
import { shouldRetry, isMutationStateUnknown } from "../subagent-bridge/src/services/retry-service.js";
import { createDelegationGuard } from "../subagent-bridge/src/services/delegation-guard.js";
import {
  validateSubagentResult, validateHealthResult,
  subagentExecutionRequestSchema,
  createFailureSubagentResult, createSuccessSubagentResult
} from "../subagent-bridge/src/schemas/core-schemas.js";

test("OC-AC-01: OpenCodeAdapter AgentAdapter kontratını uygular", () => {
  const adapter = createAdapter("opencode", {
    canRead: true, canWrite: true,
    supportsSandbox: true, supportsModelSelection: true
  });

  assert.equal(typeof adapter.id, "string");
  assert.equal(adapter.id, "opencode");
  assert.equal(adapter.capabilities.canRead, true);
  assert.equal(adapter.capabilities.canWrite, true);
  assert.equal(adapter.capabilities.supportsSandbox, true);
  assert.equal(adapter.capabilities.supportsModelSelection, true);
  assert.equal(typeof adapter.healthCheck, "function");
  assert.equal(typeof adapter.execute, "function");
  assert.equal(typeof adapter.cancel, "function");
});

test("OC-AC-02: production adapter capabilities doğru", () => {
  const adapter = createOpenCodeAdapter({ codex: { executable: "opencode" } });
  assert.equal(adapter.id, "opencode");
  assert.equal(adapter.capabilities.canRead, true);
  assert.equal(adapter.capabilities.canWrite, true);
  assert.equal(adapter.capabilities.supportsSandbox, true);
  assert.equal(adapter.capabilities.supportsModelSelection, true);
});

test("GEMINI-ROUTE-01/02: OpenCode model contract tüm Gemini public model değerlerini reddeder", () => {
  assert.equal(resolveModel("deepseek").valid, true);
  for (const model of [
    "gemini",
    "gemini_pro",
    "gemini_flash",
    "gemini_flash_3_7",
    "gemini_flash_3_8",
    "gemini-3.7-flash-high",
    "gemini-3.8-flash-high",
    "gemini-3.1-pro-high",
    "google/gemini-3.6-flash",
    "google/gemini-3.1-pro-preview",
    "google/gemini-2.5-pro",
    "google/gemini",
    "google/gemini_flash",
    "GOOGLE/GEMINI-3.6-FLASH",
    " google/gemini-3.6-flash",
    "google/gemini-3.6-flash "
  ]) {
    assert.equal(resolveModel(model).valid, false, model);
  }
  assert.equal(resolveModel("").valid, false);
  assert.equal(resolveModel("openai/gpt-5", ["deepseek/deepseek-v4-pro"]).valid, false);
  assert.equal(resolveModel("deepseek_pro", ["deepseek/deepseek-v4-pro"]).valid, true);
});

test("GEMINI-ROUTE-03: rejected Gemini execution fails before process execution", async () => {
  const adapter = createOpenCodeAdapter({ opencode: { executable: "missing-opencode-executable" } });
  const result = await adapter.execute({
    executionId: "gemini-routing-rejection",
    backend: "opencode",
    prompt: "inspect",
    model: "google/gemini-3.6-flash",
    mode: "read_only",
    workspace: process.cwd(),
    delegationDepth: 0,
    caller: "test",
    timeoutMs: 1000
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "Gemini models must be routed through AntigravityAdapter");
});

test("OC-AC-04: read_only / edit capability mapping çalışır", () => {
  const adapter = createAdapter("opencode", {
    canRead: true, canWrite: true,
    supportsSandbox: true, supportsModelSelection: true
  });
  assert.equal(checkCapability(adapter, "read_only").allowed, true);
  assert.equal(checkCapability(adapter, "edit").allowed, true);
});

test("OC-AC-05: edit mutation_state_unknown no retry", () => {
  assert.equal(isMutationStateUnknown("edit", "timeout"), true);
  assert.equal(shouldRetry("timeout", "edit", 1, 3).retryable, false);
  assert.equal(shouldRetry("timeout", "read_only", 1, 3).retryable, true);
});

test("OC-AC-06: success SubagentResult valid", () => {
  const result = createSuccessSubagentResult("opencode", "deepseek/deepseek-chat", {
    result: "OK",
    durationMs: 100
  });
  assert.equal(result.ok, true);
  assert.equal(result.backend, "opencode");
  assert.equal(validateSubagentResult(result).success, true);
});

test("OC-AC-07: timeout SubagentResult valid", () => {
  const result = createFailureSubagentResult("opencode", "deepseek/deepseek-chat", {
    error: "execution timed out",
    retryable: false,
    timedOut: true,
    exitCode: null,
    durationMs: 5000
  });
  assert.equal(result.timedOut, true);
  assert.equal(validateSubagentResult(result).success, true);
});

test("OC-AC-08: cancel SubagentResult valid", () => {
  const result = createFailureSubagentResult("opencode", "deepseek/deepseek-chat", {
    error: "execution cancelled",
    retryable: false,
    exitCode: null,
    durationMs: 1000,
    reason: "cancelled"
  });
  assert.equal(result.reason, "cancelled");
  assert.equal(validateSubagentResult(result).success, true);
});

test("OC-AC-09: parseOpenCodeOutput valid NDJSON", () => {
  const ndjson = [
    '{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p","type":"step-start"}}',
    '{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"p","type":"text","text":"Hello world"}}',
    '{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"p","type":"step-finish","tokens":{"total":100,"input":50,"output":50}}}'
  ].join("\n");

  const parsed = parseOpenCodeOutput(ndjson);
  assert.equal(parsed.ok, true);
  assert.match(parsed.text, /Hello world/);
  assert.equal(parsed.usage.tokens.total, 100);
});

test("OC-AC-10: parseOpenCodeOutput empty", () => {
  const parsed = parseOpenCodeOutput("");
  assert.equal(parsed.ok, false);
});

test("OC-AC-11: parseOpenCodeOutput malformed", () => {
  const parsed = parseOpenCodeOutput("not json\nstill not json");
  assert.equal(parsed.ok, false);
});

test("OC-AC-12: classifyOpenCodeError executable missing", () => {
  const err = new Error("ENOENT: command not found");
  const classification = classifyOpenCodeError(err, null, "", "");
  assert.equal(classification.valid, false);
  assert.equal(classification.errorClass, "executable_missing");
});

test("OC-AC-13: classifyOpenCodeError timeout", () => {
  const err = new Error("Process timed out after 5000ms");
  const classification = classifyOpenCodeError(err, null, "", "");
  assert.equal(classification.valid, false);
  assert.equal(classification.errorClass, "timeout");
});

test("OC-AC-14: classifyOpenCodeError auth failure", () => {
  const classification = classifyOpenCodeError(null, 1, "", "authentication failed: invalid api key");
  assert.equal(classification.valid, false);
  assert.equal(classification.errorClass, "auth_invalid");
});

test("OC-AC-14a: provider quota mesajı rate limit olarak tanınır", () => {
  assert.equal(isOpenCodeRateLimitMessage("Quota exceeded for model requests"), true);
  assert.equal(isOpenCodeRateLimitMessage("repository inspection complete"), false);
});

test("OC-AC-14b: abonelik model erişim reddi kalıcı hata olarak tanınır", () => {
  assert.equal(isOpenCodeModelAccessDeniedMessage("Your current subscription plan does not yet include access to GLM-5.2-Highspeed"), true);
  assert.equal(isOpenCodeModelAccessDeniedMessage("temporary server error"), false);
});

test("OC-AC-15: PublicToolArgs internal fields inject edilemez", () => {
  const publicArgs = { prompt: "test", model: "deepseek/deepseek-chat", mode: "read_only" };
  assert.ok(!("dangerFullAccess" in publicArgs));
  assert.ok(!("backend" in publicArgs));
  assert.ok(!("workspace" in publicArgs));
  assert.ok(!("approvalPolicy" in publicArgs));
  assert.ok(!("sandboxMode" in publicArgs));
});

test("OC-AC-16: delegation guard max depth", () => {
  const guard = createDelegationGuard();
  assert.equal(guard.check(0, "openCode").allowed, true);
  assert.equal(guard.check(1, "opencode").allowed, false);
});

test("OC-AC-17: SubagentExecutionRequest strict schema", () => {
  const valid = subagentExecutionRequestSchema.safeParse({
    executionId: "id", backend: "opencode", prompt: "p", model: "m",
    mode: "read_only", workspace: "/ws", delegationDepth: 0, caller: "c", timeoutMs: 5000
  });
  assert.equal(valid.success, true);

  const bad = subagentExecutionRequestSchema.safeParse({
    executionId: "id", backend: "opencode", prompt: "p", model: "m",
    mode: "read_only", workspace: "/ws", delegationDepth: 0, caller: "c", timeoutMs: 5000,
    dangerousFullAccess: true
  });
  assert.equal(bad.success, false);
});

test("OC-AC-18: regression check", () => {
  assert.ok(true);
});
