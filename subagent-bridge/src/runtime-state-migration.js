import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyRuntimeStateSchemaVersion, isCompatibleClassifiedVersion, runtimeStateSchemaVersion } from "./version-contract.js";

export const runtimeStateMigrationId = "state-layout-v0-to-v1";

function migrationDirectory(stateRoot) {
  return path.join(stateRoot, "migrations");
}

function manifestPath(stateRoot) {
  return path.join(migrationDirectory(stateRoot), `${runtimeStateMigrationId}.json`);
}

function lockPath(stateRoot) {
  return path.join(migrationDirectory(stateRoot), `${runtimeStateMigrationId}.lock`);
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function readManifest(stateRoot) {
  const filePath = manifestPath(stateRoot);
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "absent", manifest: null };
    return { status: "error", manifest: null };
  }
  if (stats.isSymbolicLink()) return { status: "symlink", manifest: null };
  if (!stats.isFile()) return { status: "invalid", manifest: null };
  try {
    const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (manifest?.migrationId !== runtimeStateMigrationId) return { status: "invalid", manifest: null };
    const classification = classifyRuntimeStateSchemaVersion(manifest.toVersion);
    if (classification.status === "future_incompatible") return { status: "future_incompatible", manifest: null };
    if (classification.status !== "current") return { status: "invalid", manifest: null };
    return { status: "current", manifest };
  } catch {
    return { status: "invalid", manifest: null };
  }
}

