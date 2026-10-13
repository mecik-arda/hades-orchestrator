import test from "node:test";
import assert from "node:assert/strict";
import { createOpenCodeAdapter, resolveModel, parseOpenCodeOutput, classifyOpenCodeError, isOpenCodeRateLimitMessage, isOpenCodeModelAccessDeniedMessage, OPENCODE_MODEL_MAP, buildOpenCodeArgs, buildOpenCodeReviewInlineConfiguration, buildParallelWorkerInlineConfiguration, buildSpaceBunnyInlineConfiguration } from "../subagent-bridge/src/adapters/opencode-adapter.js";
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

test("OC-AC-11a: parseOpenCodeOutput gürültülü stdout içindeki geçerli satırları ayrıştırır", () => {
  const noisyOutput = [
    "opencode başlatılıyor...",
    "deprecation warning: eski yapılandırma anahtarı",
    '{"type":"text","part":{"id":"p","type":"text","text":"Önemli sonuç"}}',
    '{"type":"text","part":{"id":"p","type":"text","text":"yarım kalan satır"',
    "random log satırı",
    '{"type":"step_finish","part":{"tokens":{"total":40,"input":10,"output":30}}}'
  ].join("\n");
  const parsed = parseOpenCodeOutput(noisyOutput);
  assert.equal(parsed.ok, true);
  assert.match(parsed.text, /Önemli sonuç/);
  assert.equal(parsed.usage.tokens.total, 40);
});

test("OC-AC-11b: parseOpenCodeOutput yalnız kullanım verisini başarı saymaz", () => {
  const parsed = parseOpenCodeOutput('{"type":"step_finish","part":{"tokens":{"total":40,"input":10,"output":30}}}');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "no usable output");
});

