import test from "node:test";
import assert from "node:assert/strict";
import { classifyCodexWorktreeRefCanary } from "../scripts/canary-parallel-codex-ref.js";

test("V2-CANARY: provider-denied local ref writes are accepted only when source state remains unchanged", () => {
  assert.deepEqual(classifyCodexWorktreeRefCanary({
    branchCreated: false,
    sourceRefsUnchanged: true,
    sourceHeadUnchanged: true,
    failureClass: "permission_denied"
  }), {
    status: "accepted",
    providerWriteDenied: true,
    hostWouldRejectMutation: false,
    unsafeSharedRefWrite: false,
    taskRefIsolated: false
  });
});

test("V2-CANARY: a task ref written into the shared source repository remains unsafe even when the host detects it", () => {
  assert.deepEqual(classifyCodexWorktreeRefCanary({
    branchCreated: true,
    sourceRefsUnchanged: false,
    sourceHeadUnchanged: true,
    failureClass: null
  }), {
    status: "rejected",
    providerWriteDenied: false,
    hostWouldRejectMutation: true,
    unsafeSharedRefWrite: true,
    taskRefIsolated: false
  });
});

test("V2-CANARY: task-local refs are safe when isolated from source refs and HEAD", () => {
  assert.deepEqual(classifyCodexWorktreeRefCanary({
    branchCreated: true,
    sourceRefsUnchanged: true,
    sourceHeadUnchanged: true,
    failureClass: null
  }), {
    status: "accepted",
    providerWriteDenied: false,
    hostWouldRejectMutation: false,
    unsafeSharedRefWrite: false,
    taskRefIsolated: true
  });
});

test("V2-CANARY: ambiguous ref outcomes fail closed", () => {
  assert.equal(classifyCodexWorktreeRefCanary({
    branchCreated: false,
    sourceRefsUnchanged: true,
    sourceHeadUnchanged: true,
    failureClass: null
  }).status, "unproven");
});
