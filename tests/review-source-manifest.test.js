import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { createDeepSeekCheckpoint } from "../subagent-bridge/src/deepseek.js";
import { createGlmCheckpoint } from "../subagent-bridge/src/glm.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";
import { createFailureSubagentResult, createSuccessSubagentResult } from "../subagent-bridge/src/schemas/core-schemas.js";
import {
  createReviewSourceManifest,
  REVIEW_SOURCE_MAX_BUNDLE_BYTES,
  REVIEW_SOURCE_MAX_FILE_BYTES,
  REVIEW_SOURCE_MAX_FILES,
  REVIEW_SOURCE_MAX_TOTAL_BYTES
} from "../subagent-bridge/src/services/review-source-manifest.js";

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-source-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("RSM-01: manifest sorts selected paths and hashes exact host-read bytes", (t) => {
  const root = createWorkspace(t);
  const beta = Buffer.from("const beta = 2;\n", "utf8");
  const alpha = Buffer.from("const alpha = 1;\n", "utf8");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "beta.js"), beta);
  fs.writeFileSync(path.join(root, "src", "alpha.js"), alpha);

  const manifest = createReviewSourceManifest(root, ["src/beta.js", "src/alpha.js"]);

  assert.equal(manifest.version, 1);
  assert.equal(manifest.fileCount, 2);
  assert.equal(manifest.sourceBytes, beta.length + alpha.length);
  assert.equal(manifest.manifestSha256, sha256(Buffer.from(JSON.stringify({
    version: 1,
    hashAlgorithm: "sha256",
    entries: [
      { path: "src/alpha.js", sizeBytes: alpha.length, sha256: sha256(alpha) },
      { path: "src/beta.js", sizeBytes: beta.length, sha256: sha256(beta) }
    ]
  }), "utf8")));
  assert.ok(manifest.sourcePayload.indexOf("src/alpha.js") < manifest.sourcePayload.indexOf("src/beta.js"));
  assert.match(manifest.sourcePayload, /const alpha = 1;/u);
  assert.match(manifest.sourcePayload, /const beta = 2;/u);
  assert.ok(manifest.sourcePayloadBytes <= REVIEW_SOURCE_MAX_BUNDLE_BYTES);
});

test("RSM-02: manifests reject absolute, traversal, duplicate, denied, and sensitive paths", (t) => {
  const root = createWorkspace(t);
  fs.writeFileSync(path.join(root, "safe.js"), "const safe = true;\n");
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  fs.writeFileSync(path.join(root, "memory", "private.md"), "private data\n");
  fs.writeFileSync(path.join(root, ".env.local"), "NOT_A_REAL_SECRET\n");
  fs.mkdirSync(path.join(root, ".env"), { recursive: true });
  fs.writeFileSync(path.join(root, ".env", "values.json"), "{}\n");
  fs.mkdirSync(path.join(root, ".aws"), { recursive: true });
  fs.writeFileSync(path.join(root, ".aws", "credentials"), "profile test\n");

  for (const paths of [
    ["../outside.js"],
    [path.join(root, "safe.js")],
    ["safe.js", "safe.js"],
    ["memory/private.md"],
    [".env.local"],
    [".env/values.json"],
    [".aws/credentials"]
  ]) {
    assert.throws(() => createReviewSourceManifest(root, paths), { name: "ReviewSourceManifestError" });
  }
  if (process.platform === "win32") {
    assert.throws(() => createReviewSourceManifest(root, ["safe.js:stream"]), { code: "review_scope_invalid" });
    assert.throws(() => createReviewSourceManifest(root, ["NUL.txt"]), { code: "review_scope_invalid" });
    assert.throws(() => createReviewSourceManifest(root, ["trailing-space. "]), { code: "review_scope_invalid" });
  } else {
    assert.throws(() => createReviewSourceManifest(root, ["dir\\file.js"]), { code: "review_scope_invalid" });
  }
});