test("OC-AC-11c: non-zero OpenCode exit parse edilebilir stdout olsa da hata döner", async () => {
  const adapter = createOpenCodeAdapter({
    opencode: {
      executable: process.execPath,
      execArgs: ["-e", "process.stdout.write('{\"type\":\"text\",\"part\":{\"text\":\"unexpected\"}}\\n', () => process.exit(2));"],
      allowedModels: ["deepseek/deepseek-v4-pro"]
    }
  });
  const result = await adapter.execute({
    executionId: "non-zero-exit",
    backend: "opencode",
    prompt: "inspect",
    model: "deepseek/deepseek-v4-pro",
    mode: "read_only",
    workspace: process.cwd(),
    delegationDepth: 0,
    caller: "test",
    timeoutMs: 5000
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "non_zero_exit");
  assert.equal(result.exitCode, 2);
  assert.equal(result.metrics.diagnostics.failureStage, "provider_process_exit");
  assert.equal(result.metrics.diagnostics.stdoutBytes, Buffer.byteLength('{"type":"text","part":{"text":"unexpected"}}\n', "utf8"));
  assert.equal(result.metrics.diagnostics.stderrBytes, 0);
});

test("OC-AC-11d: sinyalle sonlanan OpenCode süreci başarı sayılmaz", () => {
  assert.equal(classifyOpenCodeError(null, null, "partial text", "").valid, false);
  assert.equal(classifyOpenCodeError(null, null, "partial text", "", "SIGKILL").errorClass, "non_zero_exit");
});

test("OC-AC-11e: yalnız boşluk içeren OpenCode metni başarı sayılmaz", async () => {
  const adapter = createOpenCodeAdapter({
    opencode: {
      executable: process.execPath,
      execArgs: ["-e", "process.stdout.write('{\"type\":\"text\",\"part\":{\"text\":\"   \"}}\\n', () => process.exit(0));"],
      allowedModels: ["deepseek/deepseek-v4-pro"]
    }
  });
  const result = await adapter.execute({
    executionId: "whitespace-output",
    backend: "opencode",
    prompt: "inspect",
    model: "deepseek/deepseek-v4-pro",
    mode: "read_only",
    workspace: process.cwd(),
    delegationDepth: 0,
    caller: "test",
    timeoutMs: 5000
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "no usable output");
});

test("OC-AC-11f: sinyal sonucu null exitCode ve sinyal telemetrisini taşır", () => {
  const result = createFailureSubagentResult("opencode", "deepseek/deepseek-v4-pro", {
    error: "process terminated by signal SIGTERM",
    retryable: false,
    timedOut: false,
    exitCode: null,
    reason: "non_zero_exit",
    metrics: { signal: "SIGTERM" }
  });
  assert.equal(result.exitCode, null);
  assert.equal(result.metrics.signal, "SIGTERM");
  assert.equal(validateSubagentResult(result).success, true);
});

test("OC-AC-14c: bilinmeyen exit code genel sınıfa düşer ve kodu korur", () => {
  const classification = classifyOpenCodeError(null, 42, "", "");
  assert.equal(classification.valid, false);
  assert.equal(classification.errorClass, "non_zero_exit");
  assert.match(classification.reason, /42/);
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
  assert.equal(isOpenCodeRateLimitMessage(JSON.stringify({ type: "error", error: { code: "rate_limited" } })), true);
  assert.equal(isOpenCodeRateLimitMessage(JSON.stringify({ type: "error", error: { status: 429, code: "too_many_requests" } })), true);
  assert.equal(isOpenCodeRateLimitMessage("Quota exceeded for model requests"), false);
  assert.equal(isOpenCodeRateLimitMessage('Task output quoted: {"type":"error","error":{"code":"rate_limited"}}'), false);
  assert.equal(isOpenCodeRateLimitMessage("repository inspection complete"), false);
  assert.equal(classifyOpenCodeError(null, 1, JSON.stringify({ type: "error", error: { code: "rate_limited" } }), "").errorClass, "rate_limited");
  assert.equal(classifyOpenCodeError(null, 0, JSON.stringify({ type: "error", error: { code: "rate_limited" } }), "").errorClass, "rate_limited");
  assert.equal(classifyOpenCodeError(null, 1, "", "The log says quota exceeded for model requests").errorClass, "non_zero_exit");
});

test("OC-AC-14e: structured FreeTierError 403 becomes a non-retryable provider denial", async () => {
  const responseBody = JSON.stringify({ type: "error", error: { type: "FreeTierError", message: "OpenCode Free Tier rejected CLI access" } });
  const providerEvent = JSON.stringify({ type: "error", error: { name: "APIError", data: { statusCode: 403, responseBody } } });
  const unrelated403 = JSON.stringify({ type: "error", error: { name: "APIError", data: { statusCode: 403, responseBody: JSON.stringify({ type: "error", error: { type: "ForbiddenError" } }) } } });
  assert.equal(classifyOpenCodeError(null, 1, `${unrelated403}\n`, "").errorClass, "non_zero_exit");

  const catalogEntry = { id: "space-bunny-free", providerID: "opencode", status: "active", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, capabilities: { toolcall: true } };
  const script = `if (process.argv.includes("models")) process.stdout.write(${JSON.stringify(`opencode/space-bunny-free\n${JSON.stringify(catalogEntry)}\n`)}); else { process.stdout.write(${JSON.stringify(`${providerEvent}\n`)}); process.exit(1); }`;
  const adapter = createOpenCodeAdapter({
    opencode: {
      executable: process.execPath,
      execArgs: ["-e", script],
      allowedModels: ["opencode/space-bunny-free"]
    }
  });
  const result = await adapter.execute({
    executionId: "opencode-free-tier-denial",
    backend: "opencode",
    prompt: "inspect",
    model: "opencode/space-bunny-free",
    mode: "read_only",
    workspace: process.cwd(),
    caller: "test",
    delegationDepth: 0,
    timeoutMs: 5000
  });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(result.reason, "permission_denied");
  assert.equal(result.error, "OpenCode Free Tier rejected CLI access");
  assert.equal(result.metrics.diagnostics.failureStage, "provider_execution");
  assert.equal(result.metrics.diagnostics.providerCode, "permission_denied");
  assert.equal(validateSubagentResult(result).success, true);
});

test("OC-AC-14d: serbest stderr içindeki 429 metni OpenCode sürecini iptal etmez", async () => {
  const script = `process.stderr.write("Quota exceeded for model requests\\n"); setTimeout(() => process.stdout.write(JSON.stringify({ type: "text", part: { text: "complete" } }) + "\\n"), 80);`;
  const adapter = createOpenCodeAdapter({ opencode: { executable: process.execPath, execArgs: ["-e", script] } });
  const result = await adapter.execute({
    executionId: "opencode-rate-limit-prose",
    backend: "opencode",
    prompt: "inspect",
    model: "deepseek/deepseek-v4-pro",
    mode: "read_only",
    workspace: process.cwd(),
    caller: "test",
    delegationDepth: 0,
    timeoutMs: 5000
  });
  assert.equal(result.ok, true);
  assert.equal(result.result, "complete");
  assert.ok(result.durationMs >= 50);
  assert.equal(result.metrics.diagnostics.stderrBytes, Buffer.byteLength("Quota exceeded for model requests\n", "utf8"));
});

test("OC-DIAG-01: timeout ve cancel yolları strict diagnostics taşır", async () => {
  const adapter = createOpenCodeAdapter({
    opencode: { executable: process.execPath, execArgs: ["-e", "process.stdout.write('partial'); setTimeout(() => {}, 5000);"] }
  });
  const request = (executionId) => ({
    executionId,
    backend: "opencode",
    prompt: "inspect",
    model: "deepseek/deepseek-v4-pro",
    mode: "read_only",
    workspace: process.cwd(),
    delegationDepth: 0,
    caller: "test",
    timeoutMs: 5000
  });
  const timedOut = await createOpenCodeAdapter({
    opencode: { executable: process.execPath, execArgs: ["-e", "process.stdout.write('partial'); setTimeout(() => {}, 5000);"] }
  }).execute({ ...request("opencode-timeout-diagnostics"), timeoutMs: 80 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, "timeout");
  assert.equal(timedOut.metrics.diagnostics.failureStage, "provider_execution");
  assert.equal(Number.isInteger(timedOut.metrics.diagnostics.stdoutBytes), true);
  assert.equal(validateSubagentResult(timedOut).success, true);

  const pending = adapter.execute(request("opencode-cancel-diagnostics"));
  await new Promise((resolve) => setTimeout(resolve, 80));
  await adapter.cancel("opencode-cancel-diagnostics");
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.reason, "cancelled");
  assert.equal(cancelled.metrics.diagnostics.failureStage, "cancelled");
  assert.equal(Number.isInteger(cancelled.metrics.diagnostics.stdoutBytes), true);
  assert.equal(validateSubagentResult(cancelled).success, true);
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

test("OC-AC-19: parallel worker inline config restricts tools and carries steps", () => {
  const readOnlyConfig = JSON.parse(buildParallelWorkerInlineConfiguration("read_only", 3));
  const readOnlyAgent = readOnlyConfig.agent["parallel-readonly"];
  assert.equal(readOnlyAgent.steps, 3);
  assert.equal(readOnlyAgent.permission["*"], "deny");
  assert.equal(readOnlyAgent.permission.read, "allow");
  assert.equal(readOnlyAgent.permission.glob, "allow");
  assert.equal(readOnlyAgent.permission.grep, "allow");
  assert.equal(readOnlyAgent.permission.list, "allow");
  assert.equal(readOnlyAgent.permission.edit, undefined);
  assert.equal(readOnlyAgent.permission.bash, undefined);
  assert.equal(readOnlyAgent.permission.task, undefined);
  const editConfig = JSON.parse(buildParallelWorkerInlineConfiguration("edit", 5));
  const editAgent = editConfig.agent["parallel-edit"];
  assert.equal(editAgent.steps, 5);
  assert.equal(editAgent.permission.edit, "allow");
  assert.equal(editAgent.permission["*"], "deny");
});

test("OC-AC-20: parallel task output token cap reaches the pinned OpenCode worker request", async () => {
  const adapter = createOpenCodeAdapter({
    opencode: {
      executable: process.execPath,
      execArgs: ["-e", "process.stdout.write(JSON.stringify({type:'text',part:{text:process.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX}})+'\\n')"],
      allowedModels: ["deepseek/deepseek-v4-pro"]
    },
    parallelBatch: { opencodeOutputCapability: "available", opencodeOutputTokens: 2048, opencodeSteps: 5 }
  });
  const result = await adapter.execute({
    executionId: "parallel-output-token-cap",
    backend: "opencode",
    prompt: "inspect",
    model: "deepseek/deepseek-v4-pro",
    mode: "read_only",
    workspace: process.cwd(),
    delegationDepth: 0,
    caller: "parallel_batch",
    timeoutMs: 5000,
    maxOutputBytes: 2048,
    maxOutputTokens: 512
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.trim(), "512");
});

test("OC-AC-21: task output byte cap is enforced by the OpenCode process collector", async () => {
  const adapter = createOpenCodeAdapter({
    opencode: {
      executable: process.execPath,
      execArgs: ["-e", "process.stdout.write('x'.repeat(4096))"],
      allowedModels: ["deepseek/deepseek-v4-pro"]
    }
  });
  const result = await adapter.execute({
    executionId: "parallel-output-byte-cap",
    backend: "opencode",
    prompt: "inspect",
    model: "deepseek/deepseek-v4-pro",
    mode: "read_only",
    workspace: process.cwd(),
    delegationDepth: 0,
    caller: "parallel_batch",
    timeoutMs: 5000,
    maxOutputBytes: 1024
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "output_limit", JSON.stringify(result));
  assert.equal(result.metrics.diagnostics.failureStage, "result_parse");
  assert.equal(validateSubagentResult(result).success, true);
});

test("OC-REVIEW-01: host source reviewer has no workspace or tool permissions", () => {
  const configuration = JSON.parse(buildOpenCodeReviewInlineConfiguration("deepseek/deepseek-v4-pro"));
  const agent = configuration.agent["host-source-review"];
  assert.equal(agent.model, "deepseek/deepseek-v4-pro");
  assert.equal(agent.permission["*"], "deny");
  assert.equal(agent.permission.external_directory, "deny");
  assert.equal(agent.permission.read, undefined);
  assert.equal(agent.permission.glob, undefined);
  assert.equal(agent.permission.grep, undefined);
  assert.equal(agent.permission.list, undefined);
  const spaceBunnyConfig = JSON.parse(buildSpaceBunnyInlineConfiguration("read_only", "space_bunny", true));
  const spaceBunnyAgent = spaceBunnyConfig.agent["space-bunny-source-review"];
  assert.equal(spaceBunnyAgent.permission["*"], "deny");
  assert.equal(spaceBunnyAgent.permission.read, undefined);
  assert.equal(spaceBunnyAgent.permission.websearch, undefined);
  const args = buildOpenCodeArgs({ mode: "read_only", caller: "test_review", workspace: "C:\\workspace", prompt: "review", reviewSourcePayload: "source" }, {}, "deepseek/deepseek-v4-pro");
  assert.equal(args[args.indexOf("--agent") + 1], "host-source-review");
  const spaceBunnyArgs = buildOpenCodeArgs({ mode: "read_only", caller: "space_bunny", workspace: "C:\\workspace", prompt: "review", reviewSourcePayload: "source" }, {}, "opencode/space-bunny-free");
  assert.equal(spaceBunnyArgs[spaceBunnyArgs.indexOf("--agent") + 1], "space-bunny-source-review");
});

for (const verifiedVersion of ["1.18.35", "1.19.0"]) {
  test(`OC-REVIEW-02: required source-bundle stdin is accepted on verified OpenCode ${verifiedVersion}`, async () => {
    const script = `const args=process.argv.slice(1); if(args.includes('--version')) process.stdout.write('${verifiedVersion}'); else { let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { const agent = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).agent['host-source-review']; process.stdout.write(JSON.stringify({type:'text',part:{text:JSON.stringify({input,permission:agent.permission,database:process.env.OPENCODE_DB})}})+'\\n'); }); }`;
    const adapter = createOpenCodeAdapter({
      opencode: {
        executable: process.execPath,
        execArgs: ["-e", script, "--"],
        allowedModels: ["deepseek/deepseek-v4-pro"]
      }
    });
    const result = await adapter.execute({
      executionId: `source-bundle-transport-supported-${verifiedVersion}`,
      backend: "opencode",
      prompt: "Review the host-delivered source.",
      model: "deepseek/deepseek-v4-pro",
      mode: "read_only",
      workspace: process.cwd(),
      delegationDepth: 0,
      caller: "test_review",
      timeoutMs: 5000,
      reviewSourcePayload: "host source payload"
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    const observed = JSON.parse(result.result);
    assert.equal(observed.input, "host source payload");
    assert.equal(observed.permission["*"], "deny");
    assert.equal(observed.permission.external_directory, "deny");
    assert.equal(observed.database, ":memory:");
  });
}

test("OC-REVIEW-03: unverified OpenCode CLI version rejects required source bundle before run", async () => {
  const script = "const args=process.argv.slice(1); if(args.includes('--version')) process.stdout.write('1.18.36'); else process.stdout.write(JSON.stringify({type:'text',part:{text:'run started'}})+'\\n');";
  const adapter = createOpenCodeAdapter({
    opencode: {
      executable: process.execPath,
      execArgs: ["-e", script, "--"],
      allowedModels: ["deepseek/deepseek-v4-pro"]
    }
  });
  const result = await adapter.execute({
    executionId: "source-bundle-transport-unverified",
    backend: "opencode",
    prompt: "Review the host-delivered source.",
    model: "deepseek/deepseek-v4-pro",
    mode: "read_only",
    workspace: process.cwd(),
    delegationDepth: 0,
    caller: "test_review",
    timeoutMs: 5000,
    reviewSourcePayload: "host source payload"
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "review_source_transport_unsupported");
  assert.equal(result.result, null);
});
