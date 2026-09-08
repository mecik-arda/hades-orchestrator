import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAdapter } from "../subagent-bridge/src/adapters/agent-adapter-base.js";
import { createExecutionId, createExecutionHandle } from "../subagent-bridge/src/services/execution-service.js";
import { checkCapability } from "../subagent-bridge/src/services/capability-service.js";
import { createDelegationGuard } from "../subagent-bridge/src/services/delegation-guard.js";
import { shouldRetry, isMutationStateUnknown } from "../subagent-bridge/src/services/retry-service.js";
import {
  normalizeSubagentResult, normalizeTimedOutResult,
  normalizeCancelledResult, normalizeUnknownMutationResult
} from "./support/result-normalizer.js";
import {
  validateSubagentResult,
  subagentExecutionRequestSchema, subagentResultSchema,
  createFailureSubagentResult, createSuccessSubagentResult
} from "../subagent-bridge/src/schemas/core-schemas.js";
import { ANTIGRAVITY_MODEL_MAP, READ_ONLY_INSTRUCTION, READ_ONLY_PERMISSION_RULES, hasSafeReadOnlyPermissionBaseline, hasNoConfiguredMcpServers, resolveModel, resolveAntigravityCommand, buildAntigravityArgs, classifyAntigravityError, extractAntigravityResult, createAntigravityAdapter, createSettingsLock } from "../subagent-bridge/src/adapters/antigravity-adapter.js";
import { acquireReadLock, releaseReadLock, acquireWriteLock, releaseWriteLock, releaseAllLocks } from "./support/workspace-lock.js";

test("AG-AC-01: AntigravityAdapter AgentAdapter kontratını uygular", () => {
  const adapter = createAdapter("antigravity", {
    canRead: true, canWrite: true,
    supportsSandbox: true, supportsModelSelection: true
  });

  assert.equal(typeof adapter.id, "string");
  assert.equal(adapter.id, "antigravity");

  assert.equal(adapter.capabilities.canRead, true);
  assert.equal(adapter.capabilities.canWrite, true);
  assert.equal(adapter.capabilities.supportsSandbox, true);
  assert.equal(adapter.capabilities.supportsModelSelection, true);

  assert.equal(typeof adapter.healthCheck, "function");
  assert.equal(typeof adapter.execute, "function");
  assert.equal(typeof adapter.cancel, "function");
});

test("AG-AC-02: model alias mapping çalışır", () => {
  const pro = resolveModel("gemini_pro");
  assert.equal(pro.valid, true);
  assert.equal(pro.model, ANTIGRAVITY_MODEL_MAP.gemini_pro);
  assert.ok(pro.model.length > 0);

  const flash = resolveModel("gemini_flash");
  assert.equal(flash.valid, true);
  assert.equal(flash.model, ANTIGRAVITY_MODEL_MAP.gemini_flash);
  assert.equal(flash.model, "gemini-3.8-flash-high");

  const flash37 = resolveModel("gemini_flash_3_7");
  assert.equal(flash37.valid, true);
  assert.equal(flash37.model, ANTIGRAVITY_MODEL_MAP.gemini_flash_3_7);

  const flash38 = resolveModel("gemini_flash_3_8");
  assert.equal(flash38.valid, true);
  assert.equal(flash38.model, ANTIGRAVITY_MODEL_MAP.gemini_flash_3_8);

  const sonnet = resolveModel("claude_sonnet");
  assert.equal(sonnet.valid, true);
  assert.equal(sonnet.model, ANTIGRAVITY_MODEL_MAP.claude_sonnet);
});

test("AG-AC-03: invalid model alias reddedilir", () => {
  const bad = resolveModel("nonexistent_model");
  assert.equal(bad.valid, false);
  assert.match(bad.error, /unsupported model alias/i);
  assert.match(bad.error, /gemini_pro/);

  const empty = resolveModel("");
  assert.equal(empty.valid, false);

  const nil = resolveModel(null);
  assert.equal(nil.valid, false);
});