function withMigrationLock(stateRoot, callback) {
  const lockFile = lockPath(stateRoot);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const owner = { token: crypto.randomUUID(), pid: process.pid };
  const deadline = Date.now() + 5000;
  let descriptor = null;
  while (descriptor === null) {
    try {
      descriptor = fs.openSync(lockFile, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > 30000) fs.rmSync(lockFile, { force: true });
      } catch {
      }
      if (Date.now() >= deadline) throw new Error("state migration lock unavailable");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  fs.writeFileSync(descriptor, JSON.stringify(owner), "utf8");
  fs.fsyncSync(descriptor);
  try {
    return callback();
  } finally {
    fs.closeSync(descriptor);
    try {
      const current = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      if (current?.token === owner.token) fs.rmSync(lockFile, { force: true });
    } catch {
    }
  }
}

function readCheckpointEntries(stateRoot) {
  const checkpointDirectory = path.join(stateRoot, "checkpoints");
  let stats;
  try {
    stats = fs.lstatSync(checkpointDirectory);
  } catch (error) {
    if (error.code === "ENOENT") return { entries: [], error: false };
    return { entries: [], error: true };
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return { entries: [], error: true };
  try {
    return { entries: fs.readdirSync(checkpointDirectory).filter((entry) => entry.endsWith(".json")), error: false };
  } catch {
    return { entries: [], error: true };
  }
}

function countLegacyStateArtifacts(stateRoot) {
  const { entries, error } = readCheckpointEntries(stateRoot);
  return { count: entries.length, error };
}

const runIdHashPattern = /^[a-f0-9]{64}$/;
const checkpointAllowedKeys = [
  "runIdHash",
  "agent",
  "role",
  "model",
  "requestedModel",
  "resolvedModel",
  "accessMode",
  "exitCode",
  "completedAt",
  "failureClass",
  "attempts",
  "usage",
  "result"
];
const checkpointStringKeys = ["agent", "role", "model", "requestedModel", "resolvedModel", "accessMode", "completedAt", "failureClass"];
const checkpointAttemptAllowedKeys = [
  "number",
  "failureClass",
  "failureStage",
  "providerCode",
  "exitCode",
  "signal",
  "retryDecision",
  "retryStopReason",
  "settingsLockWaitMs",
  "providerExecutionMs",
  "stdoutBucket",
  "stderrBucket",
  "durationMs",
  "apiDurationMs",
  "turns",
  "retryDelayMs",
  "totalCostUsd"
];
const checkpointUsageAllowedKeys = ["durationMs", "apiDurationMs", "turns", "totalCostUsd"];
const checkpointResultAllowedKeys = ["status", "requires_human_approval"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function checkpointRedactionHash(checkpoint, entry) {
  const candidate = typeof checkpoint.runIdHash === "string" ? checkpoint.runIdHash : "";
  if (runIdHashPattern.test(candidate)) return candidate;
  return hashValue(typeof checkpoint.runId === "string" && checkpoint.runId.length > 0 ? checkpoint.runId : entry);
}

function checkpointRequiresRedaction(checkpoint, entry) {
  if (!isPlainObject(checkpoint)) return true;
  if (typeof checkpoint.runId === "string" && checkpoint.runId.length > 0) return true;
  if (Object.keys(checkpoint).some((key) => !checkpointAllowedKeys.includes(key))) return true;
  if (!runIdHashPattern.test(checkpoint.runIdHash)) return true;
  if (entry !== `${checkpoint.runIdHash}.json`) return true;
  for (const key of checkpointStringKeys) {
    const value = checkpoint[key];
    if (value !== undefined && value !== null && typeof value !== "string") return true;
  }
  if (checkpoint.exitCode !== undefined && checkpoint.exitCode !== null && !Number.isInteger(checkpoint.exitCode)) return true;
  if (checkpoint.attempts !== undefined) {
    if (!Array.isArray(checkpoint.attempts)) return true;
    for (const attempt of checkpoint.attempts) {
      if (!isPlainObject(attempt)) return true;
      if (Object.keys(attempt).some((key) => !checkpointAttemptAllowedKeys.includes(key))) return true;
      if (Object.values(attempt).some((value) => !isScalar(value))) return true;
    }
  }
  if (checkpoint.usage !== undefined) {
    if (!isPlainObject(checkpoint.usage)) return true;
    if (Object.keys(checkpoint.usage).some((key) => !checkpointUsageAllowedKeys.includes(key))) return true;
    if (Object.values(checkpoint.usage).some((value) => !isScalar(value))) return true;
  }
  const result = checkpoint.result;
  if (!isPlainObject(result)) return true;
  const resultKeys = Object.keys(result);
  if (resultKeys.some((key) => !checkpointResultAllowedKeys.includes(key))) return true;
  if (resultKeys.length !== checkpointResultAllowedKeys.length) return true;
  if (typeof result.status !== "string") return true;
  if (typeof result.requires_human_approval !== "boolean") return true;
  return false;
}

function sanitizeAttempts(attempts) {
  if (!Array.isArray(attempts)) return undefined;
  const sanitized = [];
  for (const attempt of attempts) {
    if (!isPlainObject(attempt)) continue;
    const output = {};
    for (const key of checkpointAttemptAllowedKeys) {
      if (key in attempt && isScalar(attempt[key])) output[key] = attempt[key];
    }
    sanitized.push(output);
  }
  return sanitized;
}

function sanitizeUsage(usage) {
  if (!isPlainObject(usage)) return undefined;
  const output = {};
  for (const key of checkpointUsageAllowedKeys) {
    if (key in usage && isScalar(usage[key])) output[key] = usage[key];
  }
  return output;
}

function sanitizeString(value) {
  return typeof value === "string" ? value : undefined;
}

function sanitizeInteger(value) {
  return Number.isInteger(value) ? value : undefined;
}

function buildRedactedCheckpoint(checkpoint, runIdHash) {
  return {
    runIdHash,
    agent: sanitizeString(checkpoint.agent),
    role: sanitizeString(checkpoint.role),
    model: sanitizeString(checkpoint.model),
    requestedModel: sanitizeString(checkpoint.requestedModel),
    resolvedModel: sanitizeString(checkpoint.resolvedModel),
    accessMode: sanitizeString(checkpoint.accessMode),
    exitCode: sanitizeInteger(checkpoint.exitCode),
    completedAt: sanitizeString(checkpoint.completedAt),
    failureClass: sanitizeString(checkpoint.failureClass),
    attempts: sanitizeAttempts(checkpoint.attempts),
    usage: sanitizeUsage(checkpoint.usage),
    result: {
      status: typeof checkpoint.result?.status === "string" ? checkpoint.result.status : "failed",
      requires_human_approval: checkpoint.result?.requires_human_approval === true
    }
  };
}

function inspectLegacyCheckpoints(stateRoot) {
  const { entries, error } = readCheckpointEntries(stateRoot);
  if (error) return { scanned: 0, redactionCount: 0, error: true };
  const checkpointDirectory = path.join(stateRoot, "checkpoints");
  let redactionCount = 0;
  for (const entry of entries) {
    const checkpointPath = path.join(checkpointDirectory, entry);
    let stats;
    try {
      stats = fs.lstatSync(checkpointPath);
    } catch {
      return { scanned: entries.length, redactionCount, error: true };
    }
    if (stats.isSymbolicLink() || !stats.isFile()) return { scanned: entries.length, redactionCount, error: true };
    let checkpoint;
    try {
      checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    } catch {
      return { scanned: entries.length, redactionCount, error: true };
    }
    if (checkpointRequiresRedaction(checkpoint, entry)) redactionCount += 1;
  }
  return { scanned: entries.length, redactionCount, error: false };
}

function writeFileAtomically(targetPath, contents) {
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporaryPath, "wx");
  try {
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, targetPath);
  fsyncDirectory(path.dirname(targetPath));
}

export function redactLegacyCheckpoints(stateRoot) {
  const { entries, error } = readCheckpointEntries(stateRoot);
  if (error) throw new Error("checkpoint directory unreadable");
  const checkpointDirectory = path.resolve(stateRoot, "checkpoints");
  let redactedCount = 0;
  for (const entry of entries) {
    const checkpointPath = path.join(checkpointDirectory, entry);
    const stats = fs.lstatSync(checkpointPath);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("unsafe checkpoint entry");
    let checkpoint;
    try {
      checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    } catch {
      throw new Error("unreadable checkpoint entry");
    }
    if (!checkpointRequiresRedaction(checkpoint, entry)) continue;
    const runIdHash = checkpointRedactionHash(checkpoint, entry);
    if (!runIdHashPattern.test(runIdHash)) throw new Error("unsafe checkpoint identifier");
    const redactedPath = path.resolve(checkpointDirectory, `${runIdHash}.json`);
    if (path.dirname(redactedPath) !== checkpointDirectory) throw new Error("unsafe checkpoint target");
    try {
      if (fs.lstatSync(redactedPath).isSymbolicLink()) throw new Error("unsafe checkpoint target");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    writeFileAtomically(redactedPath, JSON.stringify(buildRedactedCheckpoint(checkpoint, runIdHash), null, 2));
    if (redactedPath !== checkpointPath) {
      fs.rmSync(checkpointPath, { force: true });
      fsyncDirectory(checkpointDirectory);
    }
    redactedCount += 1;
  }
  return { redactedCount };
}

const windowsDirectoryOpenCodes = ["EISDIR", "EPERM", "EACCES", "UNKNOWN", "EINVAL"];

export function fsyncDirectory(directoryPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(directoryPath, "r");
  } catch (error) {
    if (process.platform === "win32" && windowsDirectoryOpenCodes.includes(error.code)) return;
    throw error;
  }
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    const unsupportedOnWindows = process.platform === "win32" && error.code === "EPERM";
    if (!["EINVAL", "ENOTSUP"].includes(error.code) && !unsupportedOnWindows) throw error;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function planRuntimeStateMigration({ stateRoot, now = new Date() }) {
  const manifest = readManifest(stateRoot);
  const stateRootExists = fs.existsSync(stateRoot);
  const requiresManifest = manifest.status === "absent";
  const artifactScan = stateRootExists ? countLegacyStateArtifacts(stateRoot) : { count: 0, error: false };
  const checkpointScan = stateRootExists
    ? inspectLegacyCheckpoints(stateRoot)
    : { scanned: 0, redactionCount: 0, error: false };
  const failClosed = manifest.status === "symlink"
    || manifest.status === "invalid"
    || manifest.status === "future_incompatible"
    || manifest.status === "error"
    || artifactScan.error
    || checkpointScan.error;
  const actions = failClosed
    ? []
    : [
      ...(checkpointScan.redactionCount > 0 ? ["redact_legacy_checkpoints"] : []),
      ...(requiresManifest ? ["write_version_manifest"] : [])
    ];
  return {
    migrationId: runtimeStateMigrationId,
    fromVersion: 0,
    toVersion: runtimeStateSchemaVersion,
    mode: "dry_run",
    stateRootExists,
    manifestStatus: manifest.status,
    failClosed,
    compatible: !failClosed && isCompatibleClassifiedVersion(classifyRuntimeStateSchemaVersion(manifest.manifest?.toVersion ?? null)),
    legacyArtifactCount: artifactScan.count,
    checkpointRedactionCount: checkpointScan.redactionCount,
    payloadRewritten: checkpointScan.redactionCount > 0,
    actions,
    plannedAt: now.toISOString()
  };
}

export function applyRuntimeStateMigration({ stateRoot, now = new Date() }) {
  fs.mkdirSync(stateRoot, { recursive: true });
  return withMigrationLock(stateRoot, () => {
    const plan = planRuntimeStateMigration({ stateRoot, now });
    if (plan.failClosed) return { ...plan, mode: "apply", applied: false, reason: "fail_closed" };
    if (plan.actions.length === 0) return { ...plan, mode: "apply", applied: false, reason: "already_current" };
    const preconditionHash = hashValue(`${plan.manifestStatus}:${plan.legacyArtifactCount}:${plan.checkpointRedactionCount}`);
    let redactedCheckpointCount = 0;
    if (plan.checkpointRedactionCount > 0) {
      try {
        redactedCheckpointCount = redactLegacyCheckpoints(stateRoot).redactedCount;
      } catch {
        return { ...plan, mode: "apply", applied: false, reason: "redaction_failed" };
      }
    }
    const writesManifest = plan.actions.includes("write_version_manifest");
    let manifest = null;
    if (writesManifest) {
      manifest = {
        migrationId: runtimeStateMigrationId,
        fromVersion: 0,
        toVersion: runtimeStateSchemaVersion,
        status: "applied",
        mode: "apply",
        payloadRewritten: redactedCheckpointCount > 0,
        legacyArtifactCount: plan.legacyArtifactCount,
        checkpointRedactionCount: redactedCheckpointCount,
        preconditionHash,
        resultHash: hashValue(`${preconditionHash}:applied:${redactedCheckpointCount}`),
        startedAt: plan.plannedAt,
        completedAt: new Date().toISOString()
      };
      writeFileAtomically(manifestPath(stateRoot), JSON.stringify(manifest));
    }
    return {
      migrationId: runtimeStateMigrationId,
      fromVersion: 0,
      toVersion: runtimeStateSchemaVersion,
      mode: "apply",
      stateRootExists: true,
      manifestStatus: writesManifest ? "current" : plan.manifestStatus,
      failClosed: false,
      compatible: true,
      legacyArtifactCount: plan.legacyArtifactCount,
      checkpointRedactionCount: redactedCheckpointCount,
      payloadRewritten: redactedCheckpointCount > 0,
      actions: plan.actions,
      applied: true,
      manifest
    };
  });
}
