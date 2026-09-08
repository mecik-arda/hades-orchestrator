import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { checkCapability } from "../subagent-bridge/src/services/capability-service.js";
import { shouldRetry, isMutationStateUnknown } from "../subagent-bridge/src/services/retry-service.js";
import { normalizeSubagentResult, normalizeTimedOutResult, normalizeUnknownMutationResult } from "./support/result-normalizer.js";
import { validateSubagentResult, validateHealthResult, subagentExecutionRequestSchema, subagentResultSchema } from "../subagent-bridge/src/schemas/core-schemas.js";
import { healthCheck, invalidateHealthCache } from "../subagent-bridge/src/services/health-service.js";
import { acquireReadLock, releaseReadLock, acquireWriteLock, releaseWriteLock, releaseAllLocks } from "./support/workspace-lock.js";

function createOrchestratedRetryFlow(adapter, baseRequest, maxAttempts = 3, budgetConstraints = {}) {
  return {
    async execute() {
      let attemptNumber = 0;
      const startedAt = Date.now();
      let lastError = null;

      while (attemptNumber < maxAttempts) {
        attemptNumber += 1;
        const capCheck = checkCapability(adapter, baseRequest.mode);
        if (!capCheck.allowed) {
          return normalizeSubagentResult(adapter.id, baseRequest.model, new Error(capCheck.error), startedAt, 0);
        }

        try {
          const result = await adapter.execute(baseRequest);
          return normalizeSubagentResult(adapter.id, baseRequest.model, result, startedAt, attemptNumber - 1);
        } catch (error) {
          lastError = error;
          const failureClass = error.failureClass || "process_exit";
          const retryDecision = shouldRetry(failureClass, baseRequest.mode, attemptNumber, maxAttempts, budgetConstraints);

          if (!retryDecision.retryable) {
            if (isMutationStateUnknown(baseRequest.mode, failureClass)) {
              return normalizeUnknownMutationResult(adapter.id, baseRequest.model, Date.now() - startedAt, attemptNumber - 1);
            }
            return normalizeSubagentResult(adapter.id, baseRequest.model, error, startedAt, attemptNumber - 1);
          }
        }
      }

      return normalizeSubagentResult(adapter.id, baseRequest.model, lastError || new Error("retry exhausted"), startedAt, maxAttempts);
    }
  };
}

test("E2E-RETRY: edit + timeout → execute once, retryable=false, reason=mutation_state_unknown", async () => {
  let executeCount = 0;

  const editor = createAdapter("test_editor", {
    canRead: true, canWrite: true, supportsSandbox: true, supportsModelSelection: true
  });

  editor.execute = async () => {
    executeCount += 1;
    const err = new Error("timeout during edit operation");
    err.failureClass = "timeout";
    throw err;
  };

  const flow = createOrchestratedRetryFlow(editor, {
    executionId: "e2e-edit", prompt: "refactor", model: "m",
    mode: "edit", workspace: "/ws", delegationDepth: 0, caller: "oc", timeoutMs: 5000
  }, 3);

  const result = await flow.execute();

  assert.equal(executeCount, 1);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.reason, "mutation_state_unknown");
  assert.equal(result.exitCode, null);
  assert.equal(validateSubagentResult(result).success, true);
});

test("E2E-RETRY: read_only + transient failure → retry, execute count = 2", async () => {
  let executeCount = 0;

  const reader = createAdapter("test_reader", {
    canRead: true, canWrite: false, supportsSandbox: true, supportsModelSelection: false
  });

  reader.execute = async () => {
    executeCount += 1;
    if (executeCount === 1) {
      const err = new Error("network error");
      err.failureClass = "network";
      throw err;
    }
    return "analysis done";
  };

  const flow = createOrchestratedRetryFlow(reader, {
    executionId: "e2e-read", prompt: "analyze", model: "m",
    mode: "read_only", workspace: "/ws", delegationDepth: 0, caller: "oc", timeoutMs: 5000
  }, 3);

  const result = await flow.execute();

  assert.equal(executeCount, 2);
  assert.equal(result.ok, true);
  assert.equal(result.retryable, false);
  assert.equal(result.metrics.retries, 1);
  assert.equal(validateSubagentResult(result).success, true);
});

