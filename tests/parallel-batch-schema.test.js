import test from "node:test";
import assert from "node:assert/strict";
import {
  parallelBatchSummarySchema,
  prepareParallelBatchRequestSchema,
  startParallelBatchRequestSchema,
  validatePrepareParallelBatchRequest,
  validateParallelWorkerSummary
} from "../subagent-bridge/src/schemas/parallel-batch-schema.js";

function readOnlyTask(overrides = {}) {
  return {
    taskId: "task-one",
    role: "analyst",
    mode: "read_only",
    target: "codex",
    objective: "Inspect the selected files",
    readablePaths: ["src/a.txt"],
    ...overrides
  };
}

test("V2-SCHEMA: prepare request is strict and bounded", () => {
  const valid = { objective: "Split work", batchMaxReservedCostUsd: 1, tasks: [readOnlyTask()] };
  assert.equal(validatePrepareParallelBatchRequest(valid).success, true);
  assert.equal(prepareParallelBatchRequestSchema.safeParse({ ...valid, unexpected: true }).success, false);
  assert.equal(prepareParallelBatchRequestSchema.safeParse({ ...valid, batchMaxReservedCostUsd: 0 }).success, false);
  assert.equal(prepareParallelBatchRequestSchema.safeParse({ ...valid, tasks: [] }).success, false);
  assert.equal(prepareParallelBatchRequestSchema.safeParse({ ...valid, tasks: [readOnlyTask({ taskId: "integration" })] }).success, false);
  assert.equal(prepareParallelBatchRequestSchema.safeParse({ ...valid, tasks: [readOnlyTask(), readOnlyTask({ taskId: "task-two" }), readOnlyTask({ taskId: "task-three" }), readOnlyTask({ taskId: "task-four" }), readOnlyTask({ taskId: "task-five" }), readOnlyTask({ taskId: "task-six" })] }).success, false);
});

test("V2-SCHEMA: read-only tasks require readable paths and reject edit surfaces", () => {
  const withoutReadable = readOnlyTask({ readablePaths: [] });
  assert.equal(validatePrepareParallelBatchRequest({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [withoutReadable] }).success, false);
  const withFiles = readOnlyTask({ files: ["src/a.txt"] });
  assert.equal(validatePrepareParallelBatchRequest({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [withFiles] }).success, false);
  const withAllowed = readOnlyTask({ allowedPaths: ["src/a.txt"] });
  assert.equal(validatePrepareParallelBatchRequest({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [withAllowed] }).success, false);
});

test("V2-SCHEMA: path traversal and absolute paths are rejected", () => {
  for (const candidate of ["../secret.txt", "C:\\Windows\\system32\\config", "/etc/passwd", "src/../../secret.txt", "src\\..\\..\\secret.txt"]) {
    const result = validatePrepareParallelBatchRequest({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [readOnlyTask({ readablePaths: [candidate] })] });
    assert.equal(result.success, false, `${candidate} should be rejected`);
  }
});

test("V2-SCHEMA: edit tasks require files and acceptance criteria", () => {
  const base = {
    taskId: "task-edit",
    role: "implementer",
    mode: "edit",
    target: "codex",
    objective: "Change the file",
    files: ["src/a.txt"],
    acceptanceCriteria: ["File contains the new value"],
    verificationCommands: ["git diff --check"],
    stopConditions: ["Stop if the contract cannot be met safely"],
    resourceClaims: ["fixture:unit-test"],
    maxFilesChanged: 1,
    maxFileBytes: 1024,
    maxTotalDiffBytes: 4096
  };
  assert.equal(validatePrepareParallelBatchRequest({ objective: "x", batchMaxReservedCostUsd: 2, tasks: [base] }).success, true);
  assert.equal(validatePrepareParallelBatchRequest({ objective: "x", batchMaxReservedCostUsd: 2, tasks: [{ ...base, files: [] }] }).success, false);
  assert.equal(validatePrepareParallelBatchRequest({ objective: "x", batchMaxReservedCostUsd: 2, tasks: [{ ...base, acceptanceCriteria: [] }] }).success, false);
  assert.equal(validatePrepareParallelBatchRequest({ objective: "x", batchMaxReservedCostUsd: 2, tasks: [{ ...base, verificationCommands: [] }] }).success, false);
  assert.equal(validatePrepareParallelBatchRequest({ objective: "x", batchMaxReservedCostUsd: 2, tasks: [{ ...base, resourceClaims: ["fixture:unit-test", "fixture:unit-test"] }] }).success, false);
  assert.equal(validatePrepareParallelBatchRequest({ objective: "x", batchMaxReservedCostUsd: 2, tasks: [{ ...base, maxFilesChanged: 101 }] }).success, false);
});

test("V2-SCHEMA: start requires plan id and plan hash", () => {
  assert.equal(startParallelBatchRequestSchema.safeParse({ planId: "a".repeat(32), planHash: "b".repeat(64) }).success, true);
  assert.equal(startParallelBatchRequestSchema.safeParse({ planId: "a".repeat(32) }).success, false);
  assert.equal(startParallelBatchRequestSchema.safeParse({ planId: "zz", planHash: "b".repeat(64) }).success, false);
});

test("V2-SCHEMA: worker summary contract is strict", () => {
  assert.equal(validateParallelWorkerSummary({ status: "ok", summary: "done", action_required: "none" }).success, true);
  assert.equal(validateParallelWorkerSummary({ status: "maybe", summary: "done", action_required: "none" }).success, false);
  assert.equal(validateParallelWorkerSummary({ status: "ok", summary: "done", action_required: "none", extra: 1 }).success, false);
});

test("V2-SCHEMA: batch summary rejects provider invoice claims", () => {
  const summary = {
    schemaVersion: 1,
    batchId: null,
    planId: "a".repeat(32),
    planHash: "b".repeat(64),
    status: "planned",
    createdAt: new Date().toISOString(),
    expiresAt: null,
    taskCount: 1,
    completedCount: 0,
    failedCount: 0,
    unknownCount: 0,
    tasks: [],
    progress: { percentage: 0, resolvedCount: 0, totalCount: 1, runningCount: 0, queuedCount: 1, blockedCount: 0, cancelledCount: 0 },
    budget: { capUsd: 1, reservedUsd: 0, settledKnownUsd: 0, unknownReservedUsd: 0, refundedUsd: 0, remainingUsd: 1, isProviderInvoice: false },
    approvalRequired: false,
    approval: null,
    message: null,
    contentBytes: 0
  };
  assert.equal(parallelBatchSummarySchema.safeParse(summary).success, true);
  assert.equal(parallelBatchSummarySchema.safeParse({ ...summary, budget: { ...summary.budget, isProviderInvoice: true } }).success, false);
  const approval = { approvalRef: "c".repeat(64), diffHash: "d".repeat(64), detailRef: "e".repeat(64), filesChanged: ["src/a.txt"] };
  assert.equal(parallelBatchSummarySchema.safeParse({ ...summary, status: "ready_for_approval", approvalRequired: true, approval }).success, true);
  const { detailRef, ...approvalWithoutDiffPreview } = approval;
  assert.equal(parallelBatchSummarySchema.safeParse({ ...summary, status: "ready_for_approval", approvalRequired: true, approval: approvalWithoutDiffPreview }).success, false);
});
