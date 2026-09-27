import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  expectedMemoryHookProjectTarget,
  memoryHookCohortRegistryPath,
  memoryHookNamedCohorts,
  validateMemoryHookProjectInstallation
} from "../subagent-bridge/src/services/memory-hook-cohort.js";
import { withMetricLock } from "../subagent-bridge/src/metrics.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const bridgeHookPath = path.join(projectRoot, "subagent-bridge", "src", "services", "memory-hook-plugin.js");
const bridgeProviderPath = path.join(projectRoot, "subagent-bridge", "src", "services", "memory-hook.js");
const bridgeConfigPath = path.join(projectRoot, "subagent-bridge", "src", "config.js");
const bridgeMetricsPath = path.join(projectRoot, "subagent-bridge", "src", "metrics.js");
const bridgeCohortPath = path.join(projectRoot, "subagent-bridge", "src", "services", "memory-hook-cohort.js");
const clientScriptPath = path.join(projectRoot, "scripts", "memory-hook-client.js");
const maxExistingTargetBytes = 1048576;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const globalTarget = args.includes("--global");
const clientArgument = args.find((argument) => argument.startsWith("--client="));
const client = clientArgument ? clientArgument.slice("--client=".length) : "opencode";
const targetArgument = args.find((argument) => argument.startsWith("--target="));
const projectRootArgument = args.find((argument) => argument.startsWith("--project-root="));
const cohortArgument = args.find((argument) => argument.startsWith("--cohort="));
const requestedCohort = cohortArgument ? cohortArgument.slice("--cohort=".length) : undefined;
const explicitProjectRoot = projectRootArgument ? path.resolve(projectRootArgument.slice("--project-root=".length)) : null;
const opencodeDefaultProjectRoot = client === "opencode" && !globalTarget ? explicitProjectRoot || projectRoot : null;
const projectInstall = client === "opencode" ? !globalTarget : Boolean(explicitProjectRoot);
const registryPath = memoryHookCohortRegistryPath();

function quotePosix(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function quoteWindows(value) {
  const text = String(value);
  if (/[%\r\n"]/.test(text)) throw new Error("unsafe_command_path");
  return `"${text}"`;
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function selectedRuntimeCohort() {
  if (requestedCohort !== undefined) return requestedCohort;
  return projectInstall ? "unassigned" : undefined;
}

function expectedGlobalTarget(client) {
  if (client === "opencode") return path.join(os.homedir(), ".config", "opencode", "plugins", "second-brain-memory.js");
  if (client === "codex") return path.join(os.homedir(), ".codex", "hooks.json");
  if (client === "claude") return path.join(os.homedir(), ".claude", "settings.json");
  return null;
}

function openCodePluginSource(projectCohort) {
  const requestedCohortSource = projectCohort === undefined ? "undefined" : JSON.stringify(projectCohort);
  return [
    `import { createMemoryHook } from ${JSON.stringify(pathToFileURL(bridgeProviderPath).href)};`,
    `import { createSecondBrainMemoryPlugin } from ${JSON.stringify(pathToFileURL(bridgeHookPath).href)};`,
    `import { loadConfiguration } from ${JSON.stringify(pathToFileURL(bridgeConfigPath).href)};`,
    `import { recordMemoryHookSession } from ${JSON.stringify(pathToFileURL(bridgeMetricsPath).href)};`,
    `import { resolveOpenCodeProjectCohort } from ${JSON.stringify(pathToFileURL(bridgeCohortPath).href)};`,
    "",
    "async function logPluginStatus(client, level, message, sessionIdHash) {",
    "  const body = { service: \"second-brain-memory\", level, message };",
    "  if (typeof sessionIdHash === \"string\") body.extra = { sessionIdHash };",
    "  try { await client?.app?.log?.({ body }); } catch {}",
    "}",
    "",
    "export const SecondBrainMemoryPlugin = async ({ client, directory, worktree }) => {",
    '  const enabled = process.env.SUBAGENT_SECOND_BRAIN_HOOK === "1";',
    '  await logPluginStatus(client, enabled ? "info" : "warn", enabled ? "plugin_enabled" : "plugin_disabled");',
    "  if (!enabled) return {};",
    `  const projectCohort = resolveOpenCodeProjectCohort({ directory, worktree, requestedCohort: ${requestedCohortSource} }).projectCohort;`,
    "  return createSecondBrainMemoryPlugin({ runHook: createMemoryHook(), projectCohort, onDiagnostic: async ({ status, sessionIdHash }) => { await logPluginStatus(client, \"debug\", status, sessionIdHash); }, onContextInjected: async ({ sessionId, sessionIdHash, durationMs, projectCohort }) => {",
    '    try { const result = await recordMemoryHookSession(loadConfiguration(), { client: "opencode", sessionId, durationMs, projectCohort }); await logPluginStatus(client, "debug", result.recorded ? "session_metric_recorded" : result.conflict ? "session_attribution_conflict" : "session_metric_already_recorded", sessionIdHash); } catch { await logPluginStatus(client, "error", "session_metric_write_failed", sessionIdHash); }',
    "  } });",
    "};",
    ""
  ].join("\n");
}

function isShellSafePath(value) {
  const text = String(value);
  return text.length > 0 && !/[\s"'%]/.test(text);
}

function codexCommand(projectCohort) {
  if (process.platform === "win32") {
    for (const candidate of [process.execPath, clientScriptPath]) {
      if (!isShellSafePath(candidate)) throw new Error("unsafe_command_path");
    }
    const cohortSuffix = projectCohort === undefined ? "" : ` --cohort=${projectCohort}`;
    return `${process.execPath} ${clientScriptPath} --client=codex${cohortSuffix}`;
  }
  const cohortSuffix = projectCohort === undefined ? "" : ` --cohort=${projectCohort}`;
  return `${quotePosix(process.execPath)} ${quotePosix(clientScriptPath)} --client=codex${cohortSuffix}`;
}

function codexHookHandler(projectCohort) {
  const command = codexCommand(projectCohort);
  const commandWindows = process.platform === "win32" ? command : `${quoteWindows(process.execPath)} ${quoteWindows(clientScriptPath)} --client=codex${projectCohort === undefined ? "" : ` --cohort=${projectCohort}`}`;
  return {
    type: "command",
    command,
    commandWindows,
    additionalContextLimit: 1200,
    statusMessage: "Second brain memory (read-only)"
  };
}

function codexHookConfiguration(projectCohort) {
  return {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [codexHookHandler(projectCohort)]
        }
      ]
    }
  };
}

function claudeHookSnippet(projectCohort) {
  const args = [clientScriptPath, "--client=claude"];
  if (projectCohort !== undefined) args.push(`--cohort=${projectCohort}`);
  return {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: process.execPath,
              args
            }
          ]
        }
      ]
    }
  };
}