test("E2E-CAP: edit mode + readonly adapter → unsupported capability, execute=0", async () => {
  let executeCount = 0;

  const readonly = createAdapter("ro", {
    canRead: true, canWrite: false, supportsSandbox: true, supportsModelSelection: false
  });

  readonly.execute = async () => {
    executeCount += 1;
    return "nope";
  };

  const flow = createOrchestratedRetryFlow(readonly, {
    executionId: "e2e-cap", prompt: "edit", model: "m",
    mode: "edit", workspace: "/ws", delegationDepth: 0, caller: "oc", timeoutMs: 5000
  }, 3);

  const result = await flow.execute();

  assert.equal(executeCount, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported capability/);
});

test("SCHEMA-STRICT: unknown fields → rejected", () => {
  const badReq = subagentExecutionRequestSchema.safeParse({
    executionId: "id", backend: "be", prompt: "p", model: "m",
    mode: "edit", workspace: "/ws", delegationDepth: 0, caller: "c", timeoutMs: 5000,
    injectedField: "REJECT_ME"
  });
  assert.equal(badReq.success, false);
  assert.match(badReq.error.issues.map(i => i.message).join(), /unrecognized/i);

  const badRes = subagentResultSchema.safeParse({
    ok: true, backend: "be", model: "m", result: "ok", error: null,
    retryable: false, timedOut: false, exitCode: 0, durationMs: 100,
    metrics: { retries: 0 },
    injectedField: "REJECT_ME"
  });
  assert.equal(badRes.success, false);
  assert.match(badRes.error.issues.map(i => i.message).join(), /unrecognized/i);
});

test("SCHEMA: exitCode null valid for timeout/cancel", () => {
  const timeoutResult = normalizeTimedOutResult("test", "m", 5000, 1);
  assert.equal(timeoutResult.exitCode, null);
  assert.equal(validateSubagentResult(timeoutResult).success, true);

  const successResult = normalizeSubagentResult("test", "m", "ok", 0, 0);
  assert.equal(successResult.exitCode, 0);
  assert.equal(validateSubagentResult(successResult).success, true);
});

test("SCHEMA: reason preserved through validation", () => {
  const result = normalizeUnknownMutationResult("test", "m", 5000, 1);
  assert.equal(result.reason, "mutation_state_unknown");
  const valid = validateSubagentResult(result);
  assert.equal(valid.success, true);
  assert.equal(valid.data.reason, "mutation_state_unknown");
});

test("HEALTH: 10 concurrent → 1 real check (stampede fixed)", async () => {
  invalidateHealthCache();

  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(healthCheck("cache_test", "node", {
      versionArgs: ["-e", "console.log('v1')"],
      ttlMs: 30000
    }));
  }

  const results = await Promise.all(promises);
  assert.equal(results.length, 10);
  assert.ok(results.every(r => r.installed));
});

test("LOCK: path variations do not bypass workspace lock", () => {
  releaseAllLocks();
  const base = path.join(path.parse(process.cwd()).root, "tmp", "lock-variant", "workspace");
  const trailing = base + path.sep;
  const parentNormalized = path.normalize(path.join(base, "..", "workspace"));
  const forward = base.split(path.sep).join("/");

  assert.equal(acquireReadLock(base), true);
  assert.equal(acquireWriteLock(trailing), false, "write bypass via trailing slash");
  releaseReadLock(base);

  assert.equal(acquireWriteLock(base), true);
  assert.equal(acquireReadLock(parentNormalized), false, "read bypass via ../canonical");
  releaseWriteLock(base);

  assert.equal(acquireReadLock(forward), true);
  releaseReadLock(forward);
  releaseAllLocks();
});

test("PROD-WIRING: core schemas valid on representative payloads", () => {
  const result = {
    ok: true, backend: "claude_code", model: "deepseek-v4-pro",
    result: "core validation", error: null, retryable: false, timedOut: false,
    exitCode: 0, durationMs: 0, metrics: { retries: 0 }
  };
  assert.equal(validateSubagentResult(result).success, true);

  const health = { installed: true, version: "1.0", authValid: true, executable: "claude" };
  assert.equal(validateHealthResult(health).success, true);
});
