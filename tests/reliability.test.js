import test from "node:test";
import assert from "node:assert/strict";
import { createRedactedRunMetric } from "../subagent-bridge/src/metrics.js";
import { resolveReliabilityBudget } from "../subagent-bridge/src/services/reliability-budget.js";
import { calculateRetryDelayMs, classifyProcessFailure, isRetryableFailure } from "../subagent-bridge/src/retry.js";
import { shouldRetry } from "../subagent-bridge/src/services/retry-service.js";
import { parseDeepSeekEnvelope, validateDeepSeekResult } from "../subagent-bridge/src/result.js";
import { createDeepSeekCheckpoint, hasExactModelId, normalizeOpenCodeDeepSeekResult, resolveDeepSeekModel } from "../subagent-bridge/src/deepseek.js";

function createStructuredResult(overrides = {}) {
  return {
    status: "completed",
    summary: "Doğrulanmış sonuç",
    findings: [{
      title: "Bulgu",
      evidence: "Kanıt",
      impact: "Etki",
      recommendation: "Öneri",
      confidence: "high"
    }],
    proposed_steps: ["Adım"],
    risks: [],
    questions: [],
    requires_human_approval: false,
    ...overrides
  };
}

test("DeepSeek structured output çalışma zamanında sıkı doğrulanır", () => {
  assert.equal(validateDeepSeekResult(createStructuredResult()).success, true);
  assert.equal(validateDeepSeekResult(createStructuredResult({ requires_human_approval: "false" })).success, false);
  assert.equal(validateDeepSeekResult(createStructuredResult({ unexpected: true })).success, false);
  const parsed = parseDeepSeekEnvelope(JSON.stringify({ structured_output: createStructuredResult() }));
  assert.equal(parsed.ok, true);
  const malformed = parseDeepSeekEnvelope("{");
  assert.equal(malformed.errorClass, "output_parse_invalid");
  const fenced = parseDeepSeekEnvelope("```json\n" + JSON.stringify(createStructuredResult()) + "\n```");
  assert.equal(fenced.ok, true);
  const wrapped = parseDeepSeekEnvelope("Sonuç:\n" + JSON.stringify(createStructuredResult()) + "\nTamamlandı.");
  assert.equal(wrapped.ok, true);
  const invalidSchema = parseDeepSeekEnvelope(JSON.stringify({ structured_output: { status: "completed" } }));
  assert.equal(invalidSchema.errorClass, "schema_invalid");
});

test("reliability-budget eksik config'te sonlu maxAttempts üretir", () => {
  const budget = resolveReliabilityBudget({}, "codex", 30000);
  assert.ok(Number.isFinite(budget.maxAttempts));
  assert.ok(budget.maxAttempts <= 10);
  assert.ok(Number.isFinite(budget.maxTotalDurationMs));
});

test("model_access_denied kalıcı hata sınıfıdır ve retry edilmez", () => {
  const decision = shouldRetry("model_access_denied", "read_only", 1, 3, {});
  assert.equal(decision.retryable, false);
  assert.equal(decision.reason, "non_retryable_failure_class");
});

test("yalnızca geçici hata sınıfları retry için uygundur", () => {
  assert.equal(classifyProcessFailure({ code: 1, stdout: "", stderr: "HTTP 429 rate limit" }), "rate_limited");
  assert.equal(classifyProcessFailure({ code: 1, stdout: "", stderr: "HTTP 503 service unavailable" }), "server");
  assert.equal(classifyProcessFailure({ code: 1, stdout: "", stderr: "network connection reset" }), "network");
  assert.equal(isRetryableFailure("rate_limited"), true);
  assert.equal(isRetryableFailure("schema_invalid"), true);
  assert.equal(isRetryableFailure("process_exit"), false);
  assert.equal(calculateRetryDelayMs(1, 1000, 8000, 0), 0);
  assert.equal(calculateRetryDelayMs(4, 1000, 8000, 1), 8000);
  assert.equal(calculateRetryDelayMs(1, 1000, 8000, 1, "rate_limited"), 4000);
  assert.equal(calculateRetryDelayMs(1, 1000, 8000, 0, "rate_limited"), 2000);
  assert.equal(calculateRetryDelayMs(2, 1000, 8000, 1, "rate_limited"), 8000);
});

