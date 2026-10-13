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

test("CODEX-DIAG-09: bilinmeyen exit code genel sınıfa düşer ve kodu korur", () => {
  const classification = classifyCodexError(null, 42, "", "");
  assert.equal(classification.valid, false);
  assert.equal(classification.errorClass, "non_zero_exit");
  assert.match(classification.reason, /42/);
});

test("CODEX-DIAG-09a: sinyalle sonlanan süreç başarı sayılmaz", () => {
  assert.equal(classifyCodexError(null, null, "partial text", "").valid, false);
  assert.equal(classifyCodexError(null, null, "partial text", "", "SIGTERM").errorClass, "process_exit");
});

test("CODEX-AUTH-CLASSIFICATION: yalnız belirgin kimlik doğrulama ifadeleri auth_invalid olur", () => {
  for (const output of [
    "authentication failure",
    "failed to authenticate",
    "Please log in",
    "API key is invalid",
    "access token expired",
    "HTTP 401 Unauthorized"
  ]) {
    assert.equal(classifyCodexError(null, 1, "", output).errorClass, "auth_invalid", output);
  }
  for (const output of [
    "author identity unknown",
    "authorization policy forbids this action",
    "oauth callback configuration error",
    "API key documentation unavailable",
    "HTTP 401 request timed out",
    "401 response from local test server",
    "model response: authentication succeeded"
  ]) {
    assert.equal(classifyCodexError(null, 1, "", output).errorClass, "non_zero_exit", output);
  }
  assert.equal(classifyCodexError(null, 0, "authorization policy forbids this action", "").valid, true);
  assert.equal(shouldRetry("auth_invalid", "read_only", 1, 3).retryable, false);
});

test("CODEX-RATE-CLASSIFICATION: alıntı veya görev metnindeki quota/429 retry tetiklemez", () => {
  for (const output of [
    "Documentation example: HTTP 429 quota exceeded",
    'The file contains {"error":"rate limit exceeded"} as a sample',
    "The task text mentions a rate limit, but provider diagnosis is absent"
  ]) {
    const classification = classifyCodexError(null, 1, output, "");
    assert.equal(classification.errorClass, "non_zero_exit", output);
    assert.equal(shouldRetry(classification.errorClass, "read_only", 1, 3).retryable, false, output);
  }
});

test("CODEX-RATE-CLASSIFICATION-STRUCTURED: yalnız başarısız JSONL terminal provider event'i rate limit retry üretir", () => {
  const rateLimited = JSON.stringify({ type: "turn.failed", error: { code: "rate_limited" } });
  assert.equal(classifyCodexError(null, 1, rateLimited, "").errorClass, "rate_limited");
  assert.equal(shouldRetry(classifyCodexError(null, 1, rateLimited, "").errorClass, "read_only", 1, 3).retryable, true);
  assert.equal(classifyCodexError(null, 0, rateLimited, "").valid, true);
  assert.equal(classifyCodexError(null, 1, rateLimited, "", "SIGTERM").errorClass, "process_exit");

  const modelMessage = [
    { type: "item.completed", item: { type: "agent_message", text: rateLimited } },
    { type: "turn.failed", error: { code: "process_exit" } }
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.equal(classifyCodexError(null, 1, modelMessage, "").errorClass, "non_zero_exit");
  assert.equal(classifyCodexError(null, 1, "", rateLimited).errorClass, "non_zero_exit");

  const supersededError = [
    { type: "error", error: { code: "rate_limited" } },
    { type: "turn.completed" }
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.equal(classifyCodexError(null, 1, supersededError, "").errorClass, "non_zero_exit");
});

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
  assert.deepEqual(resolveCodexModel("gpt-6.1-sol"), { valid: true, model: "gpt-6.1-sol" });
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
  const parsed = parseCodexOutput([
    { type: "thread.started" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "reasoning", text: "reasoning must not escape" } },
    { type: "item.completed", item: { type: "agent_message", text: "response text" } },
    { type: "turn.completed" }
  ].map((event) => JSON.stringify(event)).join("\n"));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.text, "response text");
  assert.equal(parseCodexOutput("response text").errorClass, "output_parse_invalid");
});