function safeTargetStatus(targetPath, projectPath) {
  if (!projectPath) return { valid: true };
  let canonicalProjectPath;
  try {
    canonicalProjectPath = fs.realpathSync.native(projectPath);
  } catch {
    return { valid: false, reason: "target_scope_invalid" };
  }
  const expectedPath = expectedMemoryHookProjectTarget(canonicalProjectPath, client);
  if (!expectedPath || normalizedPath(targetPath) !== normalizedPath(expectedPath)) return { valid: false, reason: "target_scope_invalid" };
  const relativeParent = path.relative(canonicalProjectPath, path.dirname(expectedPath));
  let current = canonicalProjectPath;
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const status = fs.lstatSync(current);
      if (!status.isDirectory() || status.isSymbolicLink()) return { valid: false, reason: "target_scope_invalid" };
    } catch (error) {
      if (error.code !== "ENOENT") return { valid: false, reason: "target_scope_invalid" };
      break;
    }
  }
  try {
    const status = fs.lstatSync(targetPath);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 || status.size > maxExistingTargetBytes) return { valid: false, reason: "target_unsafe" };
  } catch (error) {
    if (error.code !== "ENOENT") return { valid: false, reason: "target_unsafe" };
  }
  return { valid: true };
}

function codexHandlerIdentity(handler) {
  return isPlainObject(handler)
    && handler.type === "command"
    && typeof handler.command === "string"
    && typeof handler.commandWindows === "string"
    ? `${handler.command}\n${handler.commandWindows}\n${handler.additionalContextLimit}\n${handler.statusMessage}`
    : null;
}