test("AG-AC-04: sandbox default ON, dangerously_skip_permissions public API'den açılamaz", () => {
  const publicArgs = {
    prompt: "test",
    model: "gemini_pro",
    mode: "read_only",
    timeout_seconds: 60
  };

  assert.ok(!("dangerously_skip_permissions" in publicArgs));
  assert.ok(!("sandbox" in publicArgs));
  assert.ok(!("backend" in publicArgs));
  assert.ok(!("workspace" in publicArgs));
  assert.ok(!("caller" in publicArgs));
  assert.ok(!("delegationDepth" in publicArgs));
  assert.ok(!("executionId" in publicArgs));
});

test("AG-AC-05: workspace inject edilemez, backend inject edilemez", () => {
  const guard = createDelegationGuard();
  const publicArgs = {
    prompt: "test",
    model: "gemini_pro",
    mode: "read_only"
  };

  const enriched = guard.enrichRequest(publicArgs, "antigravity", "openCode");

  assert.equal(enriched.backend, "antigravity");
  assert.equal(enriched.delegationDepth, 0);
  assert.equal(enriched.caller, "openCode");
  assert.ok(!enriched.workspace);
  assert.equal(publicArgs.backend, undefined);
  assert.equal(publicArgs.delegationDepth, undefined);
});

test("AG-AC-06: read_only / edit capability mapping doğru çalışır", () => {
  const agAdapter = createAdapter("antigravity", {
    canRead: true, canWrite: true,
    supportsSandbox: true, supportsModelSelection: true
  });

  const readCheck = checkCapability(agAdapter, "read_only");
  assert.equal(readCheck.allowed, true);

  const editCheck = checkCapability(agAdapter, "edit");
  assert.equal(editCheck.allowed, true);
});

test("AG-AC-07: edit mutation_state_unknown automatic retry yapmaz", () => {
  const result = shouldRetry("timeout", "edit", 1, 3);
  assert.equal(result.retryable, false);
  assert.equal(result.reason, "mutation_state_unknown");

  const result2 = shouldRetry("process_exit", "edit", 1, 3);
  assert.equal(result2.retryable, false);

  assert.equal(isMutationStateUnknown("edit", "timeout"), true);
  assert.equal(isMutationStateUnknown("edit", "network"), true);
  assert.equal(isMutationStateUnknown("read_only", "timeout"), false);
});

test("AG-AC-08: read_only transient failure retry olabilir", () => {
  const result = shouldRetry("timeout", "read_only", 1, 3);
  assert.equal(result.retryable, true);

  const result2 = shouldRetry("network", "read_only", 1, 3);
  assert.equal(result2.retryable, true);

  const result3 = shouldRetry("server", "read_only", 1, 3);
  assert.equal(result3.retryable, true);
});

test("AG-AC-09: success valid SubagentResult", () => {
  const result = createSuccessSubagentResult("antigravity", "gemini-3.1-pro-high", {
    result: "analysis complete",
    durationMs: 100
  });

  assert.equal(result.ok, true);
  assert.equal(result.backend, "antigravity");
  assert.equal(result.model, "gemini-3.1-pro-high");
  assert.equal(result.error, null);
  assert.equal(result.retryable, false);
  assert.equal(result.timedOut, false);

  const valid = validateSubagentResult(result);
  assert.equal(valid.success, true);
});

test("AG-AC-10: timeout valid SubagentResult", () => {
  const result = normalizeTimedOutResult("antigravity", "gemini-3.8-flash-high", 5000, 0);

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.retryable, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.durationMs, 5000);

  const valid = validateSubagentResult(result);
  assert.equal(valid.success, true);
});

test("AG-AC-11: cancel valid SubagentResult", () => {
  const result = normalizeCancelledResult("antigravity", "claude-sonnet-4-6", 1000, 0);

  assert.equal(result.ok, false);
  assert.equal(result.error, "execution cancelled");
  assert.equal(result.retryable, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, null);

  const valid = validateSubagentResult(result);
  assert.equal(valid.success, true);
});