test("retry maliyet rezervi kalan bütçe rezervden küçük olduğunda retry engeller", () => {
  const result = shouldRetry("rate_limited", "read_only", 1, 3, {
    maxRetryCostUsd: 1,
    maxRetryCostReserveUsd: 0.1,
    currentCost: 0.91
  });
  assert.equal(result.retryable, false);
  assert.equal(result.reason, "budget_reserved");
});

test("yerel metrik görev kimliği ve çalışma alanı yolunu saklamaz", () => {
  const metric = createRedactedRunMetric({
    runId: "private-task-123-run",
    taskId: "private-task-123",
    agent: "deepseek",
    role: "researcher",
    model: "deepseek-v4-pro[1m]",
    failureClass: null,
    usage: { durationMs: 1000, apiDurationMs: 900, turns: 2, totalCostUsd: 0.1 },
    result: createStructuredResult(),
    attempts: [{
      number: 1,
      failureClass: null,
      exitCode: 0,
      durationMs: 1000,
      apiDurationMs: 900,
      turns: 2,
      totalCostUsd: 0.1,
      retryDelayMs: null
    }]
  });
  const serializedMetric = JSON.stringify(metric);
  assert.equal(serializedMetric.includes("private-task-123"), false);
  assert.equal(metric.attempts.length, 1);
});

test("DeepSeek Flash seçimi configured flash modeline resolve edilir", () => {
  const configuration = { deepseek: { openCodeModel: "deepseek/deepseek-v4-pro", openCodeFlashModel: "deepseek/deepseek-v4-flash" } };
  assert.equal(resolveDeepSeekModel(configuration, "deepseek_pro"), "deepseek/deepseek-v4-pro");
  assert.equal(resolveDeepSeekModel(configuration, "deepseek_flash"), "deepseek/deepseek-v4-flash");
  assert.throws(() => resolveDeepSeekModel(configuration, "unknown"), /Desteklenmeyen/);
});

test("DeepSeek model health kontrolü yalnız tam model kimliğini kabul eder", () => {
  const models = "deepseek/deepseek-v4-pro\ndeepseek/deepseek-v4-flash-lite";
  assert.equal(hasExactModelId(models, "deepseek/deepseek-v4-pro"), true);
  assert.equal(hasExactModelId(models, "deepseek/deepseek-v4-flash"), false);
});

test("DeepSeek checkpoint gerçek deneme ve model kimliği ayrıntılarını korur", () => {
  const checkpoint = createDeepSeekCheckpoint({ taskId: "test", role: "analyst", model: "deepseek_pro" }, {
    ok: false,
    model: "deepseek/deepseek-v4-pro",
    resolvedModel: "deepseek/deepseek-v4-pro",
    exitCode: 1,
    durationMs: 200,
    reason: "timeout",
    metrics: {
      totalCostUsd: 0.2,
      attempts: [
        { number: 1, failureClass: "rate_limited", exitCode: 1, durationMs: 50, totalCostUsd: 0.1 },
        { number: 2, failureClass: "timeout", exitCode: null, durationMs: 150, totalCostUsd: 0.1 }
      ]
    }
  });
  assert.deepEqual(checkpoint.attempts.map((attempt) => attempt.failureClass), ["rate_limited", "timeout"]);
  assert.deepEqual(checkpoint.attempts.map((attempt) => attempt.durationMs), [50, 150]);
  assert.equal(checkpoint.requestedModel, "deepseek_pro");
  assert.equal(checkpoint.resolvedModel, "deepseek/deepseek-v4-pro");
  assert.equal(checkpoint.accessMode, "read_only");
});

test("OpenCode DeepSeek yalnız geçerli yapılandırılmış sonucu kabul eder", () => {
  const result = normalizeOpenCodeDeepSeekResult("Kısa danışmanlık özeti");
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "output_parse_invalid");
});