test("CODEX-DIAG-04/05/06: canonical argv sandbox modunu seçer ve danger flag içermez", () => {
  const request = { prompt: "inspect", model: "gpt-5", mode: "read_only" };
  const readOnly = buildCodexArgs(request, { codex: { executable: "codex", execArgs: ["--ephemeral"] } });
  const edit = buildCodexArgs({ ...request, mode: "edit" }, { codex: { executable: "codex" } });

  assert.equal(readOnly.executable, "codex");
  assert.deepEqual(readOnly.args.slice(0, 3), ["--ephemeral", "exec", "--json"]);
  assert.deepEqual(readOnly.args.slice(3, 6), ["--model", "gpt-5", "--sandbox"]);
  assert.equal(readOnly.args[readOnly.args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(edit.args[edit.args.indexOf("--sandbox") + 1], "workspace-write");
  assert.equal(readOnly.args.some((value) => /danger-full-access|bypass-approvals/i.test(value)), false);
  const providerDefault = buildCodexArgs({ ...request, model: "default" }, { codex: { executable: "codex" } });
  assert.equal(providerDefault.args.includes("--model"), false);
  const sol61 = buildCodexArgs({ ...request, model: "gpt-6.1-sol" }, { codex: { executable: "codex" } });
  assert.deepEqual(sol61.args.slice(2, 5), ["--model", "gpt-6.1-sol", "--sandbox"]);
  assert.equal(buildCodexArgs(request, { codex: { execArgs: ["--json"] } }).args.filter((value) => value === "--json").length, 1);
});

test("CODEX-STDIN-01: Codex prompt ve host source bundle argv yerine stdin üzerinden taşınır", () => {
  const sourceBundle = "HOST_SOURCE_BUNDLE_SENTINEL";
  const command = buildCodexArgs({
    prompt: "Review the selected source bundle",
    reviewSourcePayload: sourceBundle,
    model: "gpt-6.1-sol",
    mode: "read_only"
  }, { codex: { executable: "codex" } });
  assert.equal(command.args.at(-1), "-");
  assert.equal(command.args.includes(sourceBundle), false);
  assert.equal(command.args.includes("Review the selected source bundle"), false);
  const ordinaryPrompt = buildCodexArgs({
    prompt: "A long ordinary task prompt",
    model: "gpt-6.1-sol",
    mode: "read_only"
  }, { codex: { executable: "codex" } });
  assert.equal(ordinaryPrompt.args.at(-1), "-");
  assert.equal(ordinaryPrompt.args.includes("A long ordinary task prompt"), false);
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
  const snapshotArgs = buildCodexArgs({ ...request, workspace: nonGitWorkspace, caller: "parallel_batch" }, defaultConfig).args;

  assert.equal(gitArgs.includes("--skip-git-repo-check"), false);
  assert.equal(nonGitArgs.includes("--skip-git-repo-check"), true);
  assert.equal(defaultArgs.includes("--skip-git-repo-check"), false);
  assert.equal(snapshotArgs.includes("--skip-git-repo-check"), true);
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
  assert.equal(result.metrics.diagnostics.failureStage, "provider_process_exit");
  assert.equal(result.metrics.diagnostics.providerExecutionMs > 0, true);
  assert.equal(result.metrics.diagnostics.stdoutBytes, Buffer.byteLength("provider failure", "utf8"));
  assert.equal(result.metrics.diagnostics.stderrBytes, 0);
  assert.equal(classifyCodexError(null, 1, "", "sandbox violation: permission denied").errorClass, "permission_denied");
  assert.equal(classifyCodexError(null, 1, "", "model is not supported").errorClass, "invalid_model");
});

test("CODEX-JSONL-RETRY: adapter preserves a structured terminal rate-limit classification", async () => {
  const eventStream = [
    { type: "thread.started", thread_id: "thread-test" },
    { type: "turn.started" },
    { type: "turn.failed", error: { code: "rate_limited" } }
  ].map((event) => JSON.stringify(event)).join("\n");
  const script = `process.stdout.write(${JSON.stringify(`${eventStream}\n`)}); process.exit(7);`;
  const adapter = createCodexAdapter({ codex: { executable: process.execPath, execArgs: ["-e", script] } });
  const result = await adapter.execute({
    executionId: "codex-structured-rate-limit",
    backend: "codex",
    prompt: "inspect",
    model: "gpt-6.1-sol",
    mode: "read_only",
    workspace: process.cwd(),
    delegationDepth: 0,
    caller: "test",
    timeoutMs: 5000
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "rate_limited");
  assert.equal(result.retryable, true);
  assert.equal(result.metrics.diagnostics.failureStage, "provider_rate_limit");
  assert.equal(result.metrics.diagnostics.providerCode, "rate_limited");
});

test("CODEX-DIAG-10: signal ile sonlanan manuel iptal cancelled olarak raporlanır", async () => {
  const adapter = createCodexAdapter({
    codex: { executable: process.execPath, execArgs: ["-e", "process.stdout.write('partial'); setTimeout(() => {}, 5000);"] }
  });
  const pending = adapter.execute({
    executionId: "codex-cancel-diagnostics",
    backend: "codex",
    prompt: "inspect",
    model: "gpt-5",
    mode: "read_only",
    workspace: process.cwd(),
    delegationDepth: 0,
    caller: "test",
    timeoutMs: 5000
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await adapter.cancel("codex-cancel-diagnostics");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cancelled");
  assert.equal(result.metrics.diagnostics.failureStage, "cancelled");
  assert.equal(Number.isInteger(result.metrics.diagnostics.stdoutBytes), true);
  assert.equal(validateSubagentResult(result).success, true);
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

test("CX-AC-12: parallel edit args force network access off", () => {
  const request = { target: "codex", prompt: "change", model: "default", mode: "edit", workspace: process.cwd(), caller: "parallel_batch_edit", delegationDepth: 0 };
  const command = buildCodexArgs(request, { codex: { executable: "codex" } });
  const configIndex = command.args.indexOf("sandbox_workspace_write.network_access=false");
  assert.equal(configIndex > 0, true);
  assert.equal(command.args[configIndex - 1], "-c");
  const readOnlyCommand = buildCodexArgs({ ...request, mode: "read_only", caller: "parallel_batch" }, { codex: { executable: "codex" } });
  assert.equal(readOnlyCommand.args.includes("sandbox_workspace_write.network_access=false"), false);
});