test("RSM-03: secret-like and invalid UTF-8 files fail closed without exposing content", (t) => {
  const root = createWorkspace(t);
  const syntheticKey = ["sk-", "1234567890abcdef1234567890"].join("");
  const secretContent = `OPENAI_API_KEY=${syntheticKey}\n`;
  fs.writeFileSync(path.join(root, "credential.js"), secretContent);
  fs.writeFileSync(path.join(root, "invalid.js"), Buffer.from([0xff, 0xfe, 0xfd]));

  assert.throws(() => createReviewSourceManifest(root, ["credential.js"]), (error) => {
    assert.equal(error.code, "review_scope_secret_detected");
    assert.deepEqual(error.diagnostic, { sortedScopeIndex: 1, signal: "mixed", highEntropyCandidateCount: 1 });
    assert.equal(error.message.includes(syntheticKey), false);
    return true;
  });
  assert.throws(() => createReviewSourceManifest(root, ["invalid.js"]), { code: "review_scope_invalid_encoding" });
});

test("RSM-04: source scope file count, per-file size, and total size are bounded", (t) => {
  const root = createWorkspace(t);
  const large = Buffer.alloc(REVIEW_SOURCE_MAX_FILE_BYTES + 1, 0x61);
  fs.writeFileSync(path.join(root, "large.js"), large);
  assert.throws(() => createReviewSourceManifest(root, ["large.js"]), { code: "review_scope_too_large" });

  const countRoot = createWorkspace(t);
  const paths = [];
  for (let index = 0; index <= REVIEW_SOURCE_MAX_FILES; index += 1) {
    const name = `file-${index}.js`;
    fs.writeFileSync(path.join(countRoot, name), "x\n");
    paths.push(name);
  }
  assert.throws(() => createReviewSourceManifest(countRoot, paths), { code: "review_scope_invalid" });

  const totalRoot = createWorkspace(t);
  const half = Buffer.alloc(Math.floor(REVIEW_SOURCE_MAX_TOTAL_BYTES / 2) + 1, 0x61);
  fs.writeFileSync(path.join(totalRoot, "a.js"), half);
  fs.writeFileSync(path.join(totalRoot, "b.js"), half);
  assert.throws(() => createReviewSourceManifest(totalRoot, ["a.js", "b.js"]), { code: "review_scope_too_large" });
});

test("RSM-05: symbolic-link paths are rejected", (t) => {
  const root = createWorkspace(t);
  const outside = path.join(root, "outside.js");
  const link = path.join(root, "link.js");
  fs.writeFileSync(outside, "const outside = true;\n");
  try {
    fs.symlinkSync(outside, link, "file");
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) return t.skip("Windows symlink privilege unavailable");
    throw error;
  }
  assert.throws(() => createReviewSourceManifest(root, ["link.js"]), { code: "review_scope_unsafe_file" });
});

test("RSM-ERROR-01: pre-open path failures retain the bounded source error classification", (t) => {
  const root = createWorkspace(t);
  assert.throws(() => createReviewSourceManifest(root, ["missing.js"]), { code: "review_scope_not_found" });
});

test("RSM-ORDER-01: manifest ordering is independent of the host locale", (t) => {
  const root = createWorkspace(t);
  const names = ["ä.js", "z.js", "I.js", "İ.js"];
  for (const name of names) fs.writeFileSync(path.join(root, name), `export const value = ${JSON.stringify(name)};\n`, "utf8");
  const manifest = createReviewSourceManifest(root, [...names].reverse());
  const manifestCore = JSON.parse(manifest.sourcePayload.split("\n").at(-1));
  const orderedNames = [...names].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  assert.deepEqual(manifestCore.entries.map((entry) => entry.path), orderedNames);
});

