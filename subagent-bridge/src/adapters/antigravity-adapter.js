import { createProviderEnvironment, runProcess, createExecutionHandle, killProcessTree } from "../services/execution-service.js";
import { createAdapter } from "./agent-adapter-base.js";
import { createFailureSubagentResult, createSuccessSubagentResult, capabilityFailureClassValues, operatingSystemErrorCodeValues } from "../schemas/core-schemas.js";
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

const READ_ONLY_PROBE_HINT = " If read-only failures repeat, run check_antigravity_subagent with probeCapabilities (modelAccess, webRead) before retrying.";

const READ_ONLY_INSTRUCTION = `
=== READ-ONLY MODE ===
You MUST NOT create, modify, or delete any files in the workspace.
You MUST NOT execute any commands that change the filesystem state.
You may only read, analyze, and report on existing files.
Use only built-in workspace read tools to inspect files.
Do not call MCP, terminal commands, or built-in write tools.
If asked to write or modify files, decline and explain that you are in read-only mode.
`;

const WEB_EVIDENCE_OUTPUT_INSTRUCTION = `
For public web research, use the read_url_content tool. Its permission action is read_url(domain). For every read-only response, return exactly one JSON object shaped as {"result":"...","webEvidence":null}. When read_url_content was not used, keep webEvidence null or omit it. When read_url_content was used, webEvidence must be an object shaped as {"sourceUrl":"the exact fetched page URL","excerpts":["short URL-free text from that page"],"confidence":"low","verificationStatus":"unverified"}. Keep the worker result as a string; never put the worker's fields beside result. Never put URLs or citation links inside result or excerpts; put the fetched URL only in webEvidence.sourceUrl. Keep excerpts free of URLs, headers, cookies, and credentials. Do not put URLs, headers, cookies, credentials, or tool, model, permission, fallback, or edit fields in result or excerpts.
`;

const READ_ONLY_PERMISSION_RULES = {
  allow: [
    "read_url(*)"
  ],
  deny: [
    "command(*)",
    "unsandboxed(*)",
    "write_file(*)",
    "mcp(*)",
    "execute_url(*)"
  ]
};

const CARRIER_OUTPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    result: { type: "string", minLength: 1 },
    webEvidence: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            sourceUrl: { type: "string", minLength: 1 },
            retrievedAt: { type: "string", format: "date-time" },
            excerpts: { type: "array", items: { type: "string", minLength: 1, maxLength: 500 }, minItems: 1, maxItems: 5 },
            confidence: { type: "string", enum: ["low"] },
            verificationStatus: { type: "string", enum: ["unverified"] }
          },
          required: ["sourceUrl", "excerpts"],
          additionalProperties: false
        }
      ]
    }
  },
  required: ["result"],
  additionalProperties: false
});

function writeCarrierSchemaFile(writeFileSync = fs.writeFileSync) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-carrier-schema-"));
  try {
    const schemaPath = path.join(directory, "carrier-schema.json");
    writeFileSync(schemaPath, CARRIER_OUTPUT_SCHEMA, "utf8");
    return { schemaPath, directory };
  } catch (error) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
    }
    throw error;
  }
}

function removeCarrierSchemaFile(handle) {
  if (!handle) return;
  try {
    fs.rmSync(handle.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
  }
}

function normalizeCarrierEvidence(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value).length === 0 ? null : value;
  }
  return value;
}

function parseNestedCarrierText(text) {
  if (typeof text !== "string" || !text.includes("{")) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (Object.keys(parsed).some((key) => key !== "result" && key !== "webEvidence")) return null;
  if (typeof parsed.result !== "string" || parsed.result.trim().length === 0) return null;
  return parsed;
}

function normalizeCarrierStructuredOutput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.result !== "string" || value.result.trim().length === 0) return null;
  let resultText = value.result;
  let evidenceValue = value.webEvidence;
  for (let depth = 0; depth < 2; depth += 1) {
    const nested = parseNestedCarrierText(resultText);
    if (!nested) break;
    resultText = nested.result;
    if (evidenceValue === undefined || evidenceValue === null) evidenceValue = nested.webEvidence;
  }
  return JSON.stringify({ result: resultText, webEvidence: normalizeCarrierEvidence(evidenceValue) });
}

const activeExecutionHandles = new Map();

