import { createProviderEnvironment, runProcess, createExecutionHandle, killProcessTree } from "../services/execution-service.js";
import { createAdapter } from "./agent-adapter-base.js";
import { createFailureSubagentResult, createSuccessSubagentResult } from "../schemas/core-schemas.js";
import { prependExecutionMetadata } from "../services/execution-metadata.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ANTIGRAVITY_MODEL_MAP = {
  gemini_pro: "gemini-3.1-pro-high",
  gemini_flash: "gemini-3.8-flash-high",
  gemini_flash_3_7: "gemini-3.7-flash-high",
  gemini_flash_3_8: "gemini-3.8-flash-high",
  claude_sonnet: "claude-sonnet-4-6"
};

const READ_ONLY_INSTRUCTION = `
=== READ-ONLY MODE ===
You MUST NOT create, modify, or delete any files in the workspace.
You MUST NOT execute any commands that change the filesystem state.
You may only read, analyze, and report on existing files.
Do not call MCP or built-in file tools. Use only the allowlisted terminal commands to inspect files.
If a terminal command is necessary, run one allowlisted command at a time without chaining, pipelines, or redirection.
If asked to write or modify files, decline and explain that you are in read-only mode.
`;

const READ_ONLY_PERMISSION_RULES = {
  allow: [
    "command(git status)",
    "command(git diff)",
    "command(git log)",
    "command(git show)",
    "command(git ls-files)",
    "command(git rev-parse)",
    "command(rg)",
    "command(Get-ChildItem)",
    "command(Get-Location)",
    "command(dir)",
    "command(pwd)",
    "command(ls)",
    "command(pwd; ls)"
  ],
  deny: [
    "write_file(*)"
  ]
};

const activeExecutionHandles = new Map();

const AGY_SETTINGS_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli");
const AGY_SETTINGS_PATH = path.join(AGY_SETTINGS_DIR, "settings.json");
const AGY_SETTINGS_SENTINEL = path.join(os.tmpdir(), "agy-bridge-readonly-sentinel");
const AGY_SETTINGS_LOCK_PATH = path.join(AGY_SETTINGS_DIR, "settings.lock");
export function createSettingsLock() {
  let settingsMutex = Promise.resolve();
  return async function acquireSettingsLock() {
    let release;
    const previous = settingsMutex;
    settingsMutex = new Promise((resolve) => { release = resolve; });
    await previous;
    return release;
  };
}

const acquireSettingsLock = createSettingsLock();

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readSettingsLockOwner() {
  try {
    const raw = fs.readFileSync(AGY_SETTINGS_LOCK_PATH, "utf8");
    try {
      const value = JSON.parse(raw);
      return { ownerId: value.ownerId, pid: Number.isInteger(value.pid) ? value.pid : null };
    } catch {
      return { ownerId: raw, pid: null };
    }
  } catch {
    return null;
  }
}

