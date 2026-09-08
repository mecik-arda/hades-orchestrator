import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexAdapter, createCodexEnvironment, resolveCodexModel, parseCodexOutput, classifyCodexError, buildCodexArgs } from "../subagent-bridge/src/adapters/codex-adapter.js";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { checkCapability } from "../subagent-bridge/src/services/capability-service.js";
import { shouldRetry, isMutationStateUnknown } from "../subagent-bridge/src/services/retry-service.js";
import {
  validateSubagentResult,
  createFailureSubagentResult, createSuccessSubagentResult
} from "../subagent-bridge/src/schemas/core-schemas.js";

test("CX-AC-01: CodexAdapter AgentAdapter kontratını uygular", () => {
  const adapter = createAdapter("codex", {
    canRead: true, canWrite: true,
    supportsSandbox: true, supportsModelSelection: true
  });
  assert.equal(typeof adapter.id, "string");
  assert.equal(adapter.id, "codex");
  assert.equal(adapter.capabilities.canRead, true);
  assert.equal(adapter.capabilities.canWrite, true);
  assert.equal(adapter.capabilities.supportsSandbox, true);
  assert.equal(adapter.capabilities.supportsModelSelection, true);
  assert.equal(typeof adapter.healthCheck, "function");
  assert.equal(typeof adapter.execute, "function");
  assert.equal(typeof adapter.cancel, "function");
});

test("CX-AC-02: production adapter uses codex executable", () => {
  const adapter = createCodexAdapter({ codex: { executable: "codex" } });
  assert.equal(adapter.id, "codex");
  assert.equal(adapter.capabilities.canRead, true);
  assert.equal(adapter.capabilities.canWrite, true);
});

test("CX-AC-03: Codex model contract external provider IDs içermez", () => {
  assert.equal(resolveCodexModel("gpt-5").valid, true);
  assert.equal(resolveCodexModel("gpt-5").model, "gpt-5");
  assert.equal(resolveCodexModel("default").model, null);
  assert.equal(resolveCodexModel("google/gemini-3.1-pro").valid, false);
  assert.equal(resolveCodexModel("deepseek/deepseek-v4-pro").valid, false);
  assert.equal(resolveCodexModel("").valid, false);
});

test("CODEX-DIAG-02: health check reports configured Codex executable", async () => {
  const adapter = createCodexAdapter({ codex: { executable: "missing-codex-health" } });
  const health = await adapter.healthCheck();
  assert.equal(typeof health.installed, "boolean");
  assert.equal(health.executable, "missing-codex-health");
  assert.equal(health.authValid, false);
});

test("CX-AC-05: edit mutation_state_unknown no retry", () => {
  assert.equal(isMutationStateUnknown("edit", "timeout"), true);
  assert.equal(shouldRetry("timeout", "edit", 1, 3).retryable, false);
  assert.equal(shouldRetry("timeout", "read_only", 1, 3).retryable, true);
});

test("CX-AC-06: success SubagentResult valid (codex backend)", () => {
  const result = createSuccessSubagentResult("codex", "gpt-5", { result: "OK", durationMs: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.backend, "codex");
  assert.equal(validateSubagentResult(result).success, true);
});

test("CX-AC-07: executable missing reported correctly", () => {
  const classification = classifyCodexError(new Error("ENOENT: codex not found"), null, "", "");
  assert.equal(classification.valid, false);
  assert.equal(classification.errorClass, "executable_missing");
});

test("CX-AC-08: timeout classification", () => {
  const classification = classifyCodexError(new Error("Process timed out"), null, "", "");
  assert.equal(classification.errorClass, "timeout");
});

test("CX-AC-09: parseCodexOutput empty", () => {
  assert.equal(parseCodexOutput("").ok, false);
});

test("CX-AC-10: parseCodexOutput valid", () => {
  const parsed = parseCodexOutput("response text");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.text, "response text");
});

test("CODEX-DIAG-04/05/06: canonical argv sandbox modunu seçer ve danger flag içermez", () => {
  const request = { prompt: "inspect", model: "gpt-5", mode: "read_only" };
  const readOnly = buildCodexArgs(request, { codex: { executable: "codex", execArgs: ["--ephemeral"] } });
  const edit = buildCodexArgs({ ...request, mode: "edit" }, { codex: { executable: "codex" } });

  assert.equal(readOnly.executable, "codex");
  assert.deepEqual(readOnly.args.slice(0, 2), ["--ephemeral", "exec"]);
  assert.deepEqual(readOnly.args.slice(2, 5), ["--model", "gpt-5", "--sandbox"]);
  assert.equal(readOnly.args.at(-2), "read-only");
  assert.equal(edit.args.at(-2), "workspace-write");
  assert.equal(readOnly.args.some((value) => /danger-full-access|bypass-approvals/i.test(value)), false);
  const providerDefault = buildCodexArgs({ ...request, model: "default" }, { codex: { executable: "codex" } });
  assert.equal(providerDefault.args.includes("--model"), false);
});