const AGY_SETTINGS_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli");
const AGY_SETTINGS_PATH = path.join(AGY_SETTINGS_DIR, "settings.json");
const AGY_SETTINGS_SENTINEL = path.join(os.tmpdir(), "agy-bridge-readonly-sentinel");
const AGY_SETTINGS_LOCK_PATH = path.join(AGY_SETTINGS_DIR, "settings.lock");
export function createSettingsLock() {
  let settingsMutex = Promise.resolve();
  return async function acquireSettingsLock(deadlineMs = Infinity) {
    let release;
    const previous = settingsMutex;
    const current = new Promise((resolve) => { release = resolve; });
    settingsMutex = previous.then(() => current);
    let timeoutHandle;
    try {
      if (Number.isFinite(deadlineMs)) {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) throw createSettingsLockTimeoutError();
        await Promise.race([
          previous,
          new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(createSettingsLockTimeoutError()), remainingMs);
          })
        ]);
      } else {
        await previous;
      }
      return release;
    } catch (error) {
      release();
      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
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

function createSettingsLockTimeoutError() {
  return Object.assign(new Error("read-only settings lock unavailable before request timeout"), {
    code: "SETTINGS_LOCK_TIMEOUT"
  });
}

async function acquireSettingsFileLock(deadlineMs) {
  const ownerId = crypto.randomUUID();
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
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) throw createSettingsLockTimeoutError();
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, remainingMs)));
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
  if (!Array.isArray(allow)) return true;
  const deniedActions = new Set(READ_ONLY_PERMISSION_RULES.deny.map((rule) => rule.slice(0, rule.indexOf("("))));
  return allow.every((rule) => {
    if (typeof rule !== "string") return false;
    const match = /^([a-z_]+)\(([^\r\n\0]+)\)$/u.exec(rule);
    return Boolean(match && (match[1] === "read_url" || deniedActions.has(match[1])));
  });
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
    settings.allowNonWorkspaceAccess = false;
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
      }
      fs.writeFileSync(AGY_SETTINGS_PATH, JSON.stringify(settings, null, 2));
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
    "--output-format", request.webReadTrace === true && request.mode === "read_only" ? "stream-json" : "json",
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