async function acquireSettingsFileLock() {
  const ownerId = crypto.randomUUID();
  const deadline = Date.now() + 60000;
  while (true) {
    try {
      const descriptor = fs.openSync(AGY_SETTINGS_LOCK_PATH, "wx");
      fs.writeFileSync(descriptor, JSON.stringify({ ownerId, pid: process.pid }), "utf8");
      return () => {
        fs.closeSync(descriptor);
        try {
          if (readSettingsLockOwner()?.ownerId === ownerId) fs.rmSync(AGY_SETTINGS_LOCK_PATH, { force: true });
        } catch {
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = readSettingsLockOwner();
        const staleLegacyOwner = owner?.pid === null && Date.now() - fs.statSync(AGY_SETTINGS_LOCK_PATH).mtimeMs > 300000;
        if ((Number.isInteger(owner?.pid) && !processIsAlive(owner.pid)) || staleLegacyOwner) {
          if (readSettingsLockOwner()?.ownerId === owner?.ownerId) fs.rmSync(AGY_SETTINGS_LOCK_PATH, { force: true });
        }
      } catch {
      }
      if (Date.now() >= deadline) throw new Error("read-only settings lock unavailable");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function readSettings() {
  if (!fs.existsSync(AGY_SETTINGS_PATH)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(AGY_SETTINGS_PATH, "utf8"));
}

function readSettingsSentinel() {
  if (!fs.existsSync(AGY_SETTINGS_SENTINEL)) {
    return { allow: [], deny: [] };
  }
  try {
    const value = JSON.parse(fs.readFileSync(AGY_SETTINGS_SENTINEL, "utf8"));
    return {
      allow: Array.isArray(value.allow) ? value.allow : [],
      deny: Array.isArray(value.deny) ? value.deny : ["write_file(*)"]
    };
  } catch {
    return { allow: [], deny: ["write_file(*)"] };
  }
}

function hasSafeReadOnlyPermissionBaseline(settings) {
  const allow = settings?.permissions?.allow;
  return !Array.isArray(allow) || allow.every((rule) => READ_ONLY_PERMISSION_RULES.allow.includes(rule));
}

function hasNoConfiguredMcpServers(result) {
  return result?.code === 0 && /^No MCP servers configured\.\s*$/i.test(result.stdout || "");
}

function enableReadOnlyEnforcement() {
  let originalSettings;
  try {
    originalSettings = fs.readFileSync(AGY_SETTINGS_PATH);
    const settings = JSON.parse(originalSettings.toString("utf8"));
    if (!hasSafeReadOnlyPermissionBaseline(settings)) return null;
    settings.permissions ||= {};
    settings.permissions.allow ||= [];
    settings.permissions.deny ||= [];

    const additions = {
      allow: READ_ONLY_PERMISSION_RULES.allow.filter((rule) => !settings.permissions.allow.includes(rule)),
      deny: READ_ONLY_PERMISSION_RULES.deny.filter((rule) => !settings.permissions.deny.includes(rule))
    };

    settings.permissions.allow.push(...additions.allow);
    settings.permissions.deny.push(...additions.deny);
    fs.writeFileSync(AGY_SETTINGS_PATH, JSON.stringify(settings, null, 2));
    fs.writeFileSync(AGY_SETTINGS_SENTINEL, JSON.stringify({ createdAt: Date.now(), ...additions }));
    return { originalSettings };
  } catch {
    try {
      if (originalSettings) fs.writeFileSync(AGY_SETTINGS_PATH, originalSettings);
    } catch {
    }
    return null;
  }
}

function disableReadOnlyEnforcement(enforcement) {
  try {
    if (enforcement?.originalSettings) {
      fs.writeFileSync(AGY_SETTINGS_PATH, enforcement.originalSettings);
    } else {
      const settings = readSettings();
      const additions = readSettingsSentinel();
      if (settings?.permissions) {
        settings.permissions.allow = (settings.permissions.allow || []).filter(
          (rule) => !additions.allow.includes(rule)
        );
        settings.permissions.deny = (settings.permissions.deny || []).filter(
          (rule) => !additions.deny.includes(rule)
        );
        if (settings.permissions.allow.length === 0) {
          delete settings.permissions.allow;
        }
        if (settings.permissions.deny.length === 0) {
          delete settings.permissions.deny;
        }
        if (Object.keys(settings.permissions).length === 0) {
          delete settings.permissions;
        }
        fs.writeFileSync(AGY_SETTINGS_PATH, JSON.stringify(settings, null, 2));
      }
    }

    if (fs.existsSync(AGY_SETTINGS_SENTINEL)) {
      fs.unlinkSync(AGY_SETTINGS_SENTINEL);
    }
  } catch {
  }
}

function isReadOnlyEnforcementActive() {
  try {
    const settings = readSettings();
    return settings?.permissions?.deny?.includes("write_file(*)") || false;
  } catch {
    return false;
  }
}

function recoverStaleSettings(ignoreLock = false) {
  if (!ignoreLock && fs.existsSync(AGY_SETTINGS_LOCK_PATH)) return;
  if (!fs.existsSync(AGY_SETTINGS_SENTINEL)) return;
  try {
    const rawSentinel = fs.readFileSync(AGY_SETTINGS_SENTINEL, "utf8");
    let createdAt;
    try {
      createdAt = JSON.parse(rawSentinel).createdAt;
    } catch {
      createdAt = parseInt(rawSentinel, 10);
    }
    const sentinelAge = Date.now() - createdAt;
    if (sentinelAge > 300000) {
      disableReadOnlyEnforcement();
    }
  } catch {
  }
}

function resolveModel(alias) {
  if (!alias || typeof alias !== "string") {
    return { valid: false, error: "model alias must be a non-empty string" };
  }
  const model = ANTIGRAVITY_MODEL_MAP[alias];
  if (!model) {
    return {
      valid: false,
      error: `unsupported model alias: "${alias}". Supported: ${Object.keys(ANTIGRAVITY_MODEL_MAP).join(", ")}`
    };
  }
  return { valid: true, model };
}

function buildAntigravityArgs(request, config) {
  const resolved = resolveModel(request.model);
  if (!resolved.valid) {
    throw Object.assign(new Error(resolved.error), { failureClass: "invalid_model" });
  }

  const { executable, execArgs } = resolveAntigravityCommand(config);
  const sandbox = config?.antigravity?.defaultSandbox !== false;

  const args = [
    ...execArgs,
    "--output-format", "json",
    "--model", resolved.model,
    "--add-dir", request.workspace
  ];

  if (sandbox) {
    args.push("--sandbox");
  }

  args.push("--mode", request.mode === "read_only" ? "plan" : "accept-edits");

  args.push("--print");
  args.push(prependExecutionMetadata(request.prompt, {
    backend: "antigravity",
    requestedModel: request.model,
    resolvedModel: resolved.model,
    mode: request.mode
  }));

  return { executable, args };
}

function classifyAntigravityError(error, exitCode, stdout, stderr) {
  const errorMessage = error ? String(error.message || error).toLocaleLowerCase("en-US") : "";
  const output = `${stderr || ""} ${stdout || ""}`.toLocaleLowerCase("en-US");

  if (/timed out|timeout|zaman aşımı/i.test(errorMessage)) {
    return { valid: false, errorClass: "timeout", reason: "execution timed out" };
  }

  if (/output limit|bytes/i.test(errorMessage)) {
    return { valid: false, errorClass: "output_limit", reason: "output exceeded limit" };
  }

  if (error?.code === "ENOENT" || /executable not found|enoent|command not found|does not exist/i.test(errorMessage)) {
    return { valid: false, errorClass: "executable_missing", reason: "antigravity executable not found" };
  }

  if (/permission denied|permission_denied|tool required the ["'].*["'] permission|headless mode cannot prompt|auto-denied/i.test(errorMessage + output)) {
    return { valid: false, errorClass: "permission_denied", reason: "permission denied" };
  }

  if (/rate limit|429|quota exceeded/i.test(errorMessage + output)) {
    return { valid: false, errorClass: "rate_limited", reason: "provider rate limited" };
  }

  if (/unauthorized|auth|authentication|invalid.*token|api[._]key/i.test(errorMessage + output)) {
    return { valid: false, errorClass: "provider_auth", reason: "authentication failure" };
  }

  if (exitCode !== null && exitCode !== 0) {
    return { valid: false, errorClass: "non_zero_exit", reason: `process exited with code ${exitCode}` };
  }

  if (error) {
    return { valid: false, errorClass: "process_error", reason: errorMessage || "process error" };
  }

  return { valid: true };
}

function extractAntigravityResult(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.response === "string") {
      return parsed.response.trim() || null;
    }
    return JSON.stringify(parsed);
  } catch {
    return trimmed;
  }
}

function mapCategoryToSubagentError(errorClass, reason, backend, model, durationMs, retries) {
  const base = {
    ok: false,
    backend,
    model,
    result: null,
    error: reason,
    reason,
    durationMs,
    metrics: { retries }
  };

  switch (errorClass) {
    case "timeout":
      return { ...base, retryable: false, timedOut: true, exitCode: null };
    case "output_limit":
      return { ...base, retryable: false, timedOut: false, exitCode: 1 };
    case "executable_missing":
      return { ...base, retryable: false, timedOut: false, exitCode: null };
    case "permission_denied":
    case "policy_violation":
      return { ...base, retryable: false, timedOut: false, exitCode: 1 };
    case "rate_limited":
      return { ...base, retryable: true, timedOut: false, exitCode: 1 };
    case "provider_auth":
      return { ...base, retryable: false, timedOut: false, exitCode: 1 };
    case "provider_temporary_error":
      return { ...base, retryable: true, timedOut: false, exitCode: 1 };
    case "empty_output":
      return { ...base, retryable: true, timedOut: false, exitCode: 0 };
    case "non_zero_exit":
    case "process_error":
    case "process_crash":
      return { ...base, retryable: false, timedOut: false, exitCode: 1 };
    default:
      return { ...base, retryable: false, timedOut: false, exitCode: 1 };
  }
}

export function createAntigravityAdapter(configuration) {
  const adapter = createAdapter("antigravity", {
    canRead: true,
    canWrite: true,
    supportsSandbox: true,
    supportsModelSelection: true
  });

  return {
    ...adapter,

    async healthCheck() {
      recoverStaleSettings();
      try {
        const { executable, execArgs } = resolveAntigravityCommand(configuration);
        const result = await runProcess(
          executable,
          [...execArgs, "--version"],
          { timeoutMs: 15000, maxOutputBytes: 65536, env: createProviderEnvironment("antigravity") }
        );
        return {
          installed: result.code === 0,
          version: result.stdout.trim() || result.stderr.trim() || null,
          authValid: result.code === 0,
          executable
        };
      } catch (error) {
        return {
          installed: false,
          version: null,
          authValid: false,
          executable: resolveAntigravityCommand(configuration).executable,
          error: error.message
        };
      }
    },

    async execute(request) {
      const startedAt = Date.now();
      recoverStaleSettings();
      const model = resolveModel(request.model);
      if (!model.valid) {
        return createFailureSubagentResult("antigravity", request.model, {
          error: model.error,
          durationMs: Date.now() - startedAt,
          retryable: false,
          exitCode: 1
        });
      }

        const timeoutMs = request.timeoutMs || configuration?.antigravity?.timeoutMs || 300000;
        const { executable, execArgs } = resolveAntigravityCommand(configuration);
        const sandbox = configuration?.antigravity?.defaultSandbox !== false;

      const isReadOnly = request.mode === "read_only";
      let readOnlyEnforcement = null;
      let releaseSettingsLock = null;
      let releaseSettingsFileLock = null;

      if (isReadOnly) {
        const mcpStatus = await runProcess(
          executable,
          [...execArgs, "mcp", "list"],
          { timeoutMs: 15000, maxOutputBytes: 65536, env: createProviderEnvironment("antigravity") }
        );
        if (!hasNoConfiguredMcpServers(mcpStatus)) {
          return createFailureSubagentResult("antigravity", model.model, {
            error: "read-only MCP isolation unavailable",
            retryable: false,
            exitCode: 1,
            durationMs: Date.now() - startedAt,
            reason: "read_only_mcp_isolation_unavailable"
          });
        }
        releaseSettingsLock = await acquireSettingsLock();
        releaseSettingsFileLock = await acquireSettingsFileLock();
        recoverStaleSettings(true);
        readOnlyEnforcement = enableReadOnlyEnforcement();
        if (!readOnlyEnforcement) {
          releaseSettingsFileLock();
          releaseSettingsFileLock = null;
          releaseSettingsLock();
          releaseSettingsLock = null;
          return createFailureSubagentResult("antigravity", model.model, {
            error: "read-only enforcement unavailable",
            retryable: false,
            exitCode: 1,
            durationMs: Date.now() - startedAt,
            reason: "read_only_enforcement_unavailable"
          });
        }
      }

      try {
        const args = [
          ...execArgs,
          "--output-format", "json",
          "--model", model.model,
          "--add-dir", request.workspace
        ];

        if (sandbox) {
          args.push("--sandbox");
        }

        args.push("--mode", isReadOnly ? "plan" : "accept-edits");

        const prompt = prependExecutionMetadata(
          isReadOnly ? `${READ_ONLY_INSTRUCTION}\n${request.prompt}` : request.prompt,
          { backend: "antigravity", requestedModel: request.model, resolvedModel: model.model, mode: request.mode }
        );

        args.push("--print");
        args.push(prompt);

        const handle = createExecutionHandle(request.executionId);
        activeExecutionHandles.set(request.executionId, handle);

        try {
          const processResult = await runProcess(
            executable,
            args,
            {
              cwd: request.workspace,
              timeoutMs,
              maxOutputBytes: configuration?.antigravity?.maxOutputBytes || 8388608,
              env: createProviderEnvironment("antigravity"),
              abortController: handle.abortController,
              onSpawn: (child) => handle.attachChild(child)
            }
          );

          activeExecutionHandles.delete(request.executionId);

          const classification = classifyAntigravityError(null, processResult.code, processResult.stdout, processResult.stderr);
          if (!classification.valid) {
            return mapCategoryToSubagentError(
              classification.errorClass, classification.reason,
              "antigravity", model.model,
              Date.now() - startedAt, 0
            );
          }

          const resultText = extractAntigravityResult(processResult.stdout);
          if (!resultText) {
            return mapCategoryToSubagentError(
              "empty_output", "provider returned an empty result",
              "antigravity", model.model,
              Date.now() - startedAt, 0
            );
          }

          return createSuccessSubagentResult("antigravity", model.model, {
            result: resultText,
            durationMs: Date.now() - startedAt
          });
        } catch (error) {
          activeExecutionHandles.delete(request.executionId);

          const aborted = error.name === "AbortError" || handle.abortController.signal.aborted;
          if (aborted) {
            return createFailureSubagentResult("antigravity", model.model, {
              error: "execution cancelled",
              retryable: false,
              timedOut: false,
              exitCode: null,
              durationMs: Date.now() - startedAt,
              reason: "cancelled"
            });
          }

          const isTimeout = /timed out|timeout/i.test(error.message || "");
          if (isTimeout) {
            return createFailureSubagentResult("antigravity", model.model, {
              error: "execution timed out",
              retryable: false,
              timedOut: true,
              exitCode: null,
              durationMs: Date.now() - startedAt
            });
          }

          const classification = classifyAntigravityError(error, null, "", "");
          return mapCategoryToSubagentError(
            classification.errorClass, classification.reason || error.message,
            "antigravity", model.model,
            Date.now() - startedAt, 0
          );
        }
      } finally {
        if (readOnlyEnforcement) {
          disableReadOnlyEnforcement(readOnlyEnforcement);
        }
        if (releaseSettingsLock) {
          releaseSettingsLock();
        }
        if (releaseSettingsFileLock) {
          releaseSettingsFileLock();
        }
      }
    },

    async cancel(executionId) {
      const handle = activeExecutionHandles.get(executionId);
      if (handle) {
        handle.cancel();
        activeExecutionHandles.delete(executionId);
      }
    }
  };
}

function resolveAntigravityCommand(configuration) {
  return {
    executable: configuration?.antigravity?.executable || "agy",
    execArgs: configuration?.antigravity?.execArgs || []
  };
}

export { ANTIGRAVITY_MODEL_MAP, READ_ONLY_INSTRUCTION, READ_ONLY_PERMISSION_RULES, hasSafeReadOnlyPermissionBaseline, hasNoConfiguredMcpServers, resolveModel, resolveAntigravityCommand, buildAntigravityArgs, classifyAntigravityError, extractAntigravityResult };