function mergeCodexHookConfiguration(existing, addition) {
  if (!isPlainObject(existing) || !isPlainObject(existing.hooks)) return { ok: false, reason: "settings_shape_invalid" };
  const existingEvents = existing.hooks.UserPromptSubmit;
  if (existingEvents !== undefined && !Array.isArray(existingEvents)) return { ok: false, reason: "settings_shape_invalid" };
  const events = existingEvents || [];
  for (const group of events) {
    if (!isPlainObject(group) || !Array.isArray(group.hooks) || group.hooks.some((handler) => !isPlainObject(handler))) {
      return { ok: false, reason: "settings_shape_invalid" };
    }
  }
  const expected = addition.hooks.UserPromptSubmit[0].hooks[0];
  const expectedIdentity = codexHandlerIdentity(expected);
  if (events.some((group) => group.hooks.some((handler) => codexHandlerIdentity(handler) === expectedIdentity))) {
    return { ok: true, merged: existing, changed: false };
  }
  const merged = {
    ...existing,
    hooks: {
      ...existing.hooks,
      UserPromptSubmit: [...events, { hooks: [expected] }]
    }
  };
  return { ok: true, merged, changed: true };
}

function readSafeExistingTarget(targetPath) {
  try {
    const status = fs.lstatSync(targetPath);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 || status.size > maxExistingTargetBytes) {
      return { exists: true, safe: false, reason: "target_unsafe" };
    }
    return { exists: true, safe: true, contents: fs.readFileSync(targetPath, "utf8") };
  } catch (error) {
    return error.code === "ENOENT" ? { exists: false, safe: true, contents: null } : { exists: true, safe: false, reason: "target_unavailable" };
  }
}

function writeNewTarget(targetPath, contents) {
  let descriptor;
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    descriptor = fs.openSync(targetPath, "wx", 0o600);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
    return { written: true };
  } catch (error) {
    if (error.code === "EEXIST") return { written: false, reason: "target_changed" };
    return { written: false, reason: "target_write_failed" };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function replaceTargetIfUnchanged(targetPath, originalContents, updatedContents) {
  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, updatedContents, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const current = readSafeExistingTarget(targetPath);
    if (!current.exists || !current.safe || current.contents !== originalContents) {
      return { written: false, reason: "target_changed" };
    }
    fs.renameSync(temporaryPath, targetPath);
    return { written: true };
  } catch {
    return { written: false, reason: "target_write_failed" };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
    }
  }
}

async function updateTarget(addition) {
  const operation = async () => {
    const existing = readSafeExistingTarget(targetPath);
    if (!existing.safe) {
      result.reason = existing.reason;
      process.exitCode = 1;
      console.log(JSON.stringify(result, null, 2));
    } else if (client === "opencode" && existing.exists) {
      if (existing.contents !== addition) {
        result.reason = "existing_plugin_requires_manual_merge";
        process.exitCode = 1;
      } else {
        result.reason = "already_installed";
      }
      console.log(JSON.stringify(result, null, 2));
    } else if (client === "codex" && existing.exists) {
      let currentConfiguration;
      try {
        currentConfiguration = JSON.parse(existing.contents);
      } catch {
        currentConfiguration = null;
      }
      const merged = mergeCodexHookConfiguration(currentConfiguration, JSON.parse(addition));
      if (!merged.ok) {
        result.reason = merged.reason;
        process.exitCode = 1;
      } else if (!merged.changed) {
        result.reason = "already_installed";
      } else if (apply) {
        const written = replaceTargetIfUnchanged(targetPath, existing.contents, `${JSON.stringify(merged.merged, null, 2)}\n`);
        result.written = written.written;
        result.payloadRewritten = written.written;
        result.reason = written.reason || "merged";
        if (!written.written) process.exitCode = 1;
      } else {
        result.reason = "merge_available";
      }
      console.log(JSON.stringify(result, null, 2));
    } else {
      result.reason = apply ? "ready_to_write" : "dry_run_ready";
      if (apply) {
        const written = writeNewTarget(targetPath, addition);
        result.written = written.written;
        result.payloadRewritten = written.written;
        result.reason = written.reason || "written";
        if (!written.written) process.exitCode = 1;
      }
      console.log(JSON.stringify(result, null, 2));
      if (!apply && client === "codex") console.log(`\n${addition}`);
      if (!apply && client === "opencode") console.log(`\n${addition}`);
    }
  };
  if (!apply) return operation();
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    await withMetricLock(`${targetPath}.second-brain-install.lock`, operation, { timeoutMs: 5000, staleLockMs: 30000 });
  } catch {
    result.reason = "target_lock_unavailable";
    process.exitCode = 1;
    console.log(JSON.stringify(result, null, 2));
  }
}