function classifyAntigravityError(error, exitCode, stdout, stderr, signal = null) {
  const errorMessage = error ? String(error.message || error).toLocaleLowerCase("en-US") : "";
  const output = `${stderr || ""} ${exitCode !== 0 ? stdout || "" : ""}`.toLocaleLowerCase("en-US");
  const combinedFailureText = `${errorMessage} ${output}`;

  if (/sandbox (?:setup|startup|initiali[sz]ation|helper)|failed to (?:start|initialize|initiali[sz]e).*sandbox|kernel (?:refresh|reset|initiali[sz]ation)/i.test(combinedFailureText)) {
    return { valid: false, errorClass: "sandbox_setup", providerCode: "process_error", reason: "Windows sandbox setup failed" };
  }

  if (/workspace (?:read|access) (?:failed|denied)|failed to read (?:the )?(?:workspace|file)|could not read (?:the )?(?:workspace|file)/i.test(combinedFailureText)) {
    return { valid: false, errorClass: "workspace_read", providerCode: "permission_denied", reason: "workspace read failed" };
  }

  if (error?.failureClass === "prompt_transport_limit" || ["E2BIG", "ENAMETOOLONG"].includes(error?.code)) {
    return { valid: false, errorClass: "prompt_transport_limit", providerCode: "prompt_transport_limit", reason: "prompt transport limit exceeded" };
  }

  if (/timed out|timeout|zaman aşımı/i.test(errorMessage)) {
    return { valid: false, errorClass: "timeout", providerCode: "timeout", reason: "execution timed out" };
  }

  if (/output limit|bytes/i.test(errorMessage)) {
    return { valid: false, errorClass: "output_limit", providerCode: "output_limit", reason: "output exceeded limit" };
  }

  if (error?.code === "ENOENT" || /executable not found|enoent|command not found|does not exist/i.test(errorMessage)) {
    return { valid: false, errorClass: "executable_missing", providerCode: "executable_missing", reason: "antigravity executable not found" };
  }

  if (/permission denied|permission_denied|tool required the ["'].*["'] permission|headless mode cannot prompt|auto-denied/i.test(errorMessage + output)) {
    if (/headless mode cannot prompt/i.test(errorMessage + output)) {
      return { valid: false, errorClass: "permission_denied", providerCode: "permission_denied", reason: "headless mode cannot prompt" };
    }
    if (/tool required the ["'].*["'] permission|auto-denied/i.test(errorMessage + output)) {
      return { valid: false, errorClass: "permission_denied", providerCode: "permission_denied", reason: "tool permission denied" };
    }
    return { valid: false, errorClass: "permission_denied", providerCode: "permission_denied", reason: "permission denied" };
  }

  if (/rate[ _-]?limit|429|quota exceeded|resource[ _-]?exhausted/i.test(errorMessage + output)) {
    const providerCode = /resource[ _-]?exhausted/i.test(errorMessage + output) ? "resource_exhausted" : "rate_limited";
    return { valid: false, errorClass: "rate_limited", providerCode, reason: "provider rate limited" };
  }

  if (/unauthorized|auth|authentication|invalid.*token|api[._]key|\b401\b/i.test(errorMessage + output)) {
    return { valid: false, errorClass: "authentication_failure", providerCode: "unauthenticated", reason: "authentication failure" };
  }

  if (/\b5\d\d\b|unavailable|service unavailable|internal server error|bad gateway|gateway timeout/i.test(errorMessage + output)) {
    const providerCode = /\bbad gateway\b|\b502\b/i.test(errorMessage + output)
      ? "bad_gateway"
      : /\bgateway timeout\b|\b504\b/i.test(errorMessage + output)
        ? "gateway_timeout"
        : /\binternal server error\b|\b500\b/i.test(errorMessage + output)
          ? "internal_error"
          : "unavailable";
    return { valid: false, errorClass: "server", providerCode, reason: "provider service unavailable" };
  }

  if (/econn|enotfound|eai_again|socket|network|fetch failed|connection reset/i.test(errorMessage + output)) {
    const providerCode = /econnreset|connection reset/i.test(errorMessage + output)
      ? "connection_reset"
      : /enotfound|eai_again|\bdns\b/i.test(errorMessage + output)
        ? "dns_failure"
        : /fetch failed/i.test(errorMessage + output)
          ? "fetch_failed"
          : "network_error";
    return { valid: false, errorClass: "network", providerCode, reason: "provider network failure" };
  }

  if (signal) {
    return { valid: false, errorClass: "process_exit", providerCode: "process_exit", reason: "provider process terminated unexpectedly" };
  }

  if (exitCode !== null && exitCode !== 0) {
    return { valid: false, errorClass: "process_exit", providerCode: "process_exit", reason: `process exited with code ${exitCode}` };
  }

  if (error) {
    return { valid: false, errorClass: "process_error", providerCode: "process_error", reason: "antigravity process failed" };
  }

  return { valid: true, providerCode: null };
}

function createAttemptDiagnostics(failureStage, providerCode = null, timings = {}) {
  return {
    failureStage: failureStage || null,
    providerCode: providerCode || null,
    ...(operatingSystemErrorCodeValues.includes(timings.osErrorCode) ? { osErrorCode: timings.osErrorCode } : {}),
    ...(timings.webEvidenceFailureCode ? { webEvidenceFailureCode: timings.webEvidenceFailureCode } : {}),
    settingsLockWaitMs: Number.isInteger(timings.settingsLockWaitMs) ? timings.settingsLockWaitMs : null,
    providerExecutionMs: Number.isInteger(timings.providerExecutionMs) ? timings.providerExecutionMs : null,
    stdoutBytes: Number.isInteger(timings.stdoutBytes) ? timings.stdoutBytes : null,
    stderrBytes: Number.isInteger(timings.stderrBytes) ? timings.stderrBytes : null
  };
}

function failureStageForClassification(errorClass, fallback = "provider_execution") {
  if (["sandbox_setup", "workspace_read", "provider_auth", "provider_rate_limit", "provider_process_exit", "evidence_invalid", "cancelled"].includes(errorClass)) return errorClass;
  if (errorClass === "authentication_failure" || errorClass === "auth_invalid") return "provider_auth";
  if (errorClass === "rate_limited") return "provider_rate_limit";
  if (errorClass === "process_exit") return "provider_process_exit";
  if (errorClass === "prompt_transport_limit" || errorClass === "executable_missing") return "process_spawn";
  return fallback;
}

function extractAntigravityResult(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && Object.hasOwn(parsed, "structured_output")) {
      return normalizeCarrierStructuredOutput(parsed.structured_output);
    }
    if (typeof parsed?.response === "string") {
      return parsed.response.trim() || null;
    }
    return JSON.stringify(parsed);
  } catch {
    return trimmed;
  }
}

