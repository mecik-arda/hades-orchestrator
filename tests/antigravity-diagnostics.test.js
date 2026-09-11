import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyAntigravityError, createAntigravityAdapter } from "../subagent-bridge/src/adapters/antigravity-adapter.js";
import { outputSizeBucket } from "../subagent-bridge/src/metrics.js";
import { validateSubagentResult } from "../subagent-bridge/src/schemas/core-schemas.js";

const fixturePath = fileURLToPath(new URL("./fixtures/antigravity-provider-fixture.js", import.meta.url));

async function executeFixture(scenario, { workspace, timeoutMs = 30000, executionTimeoutMs = 30000, model = "gemini_flash_3_8" }) {
  const adapter = createAntigravityAdapter({
    antigravity: {
      executable: process.execPath,
      execArgs: [fixturePath, scenario],
      timeoutMs,
      defaultSandbox: false
    }
  });
  return adapter.execute({
    executionId: crypto.randomUUID(),
    backend: "antigravity",
    prompt: "inspect fixture",
    model,
    mode: "edit",
    workspace,
    delegationDepth: 0,
    caller: "test",
    timeoutMs: executionTimeoutMs
  });
}

function fixtureDirectory(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agy-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("AGD-01: başarılı provider çalışması süre ve boyut tanısı taşır", async (t) => {
  const root = fixtureDirectory(t, "success");
  const result = await executeFixture("success", { workspace: root });
  assert.equal(result.ok, true);
  assert.equal(result.result, "fixture-ok");
  assert.equal(validateSubagentResult(result).success, true);
  const diagnostics = result.metrics.diagnostics;
  assert.equal(diagnostics.failureStage, null);
  assert.equal(diagnostics.providerCode, null);
  assert.equal(diagnostics.settingsLockWaitMs, null);
  assert.equal(Number.isInteger(diagnostics.providerExecutionMs), true);
  assert.equal(diagnostics.providerExecutionMs >= 0, true);
  assert.equal(diagnostics.stdoutBytes, Buffer.byteLength(`${JSON.stringify({ response: "fixture-ok" })}\n`, "utf8"));
  assert.equal(diagnostics.stderrBytes, 0);
  assert.equal(outputSizeBucket(diagnostics.stdoutBytes), "lte_1_kib");
  assert.equal(outputSizeBucket(diagnostics.stderrBytes), "empty");
});

test("AGD-02: sınıflandırılamayan çıkış gerçek kod ile process_exit olur", async (t) => {
  const root = fixtureDirectory(t, "process-exit");
  const result = await executeFixture("process_exit", { workspace: root });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "process_exit");
  assert.equal(result.retryable, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.metrics.diagnostics.failureStage, "provider_execution");
  assert.equal(result.metrics.diagnostics.providerCode, "process_exit");
  assert.equal(outputSizeBucket(result.metrics.diagnostics.stderrBytes), "lte_1_kib");
  assert.equal(outputSizeBucket(result.metrics.diagnostics.stdoutBytes), "empty");
});

test("AGD-03: RESOURCE_EXHAUSTED rate_limited ve resource_exhausted olur", async (t) => {
  const root = fixtureDirectory(t, "rate-limited");
  const result = await executeFixture("rate_limited", { workspace: root });
  assert.equal(result.reason, "rate_limited");
  assert.equal(result.retryable, true);
  assert.equal(result.metrics.diagnostics.providerCode, "resource_exhausted");
  assert.equal(result.metrics.diagnostics.failureStage, "provider_execution");
});

test("AGD-04: 503 yanıtı server ve unavailable olur", async (t) => {
  const root = fixtureDirectory(t, "server");
  const result = await executeFixture("server", { workspace: root });
  assert.equal(result.reason, "server");
  assert.equal(result.retryable, true);
  assert.equal(result.metrics.diagnostics.providerCode, "unavailable");
});

test("AGD-05: UNAUTHENTICATED authentication_failure olur ve retry edilmez", async (t) => {
  const root = fixtureDirectory(t, "auth");
  const result = await executeFixture("auth", { workspace: root });
  assert.equal(result.reason, "authentication_failure");
  assert.equal(result.retryable, false);
  assert.equal(result.metrics.diagnostics.providerCode, "unauthenticated");
});

test("AGD-06: ECONNRESET network ve connection_reset olur", async (t) => {
  const root = fixtureDirectory(t, "network");
  const result = await executeFixture("network", { workspace: root });
  assert.equal(result.reason, "network");
  assert.equal(result.retryable, true);
  assert.equal(result.metrics.diagnostics.providerCode, "connection_reset");
});

test("AGD-07: boş çıktı result_parse aşamasında empty_output olur", async (t) => {
  const root = fixtureDirectory(t, "empty");
  const result = await executeFixture("empty", { workspace: root });
  assert.equal(result.reason, "empty_output");
  assert.equal(result.retryable, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.metrics.diagnostics.failureStage, "result_parse");
  assert.equal(result.metrics.diagnostics.providerCode, "empty_output");
  assert.equal(outputSizeBucket(result.metrics.diagnostics.stdoutBytes), "empty");
  assert.equal(outputSizeBucket(result.metrics.diagnostics.stderrBytes), "empty");
});

test("AGD-08: çok baytlı çıktı UTF-8 bayt uzunluğuyla ölçülür", async (t) => {
  const root = fixtureDirectory(t, "unicode");
  const result = await executeFixture("unicode", { workspace: root });
  assert.equal(result.reason, "process_exit");
  assert.equal(result.metrics.diagnostics.stderrBytes, 1200);
  assert.equal(result.metrics.diagnostics.stderrBytes >= 1025, true);
  assert.equal(outputSizeBucket(result.metrics.diagnostics.stderrBytes), "lte_64_kib");
});

test("AGD-09: timeout provider_execution aşamasında sınıflanır", async (t) => {
  const root = fixtureDirectory(t, "timeout");
  const result = await executeFixture("hang", { workspace: root, timeoutMs: 1000, executionTimeoutMs: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.metrics.diagnostics.failureStage, "provider_execution");
  assert.equal(result.metrics.diagnostics.providerCode, "timeout");
  assert.equal(Number.isInteger(result.metrics.diagnostics.providerExecutionMs), true);
});

test("AGD-10: sunucu ve kimlik sinyalleri ayrı provider kodlarına eşlenir", () => {
  const cases = [
    ["HTTP 500 internal server error", "internal_error"],
    ["HTTP 502 bad gateway", "bad_gateway"],
    ["HTTP 504 gateway timeout", "gateway_timeout"],
    ["HTTP 503 service unavailable", "unavailable"],
    ["HTTP 401 unauthorized", "unauthenticated"]
  ];
  for (const [stderr, providerCode] of cases) {
    const classification = classifyAntigravityError(null, 1, "", stderr);
    assert.equal(classification.valid, false);
    assert.equal(classification.providerCode, providerCode, stderr);
  }
});