function validateInstallation(targetPath) {
  if (!["opencode", "codex", "claude"].includes(client)) return { valid: false, reason: "unsupported_client" };
  if (globalTarget && explicitProjectRoot) return { valid: false, reason: "conflicting_scope" };
  if (requestedCohort !== undefined && ![...memoryHookNamedCohorts, "unassigned"].includes(requestedCohort)) {
    return { valid: false, reason: "invalid_cohort" };
  }
  if (globalTarget && memoryHookNamedCohorts.includes(requestedCohort)) return { valid: false, reason: "global_named_cohort_rejected" };
  if (memoryHookNamedCohorts.includes(requestedCohort) && !explicitProjectRoot) return { valid: false, reason: "project_root_required" };
  if (explicitProjectRoot && memoryHookNamedCohorts.includes(requestedCohort)) {
    const validation = validateMemoryHookProjectInstallation({
      projectRoot: explicitProjectRoot,
      cohort: requestedCohort,
      client,
      targetPath,
      registryPath
    });
    if (!validation.valid) return { valid: false, reason: validation.status === "matched" ? "target_scope_invalid" : validation.status };
  }
  if (!explicitProjectRoot && (client !== "opencode" || globalTarget)) {
    const expectedTargetPath = expectedGlobalTarget(client);
    if (!expectedTargetPath || normalizedPath(targetPath) !== normalizedPath(expectedTargetPath)) return { valid: false, reason: "target_scope_invalid" };
  }
  const targetCheck = safeTargetStatus(targetPath, explicitProjectRoot || opencodeDefaultProjectRoot);
  if (!targetCheck.valid) return targetCheck;
  if (explicitProjectRoot && !memoryHookNamedCohorts.includes(requestedCohort)) {
    const expectedTargetPath = expectedMemoryHookProjectTarget(explicitProjectRoot, client);
    if (!expectedTargetPath || normalizedPath(targetPath) !== normalizedPath(expectedTargetPath)) return { valid: false, reason: "target_scope_invalid" };
  }
  return { valid: true };
}

const runtimeCohort = selectedRuntimeCohort();
let targetPath;
try {
  if (targetArgument) targetPath = path.resolve(targetArgument.slice("--target=".length));
  else if (client === "claude" || client === "codex") targetPath = explicitProjectRoot
    ? expectedMemoryHookProjectTarget(explicitProjectRoot, client)
    : expectedGlobalTarget(client);
  else targetPath = globalTarget
    ? expectedGlobalTarget(client)
    : expectedMemoryHookProjectTarget(opencodeDefaultProjectRoot, client);
} catch {
  targetPath = null;
}

const result = {
  mode: apply ? "apply" : "dry_run",
  client,
  targetPath,
  commandQuoted: client === "codex" ? process.platform !== "win32" : null,
  projectScope: projectInstall,
  requestedProjectCohort: requestedCohort ?? null,
  runtimeCohort: runtimeCohort ?? "dynamic_registry_resolution",
  enabledByDefault: false,
  optInEnvironmentVariable: "SUBAGENT_SECOND_BRAIN_HOOK",
  readOnlySearchOnly: true,
  failClosedOnExistingTarget: true,
  payloadRewritten: false,
  written: false
};

if (!["opencode", "codex", "claude"].includes(client)) {
  result.reason = "unsupported_client";
  process.exitCode = 1;
  console.log(JSON.stringify(result, null, 2));
} else if (!targetPath) {
  result.reason = "target_scope_invalid";
  process.exitCode = 1;
  console.log(JSON.stringify(result, null, 2));
} else if (client === "claude") {
  const validation = validateInstallation(targetPath);
  result.mode = "snippet";
  result.manualMergeRequired = true;
  result.targetExpected = targetPath;
  result.reason = validation.valid ? "manual_merge_required" : validation.reason;
  if (!validation.valid) process.exitCode = 1;
  else result.snippet = claudeHookSnippet(runtimeCohort);
  console.log(JSON.stringify(result, null, 2));
} else {
  const validation = validateInstallation(targetPath);
  if (!validation.valid) {
    result.reason = validation.reason;
    process.exitCode = 1;
    console.log(JSON.stringify(result, null, 2));
  } else {
    let addition;
    try {
      addition = client === "opencode" ? openCodePluginSource(runtimeCohort) : JSON.stringify(codexHookConfiguration(runtimeCohort), null, 2) + "\n";
    } catch {
      result.reason = "unsafe_command_path";
      process.exitCode = 1;
      console.log(JSON.stringify(result, null, 2));
    }
    if (addition !== undefined) await updateTarget(addition);
  }
}