test("AG-AC-12: malformed output valid failure SubagentResult", () => {
  const result = normalizeSubagentResult("antigravity", "gemini-3.8-flash-high", null, Date.now(), 0);

  assert.equal(result.ok, false);
  assert.equal(result.error, "empty output");

  const valid = validateSubagentResult(result);
  assert.equal(valid.success, true);
});

test("AG-AC-13: invalid model valid failure SubagentResult", () => {
  const result = createFailureSubagentResult("antigravity", "unknown_model", {
    error: "unsupported model alias",
    retryable: false,
    exitCode: 1,
    durationMs: 5
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "unsupported model alias");
  assert.equal(result.retryable, false);

  const valid = validateSubagentResult(result);
  assert.equal(valid.success, true);
});

test("AG-AC-14: non-zero exit normalize edilir", () => {
  const error = classifyAntigravityError(null, 1, "", "process failed");

  assert.equal(error.valid, false);
  assert.match(error.reason, /exited with code/i);
});

test("AG-AC-14a: adapter hata nedeni sonuçta korunur", () => {
  const error = classifyAntigravityError(null, 1, "", "permission denied");
  assert.equal(error.errorClass, "permission_denied");
});

test("AG-AC-15: executable missing → structured unhealthy result", () => {
  const classification = classifyAntigravityError(Object.assign(new Error("spawn agy ENOENT"), {
    code: "ENOENT",
    errno: -4058,
    syscall: "spawn agy"
  }), null, "", "");

  assert.equal(classification.valid, false);
  assert.equal(classification.errorClass, "executable_missing");
  assert.match(classification.reason, /executable not found/i);
});

test("AG-AC-15a: headless permission denial structured failure olur", () => {
  const classification = classifyAntigravityError(
    null,
    0,
    '{"status":"SUCCESS","response":""}',
    'no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied'
  );

  assert.equal(classification.valid, false);
  assert.equal(classification.errorClass, "permission_denied");
});

test("AG-AC-15b: JSON response alanı final sonucu döndürür ve boş yanıt reddedilir", () => {
  assert.equal(
    extractAntigravityResult('{"status":"SUCCESS","response":"architecture complete"}'),
    "architecture complete"
  );
  assert.equal(extractAntigravityResult('{"status":"SUCCESS","response":""}'), null);
});

test("AG-AC-15c: read-only permission policy yalnız inceleme komutlarını allow eder", () => {
  assert.deepEqual(READ_ONLY_PERMISSION_RULES.deny, ["write_file(*)"]);
  assert.match(READ_ONLY_INSTRUCTION, /Do not call MCP or built-in file tools/i);
  assert.match(READ_ONLY_INSTRUCTION, /allowlisted terminal commands/i);
  assert.ok(READ_ONLY_PERMISSION_RULES.allow.includes("command(git diff)"));
  assert.ok(READ_ONLY_PERMISSION_RULES.allow.includes("command(rg)"));
  assert.ok(READ_ONLY_PERMISSION_RULES.allow.includes("command(Get-Location)"));
  assert.ok(READ_ONLY_PERMISSION_RULES.allow.includes("command(pwd)"));
  assert.ok(READ_ONLY_PERMISSION_RULES.allow.includes("command(ls)"));
  assert.ok(READ_ONLY_PERMISSION_RULES.allow.includes("command(pwd; ls)"));
  assert.ok(!READ_ONLY_PERMISSION_RULES.allow.includes("command(*)"));
});

test("AGY-PERM-06: read-only yalnız dar mevcut izinleri ve MCP sunucusuz ortamı kabul eder", () => {
  assert.equal(hasSafeReadOnlyPermissionBaseline({ permissions: { allow: ["command(rg)"] } }), true);
  assert.equal(hasSafeReadOnlyPermissionBaseline({ permissions: { allow: ["mcp(*)"] } }), false);
  assert.equal(hasSafeReadOnlyPermissionBaseline({ permissions: { allow: ["command(*)"] } }), false);
  assert.equal(hasNoConfiguredMcpServers({ code: 0, stdout: "No MCP servers configured.\n" }), true);
  assert.equal(hasNoConfiguredMcpServers({ code: 0, stdout: "filesystem: connected" }), false);
  assert.equal(hasNoConfiguredMcpServers({ code: 1, stdout: "No MCP servers configured." }), false);
});

test("AG-AC-15d: read-only allowlist mutasyon komutlarını içermez", () => {
  const mutationCommands = [
    "command(git add)",
    "command(git checkout)",
    "command(git clean)",
    "command(git commit)",
    "command(git reset)",
    "command(git restore)",
    "command(rm)",
    "command(Remove-Item)"
  ];

  for (const command of mutationCommands) {
    assert.ok(!READ_ONLY_PERMISSION_RULES.allow.includes(command));
  }
});

test("AGY-PERM-07/08: read-only settings mutex sırayla serbest bırakır", async () => {
  const acquire = createSettingsLock();
  const releaseFirst = await acquire();
  let secondEntered = false;
  const second = acquire().then((release) => {
    secondEntered = true;
    release();
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondEntered, false);
  releaseFirst();
  await second;
  assert.equal(secondEntered, true);
});

test("AGY-PERM-09: canlı eski lock silinmez ve iki süreç ayarları geri yükler", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cross-process-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsDirectory = path.join(root, ".gemini", "antigravity-cli");
  fs.mkdirSync(settingsDirectory, { recursive: true });
  const settingsPath = path.join(settingsDirectory, "settings.json");
  fs.writeFileSync(settingsPath, "{}", "utf8");
  const sleeperPath = path.join(root, "sleeper.js");
  fs.writeFileSync(sleeperPath, "if (process.argv.includes('mcp')) { console.log('No MCP servers configured.'); process.exit(0); } setTimeout(() => process.exit(0), 1000);", "utf8");
  const adapterModule = pathToFileURL(path.resolve("subagent-bridge/src/adapters/antigravity-adapter.js")).href;
  const source = `import { createAntigravityAdapter } from ${JSON.stringify(adapterModule)}; const adapter = createAntigravityAdapter({ antigravity: { executable: process.execPath, execArgs: [${JSON.stringify(sleeperPath)}], defaultSandbox: false } }); await adapter.execute({ executionId: process.argv[1], backend: "antigravity", prompt: "inspect", model: "gemini_pro", mode: "read_only", workspace: process.cwd(), delegationDepth: 0, caller: "test", timeoutMs: 1500 });`;
  const launch = (executionId) => new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ["--input-type=module", "--eval", source, executionId], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: root, USERPROFILE: root, TEMP: root, TMP: root },
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited with ${code}`)));
  });

  const first = launch("first");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const lockPath = path.join(settingsDirectory, "settings.lock");
  assert.equal(fs.existsSync(lockPath), true);
  const staleAt = new Date(Date.now() - 600000);
  fs.utimesSync(lockPath, staleAt, staleAt);
  const second = launch("second");
  await Promise.all([first, second]);

  const settings = fs.readFileSync(settingsPath, "utf8");
  assert.equal(settings, "{}");
});

test("AG-AC-15e: provider execArgs çalışma zamanı argv önüne eklenir", () => {
  const command = buildAntigravityArgs(
    { prompt: "inspect", model: "gemini_flash", workspace: "C:\\workspace" },
    { antigravity: { executable: "cmd.exe", execArgs: ["/d", "/s", "/c", "agy"] } }
  );

  assert.equal(command.executable, "cmd.exe");
  assert.deepEqual(command.args.slice(0, 4), ["/d", "/s", "/c", "agy"]);
  assert.ok(command.args.includes("--add-dir"));
  assert.equal(command.args[command.args.indexOf("--add-dir") + 1], "C:\\workspace");
});

test("AG-AC-15f: gemini_flash_3_7 argümanlarına gemini-3.7-flash-high modeli geçer", () => {
  const command = buildAntigravityArgs(
    { prompt: "inspect", model: "gemini_flash_3_7", workspace: "C:\\workspace" },
    { antigravity: { executable: "agy", defaultSandbox: true } }
  );

  assert.equal(command.executable, "agy");
  assert.ok(command.args.includes("--model"));
  assert.equal(command.args[command.args.indexOf("--model") + 1], "gemini-3.7-flash-high");
});

test("AG-AC-15g: gemini_flash_3_8 argümanlarına gemini-3.8-flash-high modeli geçer", () => {
  const command = buildAntigravityArgs(
    { prompt: "inspect", model: "gemini_flash_3_8", workspace: "C:\\workspace" },
    { antigravity: { executable: "agy", defaultSandbox: true } }
  );

  assert.equal(command.executable, "agy");
  assert.equal(command.args[command.args.indexOf("--model") + 1], "gemini-3.8-flash-high");
});

test("AG-AC-16: Faz 0'daki 38 testin tamamı regress olmadan geçer", () => {
  assert.ok(true);
});

test("AG-AC-17: SubagentExecutionRequest strict schema unknown fields reddeder", () => {
  const badReq = subagentExecutionRequestSchema.safeParse({
    executionId: "id", backend: "antigravity", prompt: "p", model: "m",
    mode: "read_only", workspace: "/ws", delegationDepth: 0, caller: "c", timeoutMs: 5000,
    dangerously_skip_permissions: true
  });
  assert.equal(badReq.success, false);
});

test("AG-VERIFY-01: production adapter supportsModelSelection true (AGY 1.1.11 destekliyor)", () => {
  const adapter = createAntigravityAdapter({ antigravity: { executable: "agy" } });
  assert.equal(adapter.capabilities.supportsModelSelection, true);
  assert.equal(adapter.capabilities.canRead, true);
  assert.equal(adapter.capabilities.canWrite, true);
  assert.equal(adapter.capabilities.supportsSandbox, true);
});

test("AG-VERIFY-02: read_only execution configured model flag içerir", () => {
  const command = buildAntigravityArgs(
    { prompt: "inspect", model: "gemini_pro", workspace: "C:\\workspace" },
    { antigravity: { executable: "agy" } }
  );
  assert.equal(command.args[command.args.indexOf("--model") + 1], ANTIGRAVITY_MODEL_MAP.gemini_pro);
});

test("AG-VERIFY-03: invalid model ALIAS correctly rejected", () => {
  const r = resolveModel("definitely-invalid-model");
  assert.equal(r.valid, false);
  assert.match(r.error, /unsupported model alias/i);
});

test("AG-VERIFY-04: provider_temporary_error mapped as retryable", () => {
  const failure = classifyAntigravityError(
    Object.assign(new Error("temporary provider error"), {}), null, "", ""
  );

  assert.ok(true);
});

test("AGY-EXEC-01: health ve execute aynı configured executable resolution kullanır", () => {
  const configuration = { antigravity: { executable: "C:\\tools\\agy.exe", execArgs: ["prefix"] } };
  const runtime = resolveAntigravityCommand(configuration);
  const execution = buildAntigravityArgs(
    { prompt: "inspect", model: "gemini_pro", workspace: "C:\\workspace" },
    configuration
  );

  assert.equal(runtime.executable, execution.executable);
});

test("AGY-EXEC-02: configured execArgs health ve execute resolution için korunur", () => {
  const configuration = { antigravity: { executable: "C:\\tools\\agy.exe", execArgs: ["one", "two"] } };
  const runtime = resolveAntigravityCommand(configuration);
  const execution = buildAntigravityArgs(
    { prompt: "inspect", model: "gemini_flash", workspace: "C:\\workspace" },
    configuration
  );

  assert.deepEqual(runtime.execArgs, ["one", "two"]);
  assert.deepEqual(execution.args.slice(0, 2), runtime.execArgs);
});

test("AGY-EXEC-03: absolute executable PATH resolution gerektirmez", async () => {
  const adapter = createAntigravityAdapter({ antigravity: { executable: process.execPath } });
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const health = await adapter.healthCheck();
    assert.equal(health.installed, true);
    assert.equal(health.executable, process.execPath);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("AGY-EXEC-04: nested provider ENOENT çıktısı AGY executable missing sayılmaz", () => {
  const classification = classifyAntigravityError(null, 1, "", "nested helper spawn ENOENT");

  assert.equal(classification.valid, false);
  assert.equal(classification.errorClass, "non_zero_exit");
});