function readUrlErrorIsPermissionDenied(error) {
  const errorText = typeof error === "string"
    ? error
    : [error?.type, error?.message].filter((value) => typeof value === "string").join(" ");
  return /permission denied|permission_denied|tool required the ["']read_url["'] permission|headless mode cannot prompt|auto-denied/i.test(errorText);
}

function isReadUrlToolName(value) {
  return value === "read_url" || value === "read_url_content";
}

export function extractAntigravityStreamTrace(stdout, stderr = "") {
  let terminalResult = null;
  let readUrlToolAvailable = null;
  let readUrlObserved = false;
  let readUrlSucceeded = false;
  let readUrlPermissionDenied = false;
  let readUrlFailed = false;
  const lines = String(stdout || "").split(/\r?\n/u).filter((line) => line.trim().length > 0);
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.event === "init" && Array.isArray(event.init?.tools)) {
      readUrlToolAvailable = event.init.tools.some(isReadUrlToolName);
    }
    if (event?.event === "result" && event.result && typeof event.result === "object") {
      terminalResult = event.result;
      continue;
    }
    if (event?.event !== "step_update" || event.step_update?.step_type !== "tool") continue;
    const step = event.step_update;
    if (!isReadUrlToolName(step.tool_name || step.tool_info?.name) || step.state !== "DONE") continue;
    readUrlObserved = true;
    const toolError = step.tool_info?.error;
    if (toolError) {
      if (readUrlErrorIsPermissionDenied(toolError)) readUrlPermissionDenied = true;
      else readUrlFailed = true;
    } else {
      readUrlSucceeded = true;
    }
  }
  if (/(?:read_url_content|\bread_url\b)/i.test(String(stderr)) && /soft[- ]denied|permission denied|permission_denied|requires? approval|approval required|cannot prompt|auto-denied/i.test(String(stderr))) {
    readUrlPermissionDenied = true;
  }
  const webReadStatus = readUrlSucceeded
    ? "used"
      : readUrlPermissionDenied
        ? "permission_denied"
        : readUrlObserved && readUrlFailed
          ? "failed"
          : readUrlToolAvailable === false
            ? "unavailable"
            : readUrlToolAvailable === true
              ? "not_invoked"
              : "not_observed";
  return {
    resultText: terminalResult ? extractAntigravityResult(JSON.stringify(terminalResult)) : null,
    webReadStatus
  };
}

function mapCategoryToSubagentError(errorClass, error, backend, model, durationMs, retries, exitCode = null, signal = null, diagnostics = null) {
  const base = {
    ok: false,
    backend,
    model,
    result: null,
    error,
    reason: errorClass,
    durationMs,
    metrics: { retries, signal, ...(diagnostics ? { diagnostics } : {}) }
  };

  switch (errorClass) {
    case "timeout":
      return { ...base, retryable: false, timedOut: true, exitCode: null };
    case "output_limit":
      return { ...base, retryable: false, timedOut: false, exitCode };
    case "executable_missing":
      return { ...base, retryable: false, timedOut: false, exitCode: null };
    case "permission_denied":
    case "policy_violation":
      return { ...base, retryable: false, timedOut: false, exitCode };
    case "rate_limited":
      return { ...base, retryable: true, timedOut: false, exitCode };
    case "authentication_failure":
      return { ...base, retryable: false, timedOut: false, exitCode };
    case "server":
    case "network":
      return { ...base, retryable: true, timedOut: false, exitCode };
    case "empty_output":
      return { ...base, retryable: true, timedOut: false, exitCode: 0 };
    case "process_exit":
    case "process_error":
      return { ...base, retryable: false, timedOut: false, exitCode };
    default:
      return { ...base, retryable: false, timedOut: false, exitCode };
  }
}

const PROBE_CAPABILITIES = ["modelAccess", "toolFreeResponse", "workspaceRead", "webRead", "sandboxStartup"];
const DEFAULT_PROBE_TIMEOUT_MS = 300000;
const WEB_READ_PROBE_URL = "https://example.com";
const WEB_READ_PROBE_MARKER = /example domain/i;

function classifyProbeFailure(errorClass) {
  return capabilityFailureClassValues.includes(errorClass) ? errorClass : "unclassified";
}

function probeFailureStatus(failureClass) {
  return failureClass === "permission_denied" || failureClass === "policy_violation" ? "not_probed" : "unavailable";
}

function runCapabilityProbeProcess(executable, execArgs, { workspace, model, prompt, timeoutMs }) {
  return runProcess(executable, [
    ...execArgs,
    "--output-format", "json",
    "--model", model,
    "--add-dir", workspace,
    "--sandbox",
    "--mode", "plan",
    "--print",
    `${READ_ONLY_INSTRUCTION}\n${prompt}`
  ], {
    cwd: workspace,
    timeoutMs,
    maxOutputBytes: 262144,
    env: createProviderEnvironment("antigravity")
  });
}