test("RSM-PLATFORM-01: case-insensitive hosts accept path aliases and reject duplicate file aliases", (t) => {
  if (process.platform !== "win32" && process.platform !== "darwin") return t.skip("case-insensitive path alias check is host-specific");
  const root = createWorkspace(t);
  fs.writeFileSync(path.join(root, "CaseFile.js"), "export const value = true;\n", "utf8");
  const manifest = createReviewSourceManifest(root, ["casefile.js"]);
  const manifestCore = JSON.parse(manifest.sourcePayload.split("\n").at(-1));
  assert.equal(manifestCore.entries[0].path, "casefile.js");
  assert.throws(() => createReviewSourceManifest(root, ["CaseFile.js", "casefile.js"]), { code: "review_scope_invalid" });
});

test("RSM-06: runtime sends the exact host bundle to supported CLI input and blocks invalid scope before execution", async (t) => {
  const root = createWorkspace(t);
  const selectedContent = "export const answer = 42;\n";
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "answer.js"), selectedContent, "utf8");
  const stateRoot = path.join(root, "runtime-state");
  const configuration = {
    allowedRoots: [root],
    statePaths: { logs: path.join(stateRoot, "logs"), state: path.join(stateRoot, "state"), cache: path.join(stateRoot, "cache") },
    codex: { timeoutMs: 30000, maxRetries: 1 },
    reliability: { maxAttempts: 1, maxTotalDurationMs: 30000, maxRetryCostUsd: 1, maxRetryCostReserveUsd: 0.1, maxUnknownAttemptCostUsd: 0.1 },
    orchestration: { scheduler: { maxQueuedPerWorkspace: 10, staleLockMs: 60000, leaseHeartbeatMs: 1000 }, readOnlyCache: { enabled: false, ttlMs: 1000, maxEntryBytes: 1024 }, taskProfiles: {} },
    observability: { maxMetricFileBytes: 1048576, maxMetricRetentionDays: 30 }
  };
  let observedRequest;
  let executionCount = 0;
  let adapterResult;
  const adapter = createAdapter("codex", { canRead: true, canWrite: false, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async (request) => {
    executionCount += 1;
    observedRequest = request;
    return adapterResult(request);
  };
  adapterResult = (request) => createSuccessSubagentResult("codex", request.model, {
    result: "Review completed",
    metrics: {
      retries: 0,
      totalCostUsd: 0,
      stdinWriteStatus: request.reviewSourcePayload ? "complete" : "not_used",
      stdinBytes: request.reviewSourcePayload ? Buffer.byteLength(request.reviewSourcePayload, "utf8") : null,
      diagnostics: {
        failureStage: null,
        providerCode: null,
        settingsLockWaitMs: null,
        providerExecutionMs: 5,
        stdoutBytes: Buffer.byteLength("Review completed", "utf8"),
        stderrBytes: 0
      }
    }
  });
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: adapter }, sleep: async () => {} });
  const result = await runtime.run({
    target: "codex",
    prompt: "Review the selected source.",
    model: "gpt-6.1-sol",
    mode: "read_only",
    trustedWorkspace: root,
    caller: "test_review",
    delegationDepth: 0,
    reviewEvidenceRequirement: "required",
    reviewScope: ["src/answer.js"]
  });

  assert.equal(result.ok, true);
  assert.match(observedRequest.reviewSourcePayload, /export const answer = 42;/u);
  assert.equal(observedRequest.prompt, "Review the selected source.");
  assert.equal(result.reviewContract.sourceScopeStatus, "complete");
  assert.equal(result.reviewContract.sourceDeliveryStatus, "complete_to_cli");
  assert.equal(result.reviewContract.outputIntegrity, "complete");
  assert.equal(result.reviewContract.taskCompletion, "completed");
  assert.equal(result.reviewContract.reviewEligibility, "eligible_for_orchestrator_evaluation");

  adapterResult = (request) => createSuccessSubagentResult("codex", request.model, {
    result: " ",
    metrics: {
      retries: 0,
      totalCostUsd: 0,
      stdinWriteStatus: "complete",
      stdinBytes: Buffer.byteLength(request.reviewSourcePayload, "utf8"),
      diagnostics: {
        failureStage: null,
        providerCode: null,
        settingsLockWaitMs: null,
        providerExecutionMs: 5,
        stdoutBytes: 1,
        stderrBytes: 0
      }
    }
  });
  const empty = await runtime.run({
    target: "codex",
    prompt: "Review the selected source.",
    model: "gpt-6.1-sol",
    mode: "read_only",
    trustedWorkspace: root,
    caller: "test_review_empty",
    delegationDepth: 0,
    reviewEvidenceRequirement: "required",
    reviewScope: ["src/answer.js"]
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.reviewContract.outputIntegrity, "complete");
  assert.equal(empty.reviewContract.taskCompletion, "partial");
  assert.equal(empty.reviewContract.reviewEligibility, "unavailable");

  adapterResult = (request) => createFailureSubagentResult("codex", request.model, {
    error: "execution timed out",
    retryable: false,
    timedOut: true,
    exitCode: null,
    reason: "timeout",
    metrics: {
      retries: 0,
      totalCostUsd: 0,
      stdinWriteStatus: "complete",
      stdinBytes: Buffer.byteLength(request.reviewSourcePayload, "utf8"),
      diagnostics: {
        failureStage: "timeout",
        providerCode: "timeout",
        settingsLockWaitMs: null,
        providerExecutionMs: 5,
        stdoutBytes: 8,
        stderrBytes: 0
      }
    }
  });
  const timedOut = await runtime.run({
    target: "codex",
    prompt: "Review the selected source.",
    model: "gpt-6.1-sol",
    mode: "read_only",
    trustedWorkspace: root,
    caller: "test_review_timeout",
    delegationDepth: 0,
    reviewEvidenceRequirement: "required",
    reviewScope: ["src/answer.js"]
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reviewContract.outputIntegrity, "unknown");
  assert.equal(timedOut.reviewContract.taskCompletion, "partial");
  assert.equal(timedOut.reviewContract.reviewEligibility, "unavailable");

  adapterResult = (request) => createFailureSubagentResult("codex", request.model, {
    error: "output exceeded limit",
    retryable: false,
    timedOut: false,
    exitCode: null,
    reason: "output_limit",
    metrics: {
      retries: 0,
      totalCostUsd: 0,
      stdinWriteStatus: "complete",
      stdinBytes: Buffer.byteLength(request.reviewSourcePayload, "utf8"),
      diagnostics: {
        failureStage: "result_parse",
        providerCode: "output_limit",
        settingsLockWaitMs: null,
        providerExecutionMs: 5,
        stdoutBytes: 1024,
        stderrBytes: 0
      }
    }
  });
  const outputLimited = await runtime.run({
    target: "codex",
    prompt: "Review the selected source.",
    model: "gpt-6.1-sol",
    mode: "read_only",
    trustedWorkspace: root,
    caller: "test_review_output_limit",
    delegationDepth: 0,
    reviewEvidenceRequirement: "required",
    reviewScope: ["src/answer.js"]
  });
  assert.equal(outputLimited.ok, false);
  assert.equal(outputLimited.reviewContract.outputIntegrity, "truncated");
  assert.equal(outputLimited.reviewContract.taskCompletion, "partial");
  assert.equal(outputLimited.reviewContract.reviewEligibility, "unavailable");

  adapterResult = (request) => createSuccessSubagentResult("codex", request.model, {
    result: "Review completed",
    metrics: { retries: 0, totalCostUsd: 0, stdinWriteStatus: "complete", stdinBytes: Buffer.byteLength(request.reviewSourcePayload, "utf8") }
  });
  const unproven = await runtime.run({
    target: "codex",
    prompt: "Review the selected source.",
    model: "gpt-6.1-sol",
    mode: "read_only",
    trustedWorkspace: root,
    caller: "test_review_unproven",
    delegationDepth: 0,
    reviewEvidenceRequirement: "required",
    reviewScope: ["src/answer.js"]
  });
  assert.equal(unproven.ok, true);
  assert.equal(unproven.reviewContract.outputIntegrity, "unknown");
  assert.equal(unproven.reviewContract.taskCompletion, "unknown");
  assert.equal(unproven.reviewContract.reviewEligibility, "unverified");

  adapterResult = (request) => createSuccessSubagentResult("codex", request.model, {
    result: "Review completed",
    metrics: {
      retries: 0,
      totalCostUsd: 0,
      stdinWriteStatus: request.reviewSourcePayload ? "complete" : "not_used",
      stdinBytes: request.reviewSourcePayload ? Buffer.byteLength(request.reviewSourcePayload, "utf8") : null,
      diagnostics: {
        failureStage: null,
        providerCode: null,
        settingsLockWaitMs: null,
        providerExecutionMs: 5,
        stdoutBytes: Buffer.byteLength("Review completed", "utf8"),
        stderrBytes: 0
      }
    }
  });
  const rejected = await runtime.run({
    target: "codex",
    prompt: "Review the selected source.",
    model: "gpt-6.1-sol",
    mode: "read_only",
    trustedWorkspace: root,
    caller: "test_review",
    delegationDepth: 0,
    reviewEvidenceRequirement: "required",
    reviewScope: ["../outside.js"]
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reviewContract.sourceScopeStatus, "blocked");
  assert.equal(rejected.reviewContract.reviewEligibility, "unavailable");
  assert.equal(executionCount, 5);

  const unscoped = await runtime.run({
    target: "codex",
    prompt: "Return a concise response.",
    model: "gpt-6.1-sol",
    mode: "read_only",
    trustedWorkspace: root,
    caller: "test_unscoped",
    delegationDepth: 0,
    reviewEvidenceRequirement: "best_effort"
  });
  assert.equal(unscoped.ok, true);
  assert.equal(Object.hasOwn(unscoped, "reviewContract"), false);
  assert.equal(executionCount, 6);
});

test("RSM-07: DeepSeek and GLM wrapper results retain the host review contract", () => {
  const reviewContract = {
    version: 1,
    sourceScopeStatus: "complete",
    sourceDeliveryStatus: "complete_to_cli",
    sourceManifestSha256: sha256("review source"),
    sourceFileCount: 1,
    sourceBytes: 13,
    reviewEligibility: "unavailable"
  };
  const runtimeResult = {
    ok: false,
    model: "test-model",
    resolvedModel: "test-model",
    result: null,
    exitCode: 1,
    durationMs: 10,
    reason: "process_exit",
    metrics: { retries: 0, totalCostUsd: null },
    reviewContract
  };
  const deepSeek = createDeepSeekCheckpoint({ taskId: "test", role: "reviewer", model: "deepseek_pro" }, runtimeResult);
  const glm = createGlmCheckpoint({ taskId: "test", role: "reviewer", model: "glm_5_2" }, runtimeResult);
  assert.deepEqual(deepSeek.reviewContract, reviewContract);
  assert.deepEqual(glm.reviewContract, reviewContract);
});

test("RSM-08: unsupported Antigravity source transport is classified as preflight without adapter execution", async (t) => {
  const root = createWorkspace(t);
  const adapter = createAdapter("antigravity", { canRead: true, canWrite: false, supportsSandbox: true, supportsModelSelection: true });
  let adapterCalls = 0;
  adapter.execute = async () => {
    adapterCalls += 1;
    return createSuccessSubagentResult("antigravity", "gemini-3.8-flash-high", { result: "not expected" });
  };
  const runtime = createBridgeRuntime({
    configuration: {
      allowedRoots: [root],
      statePaths: { logs: path.join(root, "logs"), state: path.join(root, "state"), cache: path.join(root, "cache") },
      reliability: { maxAttempts: 1, maxTotalDurationMs: 30000, maxRetryCostUsd: 1, maxRetryCostReserveUsd: 0.1, maxUnknownAttemptCostUsd: 0.1 },
      orchestration: { scheduler: { maxQueuedPerWorkspace: 10, staleLockMs: 60000, leaseHeartbeatMs: 1000 }, readOnlyCache: { enabled: false, ttlMs: 1000, maxEntryBytes: 1024 }, taskProfiles: {} },
      observability: { maxMetricFileBytes: 1048576, maxMetricRetentionDays: 30 }
    },
    adapters: { antigravity: adapter },
    sleep: async () => {}
  });

  const result = await runtime.run({
    target: "gemini_flash_3_8",
    prompt: "Review the selected source.",
    model: "gemini_flash_3_8",
    mode: "read_only",
    trustedWorkspace: root,
    caller: "test_review",
    delegationDepth: 0,
    reviewEvidenceRequirement: "required",
    reviewScope: ["README.md"]
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "review_source_transport_unsupported");
  assert.equal(result.metrics.adapterAttempts, 0);
  assert.equal(result.metrics.diagnostics.failureStage, "mcp_preflight");
  assert.equal(result.reviewContract.sourceScopeStatus, "blocked");
  assert.equal(adapterCalls, 0);
});

test("RSM-09: secret-like preflight returns only sorted scope index and detector class", async (t) => {
  const root = createWorkspace(t);
  const highEntropyFixture = ["A9mX2qT7", "vB4nC8sD", "1eF5hJ0k", "L3pR6wY9", "zQ2cN7mK"].join("");
  fs.writeFileSync(path.join(root, "sensitive.md"), `Example: ${highEntropyFixture}\n`, "utf8");
  const configuration = {
    allowedRoots: [root],
    statePaths: { logs: path.join(root, "logs"), state: path.join(root, "state"), cache: path.join(root, "cache") },
    reliability: { maxAttempts: 1, maxTotalDurationMs: 30000, maxRetryCostUsd: 1, maxRetryCostReserveUsd: 0.1, maxUnknownAttemptCostUsd: 0.1 },
    orchestration: { scheduler: { maxQueuedPerWorkspace: 10, staleLockMs: 60000, leaseHeartbeatMs: 1000 }, readOnlyCache: { enabled: false, ttlMs: 1000, maxEntryBytes: 1024 }, taskProfiles: {} },
    observability: { maxMetricFileBytes: 1048576, maxMetricRetentionDays: 30 }
  };
  let adapterCalls = 0;
  const adapter = createAdapter("codex", { canRead: true, canWrite: false, supportsSandbox: true, supportsModelSelection: true });
  adapter.execute = async () => {
    adapterCalls += 1;
    return createSuccessSubagentResult("codex", "gpt-6.1-sol", { result: "not expected" });
  };
  const runtime = createBridgeRuntime({ configuration, adapters: { codex: adapter }, sleep: async () => {} });

  const result = await runtime.run({
    target: "codex",
    prompt: "Review the selected source.",
    model: "gpt-6.1-sol",
    mode: "read_only",
    trustedWorkspace: root,
    caller: "test_review",
    delegationDepth: 0,
    reviewEvidenceRequirement: "required",
    reviewScope: ["sensitive.md"]
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "review_scope_secret_detected");
  assert.match(result.error, /sorted scope item 1; signal high_entropy; high-entropy candidates 1/u);
  assert.equal(result.error.includes(highEntropyFixture), false);
  assert.equal(result.error.includes("sensitive.md"), false);
  assert.equal(result.metrics.adapterAttempts, 0);
  assert.equal(result.metrics.diagnostics.failureStage, "mcp_preflight");
  assert.equal(adapterCalls, 0);
});