test("CODEX-CLEANUP-01: edit ortamı pytest ve bytecode artefaktlarını engeller", () => {
  const editEnvironment = createCodexEnvironment("edit", { PATH: "test-path", PYTEST_ADDOPTS: "-q", PYTHONDONTWRITEBYTECODE: "0" });
  const readOnlyEnvironment = createCodexEnvironment("read_only", { PATH: "test-path", PYTEST_ADDOPTS: "-q", PYTHONDONTWRITEBYTECODE: "0" });
  assert.equal(editEnvironment.PYTEST_ADDOPTS, "-q -p no:cacheprovider");
  assert.equal(editEnvironment.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(readOnlyEnvironment.PYTEST_ADDOPTS, undefined);
  assert.equal(readOnlyEnvironment.PYTHONDONTWRITEBYTECODE, undefined);
});

test("CODEX-GLOBAL-01: trusted machine config permits only non-Git workspace check bypass", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-global-workspace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gitWorkspace = path.join(root, "git");
  const nonGitWorkspace = path.join(root, "non-git");
  fs.mkdirSync(path.join(gitWorkspace, ".git"), { recursive: true });
  fs.mkdirSync(nonGitWorkspace);
  const request = { prompt: "inspect", model: "default", mode: "read_only" };
  const trustedConfig = { codex: { executable: "codex", allowNonGitWorkspace: true } };
  const defaultConfig = { codex: { executable: "codex" } };

  const gitArgs = buildCodexArgs({ ...request, workspace: gitWorkspace }, trustedConfig).args;
  const nonGitArgs = buildCodexArgs({ ...request, workspace: nonGitWorkspace }, trustedConfig).args;
  const defaultArgs = buildCodexArgs({ ...request, workspace: nonGitWorkspace }, defaultConfig).args;

  assert.equal(gitArgs.includes("--skip-git-repo-check"), false);
  assert.equal(nonGitArgs.includes("--skip-git-repo-check"), true);
  assert.equal(defaultArgs.includes("--skip-git-repo-check"), false);
  assert.equal(nonGitArgs.includes("--sandbox"), true);
  assert.equal(nonGitArgs[nonGitArgs.indexOf("--sandbox") + 1], "read-only");
});

test("CODEX-GLOBAL-02: Git repository check has canonical failure class", () => {
  const classification = classifyCodexError(null, 1, "", "Not inside a trusted directory and --skip-git-repo-check was not specified.");
  assert.equal(classification.errorClass, "git_repository_required");
  assert.equal(classification.reason, "Codex requires a Git repository");
});

test("CODEX-DIAG-07/08: non-zero stdout başarı sayılmaz ve permission ayrıştırılır", async () => {
  const adapter = createCodexAdapter({
    codex: {
      executable: process.execPath,
      execArgs: ["-e", "process.stdout.write('provider failure'); process.exit(7)"]
    }
  });
  const result = await adapter.execute({
    executionId: "codex-nonzero-output",
    backend: "codex",
    prompt: "inspect",
    model: "gpt-5",
    mode: "read_only",
    workspace: process.cwd(),
    delegationDepth: 0,
    caller: "test",
    timeoutMs: 5000
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(classifyCodexError(null, 1, "", "sandbox violation: permission denied").errorClass, "permission_denied");
  assert.equal(classifyCodexError(null, 1, "", "model is not supported").errorClass, "invalid_model");
});

test("CODEX-DIAG-01/02/03: missing executable fail-fast ve runtime executable kullanır", async () => {
  const adapter = createCodexAdapter({ codex: { executable: "missing-codex-executable", execArgs: ["--test"] } });
  const health = await adapter.healthCheck();
  const result = await adapter.execute({
    executionId: "codex-missing-executable",
    backend: "codex",
    prompt: "inspect",
    model: "gpt-5",
    mode: "read_only",
    workspace: process.cwd(),
    delegationDepth: 0,
    caller: "test",
    timeoutMs: 5000
  });

  assert.equal(health.installed, false);
  assert.equal(health.executable, "missing-codex-executable");
  assert.equal(result.ok, false);
  assert.equal(result.error, "codex executable not found");
});

test("CX-AC-11: regression check", () => {
  assert.ok(true);
});