function probeResponse(processResult) {
  const classification = classifyAntigravityError(null, processResult.code, processResult.stdout, processResult.stderr, processResult.signal);
  if (!classification.valid) return { failureClass: classifyProbeFailure(classification.errorClass), text: "" };
  return { failureClass: null, text: extractAntigravityResult(processResult.stdout) || "" };
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

    async healthCheck(options = {}) {
      if (options.recoverStaleSettings !== false) recoverStaleSettings();
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
          authValid: null,
          executable,
          probes: {
            cli: result.code === 0 ? "available" : "unavailable",
            modelAccess: "not_probed",
            toolFreeResponse: "not_probed",
            workspaceRead: "not_probed",
            sandboxStartup: "not_probed",
            webRead: "not_probed"
          }
        };
      } catch (error) {
        return {
          installed: false,
          version: null,
          authValid: null,
          executable: resolveAntigravityCommand(configuration).executable,
          probes: {
            cli: "unavailable",
            modelAccess: "not_probed",
            toolFreeResponse: "not_probed",
            workspaceRead: "not_probed",
            sandboxStartup: "not_probed",
            webRead: "not_probed"
          },
          error: error.message
        };
      }
    },

    async probeCapabilities({ model, capabilities, timeoutMs, workspaceReadTarget = "temp_workspace", trustedWorkspace } = {}) {
      const requested = Array.isArray(capabilities) ? PROBE_CAPABILITIES.filter((capability) => capabilities.includes(capability)) : [];
      const normalizedWorkspaceReadTarget = workspaceReadTarget === "trusted_workspace" ? "trusted_workspace" : "temp_workspace";
      const result = {
        modelAccess: "not_probed",
        toolFreeResponse: "not_probed",
        workspaceRead: "not_probed",
        sandboxStartup: "not_probed",
        workspaceReadTarget: requested.includes("workspaceRead") ? normalizedWorkspaceReadTarget : null,
        webRead: "not_probed",
        failureClass: null,
        checkedAt: new Date().toISOString()
      };
      const recordFailure = (failureClass) => {
        if (result.failureClass === null) result.failureClass = failureClass;
      };
      const resolved = resolveModel(model);
      if (!resolved.valid) {
        for (const capability of requested) result[capability] = "unavailable";
        recordFailure("invalid_model");
        return result;
      }
      if (requested.length === 0) return result;
      const { executable, execArgs } = resolveAntigravityCommand(configuration);
      const probeTimeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : (configuration?.antigravity?.probeTimeoutMs || DEFAULT_PROBE_TIMEOUT_MS);
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-capability-probe-"));
      let trustedProbeWorkspace = null;
      const runProbe = async (prompt, probeWorkspace = workspace) => probeResponse(await runCapabilityProbeProcess(executable, execArgs, { workspace: probeWorkspace, model: resolved.model, prompt, timeoutMs: probeTimeoutMs }));
      const applyOutcome = (capability, outcome, expected) => {
        if (outcome.failureClass) {
          const status = probeFailureStatus(outcome.failureClass);
          result[capability] = status;
            recordFailure(outcome.failureClass);
          return;
        }
        if (expected) {
          result[capability] = "available";
          return;
        }
        result[capability] = "unavailable";
        recordFailure(capability === "sandboxStartup" ? "sandbox_setup" : capability === "workspaceRead" ? "workspace_read" : "unclassified");
      };
      try {
        if (requested.includes("modelAccess") || requested.includes("toolFreeResponse") || requested.includes("sandboxStartup")) {
          const outcome = await runProbe("Reply with exactly READY and nothing else.");
          for (const capability of ["modelAccess", "toolFreeResponse"]) {
            if (!requested.includes(capability)) continue;
            applyOutcome(capability, outcome, outcome.text.includes("READY"));
          }
          if (requested.includes("sandboxStartup") && outcome.failureClass === "sandbox_setup") {
            result.sandboxStartup = "unavailable";
            recordFailure("sandbox_setup");
          }
        }
        if (requested.includes("workspaceRead")) {
          const marker = `PROBE-${crypto.randomUUID()}`;
          let probeWorkspace = workspace;
          if (normalizedWorkspaceReadTarget === "trusted_workspace") {
            if (typeof trustedWorkspace !== "string" || !path.isAbsolute(trustedWorkspace)) {
              result.workspaceRead = "unavailable";
              recordFailure("policy_violation");
            } else {
              try {
                const trustedRoot = fs.realpathSync(trustedWorkspace);
                trustedProbeWorkspace = fs.mkdtempSync(path.join(trustedRoot, ".bridge-read-probe-"));
                probeWorkspace = trustedProbeWorkspace;
              } catch {
                result.workspaceRead = "unavailable";
                recordFailure("workspace_read");
              }
            }
          }
          if (result.workspaceRead === "not_probed") {
            const markerPath = path.join(probeWorkspace, "probe.txt");
            fs.writeFileSync(markerPath, marker, { encoding: "utf8", flag: "wx", mode: 384 });
            const outcome = await runProbe(`Read the file ${markerPath} and reply with its exact contents and nothing else.`, probeWorkspace);
            const failureClass = outcome.failureClass === "permission_denied"
              ? "workspace_read"
              : outcome.failureClass;
            if (failureClass) {
              result.workspaceRead = probeFailureStatus(failureClass);
              recordFailure(failureClass);
            } else {
              applyOutcome("workspaceRead", outcome, outcome.text.includes(marker));
            }
          }
        }
        if (requested.includes("webRead")) {
          const outcome = await runProbe(`Use the read_url_content tool to fetch ${WEB_READ_PROBE_URL} and reply with the page heading and nothing else. The required permission action is read_url.`);
          applyOutcome("webRead", outcome, WEB_READ_PROBE_MARKER.test(outcome.text));
        }
      } catch (error) {
        const classification = classifyAntigravityError(error, null, "", "");
        const failureClass = classifyProbeFailure(classification.errorClass);
        const status = probeFailureStatus(failureClass);
        recordFailure(failureClass);
        for (const capability of requested) {
          if (result[capability] === "not_probed") result[capability] = status;
        }
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        if (trustedProbeWorkspace) fs.rmSync(trustedProbeWorkspace, { recursive: true, force: true });
      }
      return result;
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
          exitCode: 1,
          reason: "invalid_model",
          metrics: { diagnostics: createAttemptDiagnostics("mcp_preflight", "invalid_model") }
        });
      }

      const timeoutMs = request.timeoutMs || configuration?.antigravity?.timeoutMs || 300000;
      const requestDeadlineMs = startedAt + timeoutMs;
      const { executable, execArgs } = resolveAntigravityCommand(configuration);
      const sandbox = configuration?.antigravity?.defaultSandbox !== false;

      const isReadOnly = request.mode === "read_only";
      const webReadTrace = isReadOnly && request.webReadTrace === true;
      let readOnlyEnforcement = null;
      let carrierSchemaHandle = null;
      let releaseSettingsLock = null;
      let releaseSettingsFileLock = null;
      let settingsLockWaitMs = null;
      let settingsLockStartedAt = null;
      let providerExecutionMs = null;
      let providerStartedAt = null;
      let readOnlyStage = "mcp_preflight";

      if (isReadOnly) {
        try {
          const mcpTimeoutMs = Math.min(15000, requestDeadlineMs - Date.now());
          if (mcpTimeoutMs <= 0) throw createSettingsLockTimeoutError();
          const mcpStatus = await runProcess(
            executable,
            [...execArgs, "mcp", "list"],
            { timeoutMs: mcpTimeoutMs, maxOutputBytes: 65536, env: createProviderEnvironment("antigravity") }
          );
          if (!hasNoConfiguredMcpServers(mcpStatus)) {
            return createFailureSubagentResult("antigravity", model.model, {
              error: "read-only MCP isolation unavailable",
              retryable: false,
              exitCode: 1,
              durationMs: Date.now() - startedAt,
              reason: "read_only_mcp_isolation_unavailable",
              metrics: { diagnostics: createAttemptDiagnostics("mcp_preflight") }
            });
          }
          readOnlyStage = "settings_lock";
          settingsLockStartedAt = Date.now();
          releaseSettingsLock = await acquireSettingsLock(requestDeadlineMs);
          releaseSettingsFileLock = await acquireSettingsFileLock(requestDeadlineMs);
          settingsLockWaitMs = Date.now() - settingsLockStartedAt;
          readOnlyStage = "settings_enforcement";
          recoverStaleSettings(true);
          carrierSchemaHandle = writeCarrierSchemaFile();
          readOnlyEnforcement = enableReadOnlyEnforcement();
          if (!readOnlyEnforcement) {
            removeCarrierSchemaFile(carrierSchemaHandle);
            carrierSchemaHandle = null;
            releaseSettingsFileLock();
            releaseSettingsFileLock = null;
            releaseSettingsLock();
            releaseSettingsLock = null;
            return createFailureSubagentResult("antigravity", model.model, {
              error: "read-only enforcement unavailable",
              retryable: false,
              exitCode: 1,
              durationMs: Date.now() - startedAt,
              reason: "read_only_enforcement_unavailable",
              metrics: { diagnostics: createAttemptDiagnostics("settings_enforcement", null, { settingsLockWaitMs }) }
            });
          }
        } catch (error) {
          if (releaseSettingsFileLock) releaseSettingsFileLock();
          if (releaseSettingsLock) releaseSettingsLock();
          if (settingsLockWaitMs === null && settingsLockStartedAt !== null) settingsLockWaitMs = Date.now() - settingsLockStartedAt;
          const settingsLockTimedOut = error?.code === "SETTINGS_LOCK_TIMEOUT";
          if (settingsLockTimedOut || /timed out|timeout/i.test(error.message || "")) {
            return createFailureSubagentResult("antigravity", model.model, {
              error: `execution timed out${isReadOnly ? READ_ONLY_PROBE_HINT : ""}`,
              retryable: false,
              timedOut: true,
              exitCode: null,
              durationMs: Date.now() - startedAt,
              reason: "timeout",
              metrics: { diagnostics: createAttemptDiagnostics(readOnlyStage, "timeout", { settingsLockWaitMs }) }
            });
          }
          const classification = classifyAntigravityError(error, null, "", "");
          return mapCategoryToSubagentError(
            classification.errorClass, classification.reason || error.message,
            "antigravity", model.model,
            Date.now() - startedAt, 0, null, null,
            createAttemptDiagnostics(readOnlyStage === "mcp_preflight" ? failureStageForClassification(classification.errorClass, readOnlyStage) : readOnlyStage, classification.providerCode, { settingsLockWaitMs, osErrorCode: error?.code })
          );
        }
      }

      try {
        const args = [
          ...execArgs,
          "--output-format", webReadTrace ? "stream-json" : "json",
          "--model", model.model,
          "--add-dir", request.workspace
        ];

        if (sandbox) {
          args.push("--sandbox");
        }

        if (isReadOnly && carrierSchemaHandle) {
          args.push("--json-schema", carrierSchemaHandle.schemaPath);
        }

        args.push("--mode", isReadOnly ? "plan" : "accept-edits");

        const prompt = prependExecutionMetadata(
          isReadOnly ? `${READ_ONLY_INSTRUCTION}\n${WEB_EVIDENCE_OUTPUT_INSTRUCTION}\n${request.prompt}` : request.prompt,
          { backend: "antigravity", requestedModel: request.model, resolvedModel: model.model, mode: request.mode }
        );

        args.push("--print");
        args.push(prompt);

        const handle = createExecutionHandle(request.executionId);
        activeExecutionHandles.set(request.executionId, handle);

        try {
          const providerTimeoutMs = isReadOnly ? requestDeadlineMs - Date.now() : timeoutMs;
          if (providerTimeoutMs <= 0) throw createSettingsLockTimeoutError();
          providerStartedAt = Date.now();
          const processResult = await runProcess(
            executable,
            args,
            {
              cwd: request.workspace,
              timeoutMs: providerTimeoutMs,
              maxOutputBytes: request.maxOutputBytes || configuration?.antigravity?.maxOutputBytes || 8388608,
              env: createProviderEnvironment("antigravity"),
              abortController: handle.abortController,
              onSpawn: (child) => handle.attachChild(child)
            }
          );
          providerExecutionMs = Date.now() - providerStartedAt;

          activeExecutionHandles.delete(request.executionId);

          const classification = classifyAntigravityError(null, processResult.code, processResult.stdout, processResult.stderr, processResult.signal);
          if (!classification.valid) {
            const failure = mapCategoryToSubagentError(
              classification.errorClass, classification.reason,
              "antigravity", model.model,
              Date.now() - startedAt, 0, processResult.code, processResult.signal,
              createAttemptDiagnostics(failureStageForClassification(classification.errorClass), classification.providerCode, {
                settingsLockWaitMs,
                providerExecutionMs,
                stdoutBytes: Buffer.byteLength(processResult.stdout, "utf8"),
                stderrBytes: Buffer.byteLength(processResult.stderr, "utf8")
              })
            );
            if (webReadTrace) failure.metrics.webReadStatus = classification.errorClass === "permission_denied" ? "permission_denied" : "failed";
            return failure;
          }

          const streamTrace = webReadTrace ? extractAntigravityStreamTrace(processResult.stdout, processResult.stderr) : null;
          const webReadStatus = streamTrace?.webReadStatus;
          if (webReadStatus === "permission_denied") {
            const failure = mapCategoryToSubagentError(
              "permission_denied", "read_url tool permission denied",
              "antigravity", model.model,
              Date.now() - startedAt, 0, processResult.code, processResult.signal,
              createAttemptDiagnostics("provider_execution", "permission_denied", {
                settingsLockWaitMs,
                providerExecutionMs,
                stdoutBytes: Buffer.byteLength(processResult.stdout, "utf8"),
                stderrBytes: Buffer.byteLength(processResult.stderr, "utf8")
              })
            );
            failure.metrics.webReadStatus = webReadStatus;
            return failure;
          }
          if (webReadStatus === "failed") {
            const failure = mapCategoryToSubagentError(
              "process_error", "read_url tool failed",
              "antigravity", model.model,
              Date.now() - startedAt, 0, processResult.code, processResult.signal,
              createAttemptDiagnostics("provider_execution", "process_error", {
                settingsLockWaitMs,
                providerExecutionMs,
                stdoutBytes: Buffer.byteLength(processResult.stdout, "utf8"),
                stderrBytes: Buffer.byteLength(processResult.stderr, "utf8")
              })
            );
            failure.metrics.webReadStatus = webReadStatus;
            return failure;
          }

          const resultText = webReadTrace ? streamTrace.resultText : extractAntigravityResult(processResult.stdout);
          if (!resultText) {
            const failure = mapCategoryToSubagentError(
              "empty_output", "provider returned an empty result",
              "antigravity", model.model,
              Date.now() - startedAt, 0, 0, null,
              createAttemptDiagnostics("result_parse", "empty_output", {
                settingsLockWaitMs,
                providerExecutionMs,
                stdoutBytes: Buffer.byteLength(processResult.stdout, "utf8"),
                stderrBytes: Buffer.byteLength(processResult.stderr, "utf8")
              })
            );
            if (webReadTrace) failure.metrics.webReadStatus = webReadStatus || "not_observed";
            return failure;
          }

          return createSuccessSubagentResult("antigravity", model.model, {
            result: resultText,
            durationMs: Date.now() - startedAt,
            metrics: {
              ...(webReadTrace ? { webReadStatus: webReadStatus || "not_observed" } : {}),
              diagnostics: createAttemptDiagnostics(null, null, {
                settingsLockWaitMs,
                providerExecutionMs,
                stdoutBytes: Buffer.byteLength(processResult.stdout, "utf8"),
                stderrBytes: Buffer.byteLength(processResult.stderr, "utf8")
              })
            }
          });
        } catch (error) {
          activeExecutionHandles.delete(request.executionId);
          if (providerExecutionMs === null && providerStartedAt !== null) providerExecutionMs = Date.now() - providerStartedAt;

          const aborted = error.name === "AbortError" || handle.abortController.signal.aborted;
          if (aborted) {
            return createFailureSubagentResult("antigravity", model.model, {
              error: "execution cancelled",
              retryable: false,
              timedOut: false,
              exitCode: null,
              durationMs: Date.now() - startedAt,
              reason: "cancelled",
              metrics: { diagnostics: createAttemptDiagnostics("provider_execution", null, { settingsLockWaitMs, providerExecutionMs }) }
            });
          }

          const isTimeout = /timed out|timeout/i.test(error.message || "");
          if (isTimeout) {
            const streamTrace = webReadTrace ? extractAntigravityStreamTrace(error.stdout, error.stderr) : null;
            if (streamTrace?.webReadStatus === "permission_denied") {
              const failure = createFailureSubagentResult("antigravity", model.model, {
                error: "read_url tool permission denied",
                retryable: false,
                timedOut: false,
                exitCode: null,
                durationMs: Date.now() - startedAt,
                reason: "permission_denied",
                metrics: { webReadStatus: "permission_denied", diagnostics: createAttemptDiagnostics("provider_execution", "permission_denied", {
                  settingsLockWaitMs,
                  providerExecutionMs,
                  stdoutBytes: Buffer.byteLength(error.stdout || "", "utf8"),
                  stderrBytes: Buffer.byteLength(error.stderr || "", "utf8")
                }) }
              });
              return failure;
            }
            return createFailureSubagentResult("antigravity", model.model, {
              error: `execution timed out${isReadOnly ? READ_ONLY_PROBE_HINT : ""}`,
              retryable: false,
              timedOut: true,
              exitCode: null,
              durationMs: Date.now() - startedAt,
              reason: "timeout",
              metrics: {
                ...(webReadTrace ? { webReadStatus: streamTrace?.webReadStatus || "not_observed" } : {}),
                diagnostics: createAttemptDiagnostics("provider_execution", "timeout", {
                  settingsLockWaitMs,
                  providerExecutionMs,
                  stdoutBytes: Buffer.byteLength(error.stdout || "", "utf8"),
                  stderrBytes: Buffer.byteLength(error.stderr || "", "utf8")
                })
              }
            });
          }

          const classification = classifyAntigravityError(error, null, "", "");
          return mapCategoryToSubagentError(
            classification.errorClass, classification.reason || error.message,
            "antigravity", model.model,
            Date.now() - startedAt, 0, null, null,
            createAttemptDiagnostics(failureStageForClassification(classification.errorClass), classification.providerCode, {
              settingsLockWaitMs,
              providerExecutionMs,
              stdoutBytes: Buffer.byteLength(error.stdout || "", "utf8"),
              stderrBytes: Buffer.byteLength(error.stderr || "", "utf8"),
              osErrorCode: error?.code
            })
          );
        }
      } finally {
        if (readOnlyEnforcement) {
          disableReadOnlyEnforcement(readOnlyEnforcement);
        }
        removeCarrierSchemaFile(carrierSchemaHandle);
        if (releaseSettingsFileLock) {
          releaseSettingsFileLock();
        }
        if (releaseSettingsLock) {
          releaseSettingsLock();
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

export { ANTIGRAVITY_MODEL_MAP, READ_ONLY_INSTRUCTION, READ_ONLY_PROBE_HINT, WEB_EVIDENCE_OUTPUT_INSTRUCTION, READ_ONLY_PERMISSION_RULES, CARRIER_OUTPUT_SCHEMA, hasSafeReadOnlyPermissionBaseline, hasNoConfiguredMcpServers, resolveModel, resolveAntigravityCommand, buildAntigravityArgs, classifyAntigravityError, extractAntigravityResult, normalizeCarrierStructuredOutput, writeCarrierSchemaFile };
