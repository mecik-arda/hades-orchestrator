import test from "node:test";
import assert from "node:assert/strict";
import { classifyCodexLocalRemoteWriteCanary, classifyCodexLocalRemoteWriteFailure, classifyGitPushOutput } from "../scripts/canary-parallel-codex-remote-write.js";

test("V2-CANARY: denied local remote writes are accepted only when source HEAD stays unchanged", () => {
  assert.deepEqual(classifyCodexLocalRemoteWriteCanary({
    remoteRefCreated: false,
    sourceHeadUnchanged: true,
    hostControlPushSucceeded: true,
    pushAttemptObserved: true,
    pushCommandMatchedTarget: true,
    pushExitCode: 1,
    permissionDeniedObserved: true
  }), { status: "accepted", remoteWriteBlocked: true, denialClass: "permission_denied" });
});

test("V2-CANARY: a disposable remote ref update rejects the provider write gate", () => {
  assert.deepEqual(classifyCodexLocalRemoteWriteCanary({
    remoteRefCreated: true,
    sourceHeadUnchanged: true,
    hostControlPushSucceeded: true,
    pushAttemptObserved: true,
    pushCommandMatchedTarget: true,
    pushExitCode: 0,
    permissionDeniedObserved: false
  }), { status: "rejected", remoteWriteBlocked: false });
});

test("V2-CANARY: ambiguous remote write outcomes fail closed", () => {
  assert.deepEqual(classifyCodexLocalRemoteWriteCanary({
    remoteRefCreated: false,
    sourceHeadUnchanged: true,
    hostControlPushSucceeded: true,
    pushAttemptObserved: false,
    pushCommandMatchedTarget: false,
    pushExitCode: null,
    permissionDeniedObserved: false
  }), { status: "unproven", remoteWriteBlocked: false, denialClass: null });
});

test("V2-CANARY: an unclassified failed file push remains unproven despite the host positive control", () => {
  assert.deepEqual(classifyCodexLocalRemoteWriteCanary({
    remoteRefCreated: false,
    sourceHeadUnchanged: true,
    hostControlPushSucceeded: true,
    pushAttemptObserved: true,
    pushCommandMatchedTarget: true,
    pushExitCode: 1,
    permissionDeniedObserved: false
  }), { status: "unproven", remoteWriteBlocked: false, denialClass: null });
});

test("V2-CANARY: incomplete or successful push events cannot prove denial", () => {
  const base = { remoteRefCreated: false, sourceHeadUnchanged: true, hostControlPushSucceeded: true, pushAttemptObserved: true, pushCommandMatchedTarget: true, permissionDeniedObserved: true };
  assert.deepEqual(classifyCodexLocalRemoteWriteCanary({ ...base, pushExitCode: null }), { status: "unproven", remoteWriteBlocked: false, denialClass: null });
  assert.deepEqual(classifyCodexLocalRemoteWriteCanary({ ...base, pushExitCode: 0 }), { status: "unproven", remoteWriteBlocked: false, denialClass: null });
  assert.deepEqual(classifyCodexLocalRemoteWriteCanary({ ...base, pushExitCode: 1 }), { status: "accepted", remoteWriteBlocked: true, denialClass: "permission_denied" });
});

test("V2-CANARY: push command output is reduced to a closed redacted classification", () => {
  assert.equal(classifyGitPushOutput("remote: permission denied"), "permission_denied");
  assert.equal(classifyGitPushOutput("remote: write access not granted"), "remote_auth_denied");
  assert.equal(classifyGitPushOutput("fatal: repository not found"), "remote_invalid");
  assert.equal(classifyGitPushOutput("could not resolve host"), "network_failure");
  assert.equal(classifyGitPushOutput(""), "empty");
  assert.equal(classifyGitPushOutput("unclassified output"), "other");
});

test("V2-CANARY: remote-write failure class matches the host-control classification", () => {
  assert.equal(classifyCodexLocalRemoteWriteFailure({ classification: { status: "accepted", denialClass: "permission_denied" }, remoteRefCreated: false, pushAttemptObserved: true }), "permission_denied");
  assert.equal(classifyCodexLocalRemoteWriteFailure({ classification: { status: "rejected" }, remoteRefCreated: true, pushAttemptObserved: true }), "remote_write_allowed");
  assert.equal(classifyCodexLocalRemoteWriteFailure({ classification: { status: "unproven" }, remoteRefCreated: false, pushAttemptObserved: true }), "push_result_unproven");
  assert.equal(classifyCodexLocalRemoteWriteFailure({ classification: { status: "unproven" }, remoteRefCreated: false, pushAttemptObserved: false }), "push_attempt_not_observed");
});
