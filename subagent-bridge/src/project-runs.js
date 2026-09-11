import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { validateWorkspace } from "./config.js";

const activeFileName = "runs.jsonl";
const lockFileName = "runs.jsonl.lock";
const maxActiveBytes = 5 * 1024 * 1024;
const maxRotatedFiles = 5;
const maxTotalBytes = 30 * 1024 * 1024;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const tokenSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const mirrorRecordSchema = z.object({
  recordedAt: z.string().datetime(),
  opaqueRunHash: hashSchema,
  profile: tokenSchema.nullable(),
  role: z.enum(["analyst", "researcher", "reviewer", "planner"]).nullable(),
  backend: z.enum(["antigravity", "claude_code", "codex", "deepseek", "glm", "kimi", "opencode", "qwen"]),
  mode: z.enum(["read_only", "edit", "not_applicable"]),
  outcomeStatus: z.enum(["completed", "failed"]),
  failureClass: tokenSchema.nullable(),
  durationMs: z.number().finite().nonnegative().nullable(),
  reportedCostUsd: z.number().finite().nonnegative().nullable(),
  cacheHit: z.boolean(),
  retries: z.number().int().nonnegative(),
  integrity: z.literal("untrusted_project_mirror")
}).strict();
const stateEntrySchema = z.object({
  enabledAt: z.string().datetime(),
  lastErrorClass: z.enum(["io_error", "lock_unavailable", "storage_limit", "unsafe_path"]).nullable(),
  lastErrorAt: z.string().datetime().nullable()
}).strict();
const stateSchema = z.object({
  version: z.literal(1),
  bindings: z.record(hashSchema, stateEntrySchema)
}).strict();
const lockSchema = z.object({
  token: z.string().uuid(),
  pid: z.number().int().positive(),
  createdAt: z.string().datetime()
}).strict();

function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isPathInside(candidatePath, rootPath) {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function resolveWorkspace(configuration, workspace) {
  const validated = validateWorkspace(workspace, configuration.allowedRoots, configuration.deepseek?.deniedRootPaths || []);
  const canonical = fs.realpathSync(validated);
  const status = fs.lstatSync(canonical, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink() || status.ino <= 0n || status.dev < 0n) throw new Error("unsafe workspace identity");
  const binding = hashValue(`${canonical}\0${status.dev}\0${status.ino}\0${status.birthtimeMs}`);
  return { canonical, binding };
}

function requireSafeDirectory(directoryPath, rootPath) {
  const status = fs.lstatSync(directoryPath);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("unsafe project mirror directory");
  const realPath = fs.realpathSync(directoryPath);
  if (!isPathInside(realPath, rootPath)) throw new Error("project mirror directory escapes workspace");
  return realPath;
}

function resolveHadesDirectory(workspace, create = false) {
  const hadesPath = path.join(workspace, ".hades");
  if (!fs.existsSync(hadesPath)) {
    if (!create) return null;
    fs.mkdirSync(hadesPath);
  }
  return requireSafeDirectory(hadesPath, workspace);
}

function requireSafeFile(directory, filePath) {
  const status = fs.lstatSync(filePath);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) throw new Error("unsafe project mirror file");
  const realPath = fs.realpathSync(filePath);
  if (!isPathInside(realPath, directory)) throw new Error("project mirror file escapes workspace");
  return { realPath, status };
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function readSafeLock(lockPath) {
  try {
    const status = fs.lstatSync(lockPath);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) return null;
    return lockSchema.parse(JSON.parse(fs.readFileSync(lockPath, "utf8")));
  } catch {
    return null;
  }
}

async function withFileLock(lockPath, callback) {
  const owner = { token: crypto.randomUUID(), pid: process.pid, createdAt: new Date().toISOString() };
  const deadline = Date.now() + 5000;
  let descriptor = null;
  while (descriptor === null) {
    try {
      descriptor = fs.openSync(lockPath, "wx");
      fs.writeFileSync(descriptor, JSON.stringify(owner), "utf8");
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (descriptor !== null) fs.closeSync(descriptor);
      descriptor = null;
      const lockContended = error.code === "EEXIST" || (error.code === "EPERM" && fs.existsSync(lockPath));
      if (!lockContended && error.code === "EPERM") {
        if (Date.now() >= deadline) throw new Error("project mirror lock unavailable");
        await pause(10);
        continue;
      }
      if (!lockContended) throw error;
      const first = readSafeLock(lockPath);
      await pause(10);
      const second = readSafeLock(lockPath);
      if (first && second && first.token === second.token && !processIsAlive(second.pid)) {
        try {
          if (readSafeLock(lockPath)?.token === second.token) fs.rmSync(lockPath);
        } catch {
        }
      }
      if (Date.now() >= deadline) throw new Error("project mirror lock unavailable");
      await pause(10);
    }
  }
  try {
    return await callback();
  } finally {
    fs.closeSync(descriptor);
    try {
      if (readSafeLock(lockPath)?.token === owner.token) fs.rmSync(lockPath);
    } catch {
    }
  }
}

function statePaths(configuration) {
  return {
    directory: configuration.statePaths.state,
    statePath: path.join(configuration.statePaths.state, "project-run-mirrors.json"),
    lockPath: path.join(configuration.statePaths.state, "project-run-mirrors.lock")
  };
}

function ensureStateDirectory(configuration) {
  const { directory } = statePaths(configuration);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  const status = fs.lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("unsafe project mirror state directory");
}

function readState(configuration) {
  const { statePath } = statePaths(configuration);
  if (!fs.existsSync(statePath)) return { version: 1, bindings: {} };
  const directory = fs.realpathSync(path.dirname(statePath));
  const { realPath } = requireSafeFile(directory, statePath);
  return stateSchema.parse(JSON.parse(fs.readFileSync(realPath, "utf8")));
}

function writeState(configuration, state) {
  const parsed = stateSchema.parse(state);
  const { directory, statePath } = statePaths(configuration);
  if (fs.existsSync(statePath)) requireSafeFile(fs.realpathSync(directory), statePath);
  const temporaryPath = path.join(directory, `.project-run-mirrors-${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporaryPath, "wx");
  try {
    fs.writeFileSync(descriptor, JSON.stringify(parsed), "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporaryPath, statePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

async function mutateState(configuration, callback) {
  ensureStateDirectory(configuration);
  const { lockPath } = statePaths(configuration);
  return withFileLock(lockPath, async () => {
    const state = readState(configuration);
    const result = await callback(state);
    writeState(configuration, state);
    return result;
  });
}

function ensureGitIgnore(workspace) {
  const ignorePath = path.join(workspace, ".gitignore");
  if (fs.existsSync(ignorePath)) {
    const { realPath } = requireSafeFile(workspace, ignorePath);
    const content = fs.readFileSync(realPath, "utf8");
    if (content.split(/\r?\n/).some((line) => [".hades/", "/.hades/"].includes(line.trim()))) return false;
    fs.appendFileSync(realPath, `${content.length > 0 && !content.endsWith("\n") ? "\n" : ""}.hades/\n`, "utf8");
    return true;
  }
  const descriptor = fs.openSync(ignorePath, "wx");
  try {
    fs.writeFileSync(descriptor, ".hades/\n", "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return true;
}

export function isGitWorkspace(workspace) {
  return fs.existsSync(path.join(workspace, ".git"));
}

export async function enableProjectMirror(configuration, workspace, approval = {}) {
  const resolved = resolveWorkspace(configuration, workspace);
  const gitWorkspace = isGitWorkspace(resolved.canonical);
  if (gitWorkspace && approval.gitIgnore !== true) throw new Error("git ignore approval is required");
  if (!gitWorkspace && approval.nonGitWrite !== true) throw new Error("non-git workspace write approval is required");
  if (gitWorkspace) ensureGitIgnore(resolved.canonical);
  resolveHadesDirectory(resolved.canonical, true);
  return mutateState(configuration, (state) => {
    if (!state.bindings[resolved.binding] && Object.keys(state.bindings).length >= 1000) throw new Error("project mirror binding limit reached");
    state.bindings[resolved.binding] = {
      enabledAt: new Date().toISOString(),
      lastErrorClass: null,
      lastErrorAt: null
    };
    return { enabled: true, gitIgnored: gitWorkspace };
  });
}

export async function disableProjectMirror(configuration, workspace) {
  const resolved = resolveWorkspace(configuration, workspace);
  return mutateState(configuration, (state) => {
    const existed = Boolean(state.bindings[resolved.binding]);
    delete state.bindings[resolved.binding];
    return { enabled: false, changed: existed };
  });
}

function rotatedFiles(hadesDirectory) {
  const files = [];
  for (const entry of fs.readdirSync(hadesDirectory)) {
    if (!/^runs-[0-9TZ-]+-[a-f0-9-]{36}\.jsonl$/.test(entry)) continue;
    const filePath = path.join(hadesDirectory, entry);
    const safe = requireSafeFile(hadesDirectory, filePath);
    files.push({ filePath: safe.realPath, size: safe.status.size, mtimeMs: safe.status.mtimeMs });
  }
  return files.sort((left, right) => left.mtimeMs - right.mtimeMs);
}

function cleanupForRotation(hadesDirectory, activeSize) {
  const files = rotatedFiles(hadesDirectory);
  let totalRotatedBytes = files.reduce((total, file) => total + file.size, 0);
  while (files.length >= maxRotatedFiles || totalRotatedBytes + activeSize > maxTotalBytes - maxActiveBytes) {
    const oldest = files.shift();
    if (!oldest) throw new Error("project mirror storage limit unavailable");
    requireSafeFile(hadesDirectory, oldest.filePath);
    fs.rmSync(oldest.filePath);
    totalRotatedBytes -= oldest.size;
  }
}

function appendMirrorRecord(hadesDirectory, record) {
  const activePath = path.join(hadesDirectory, activeFileName);
  const serialized = `${JSON.stringify(mirrorRecordSchema.parse(record))}\n`;
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes > maxActiveBytes) throw new Error("project mirror storage limit unavailable");
  let activeExists = fs.existsSync(activePath);
  let activeSize = 0;
  if (activeExists) activeSize = requireSafeFile(hadesDirectory, activePath).status.size;
  if (activeSize > 0 && activeSize + serializedBytes > maxActiveBytes) {
    cleanupForRotation(hadesDirectory, activeSize);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rotatedPath = path.join(hadesDirectory, `runs-${timestamp}-${crypto.randomUUID()}.jsonl`);
    if (fs.existsSync(rotatedPath)) throw new Error("unsafe project mirror rotation target");
    fs.renameSync(activePath, rotatedPath);
    activeExists = false;
    activeSize = 0;
  }
  const descriptor = fs.openSync(activePath, activeExists ? "a" : "wx");
  try {
    const status = fs.fstatSync(descriptor);
    if (!status.isFile() || status.nlink !== 1) throw new Error("unsafe project mirror file");
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function mirrorRecord(metric) {
  return mirrorRecordSchema.parse({
    recordedAt: metric.recordedAt,
    opaqueRunHash: metric.executionIdHash,
    profile: metric.profile || null,
    role: metric.role || null,
    backend: metric.backend,
    mode: metric.mode || "not_applicable",
    outcomeStatus: metric.outcomeStatus,
    failureClass: metric.failureClass || null,
    durationMs: Number.isFinite(metric.usage?.durationMs) ? metric.usage.durationMs : null,
    reportedCostUsd: Number.isFinite(metric.usage?.totalCostUsd) ? metric.usage.totalCostUsd : null,
    cacheHit: metric.cacheHit === true,
    retries: Number.isInteger(metric.retries) ? metric.retries : Math.max(0, (metric.attempts?.length || 1) - 1),
    integrity: "untrusted_project_mirror"
  });
}

function classifyMirrorError(error) {
  if (/lock unavailable/.test(error.message)) return "lock_unavailable";
  if (/storage limit/.test(error.message)) return "storage_limit";
  if (/unsafe|escapes/.test(error.message)) return "unsafe_path";
  return "io_error";
}

async function updateLastError(configuration, binding, errorClass) {
  try {
    await mutateState(configuration, (state) => {
      const entry = state.bindings[binding];
      if (entry) {
        entry.lastErrorClass = errorClass;
        entry.lastErrorAt = new Date().toISOString();
      }
    });
  } catch {
  }
}

export async function appendProjectMirrorMetric(configuration, workspace, metric) {
  let resolved;
  try {
    resolved = resolveWorkspace(configuration, workspace);
    const state = readState(configuration);
    if (!state.bindings[resolved.binding]) return { written: false, reason: "disabled" };
    const hadesDirectory = resolveHadesDirectory(resolved.canonical, false);
    if (!hadesDirectory) throw new Error("unsafe project mirror directory");
    await withFileLock(path.join(hadesDirectory, lockFileName), async () => {
      requireSafeDirectory(hadesDirectory, resolved.canonical);
      appendMirrorRecord(hadesDirectory, mirrorRecord(metric));
    });
    return { written: true };
  } catch (error) {
    const errorClass = classifyMirrorError(error);
    if (resolved) await updateLastError(configuration, resolved.binding, errorClass);
    return { written: false, reason: errorClass };
  }
}

export function getProjectMirrorStatus(configuration, workspace) {
  const resolved = resolveWorkspace(configuration, workspace);
  const state = readState(configuration);
  const entry = state.bindings[resolved.binding] || null;
  const hadesDirectory = resolveHadesDirectory(resolved.canonical, false);
  let activeBytes = 0;
  let rotatedCount = 0;
  if (hadesDirectory) {
    const activePath = path.join(hadesDirectory, activeFileName);
    if (fs.existsSync(activePath)) activeBytes = requireSafeFile(hadesDirectory, activePath).status.size;
    rotatedCount = rotatedFiles(hadesDirectory).length;
  }
  return {
    enabled: Boolean(entry),
    activeBytes,
    rotatedCount,
    lastErrorClass: entry?.lastErrorClass || null,
    lastErrorAt: entry?.lastErrorAt || null
  };
}

export function readProjectMirror(configuration, workspace, options = {}) {
  const resolved = resolveWorkspace(configuration, workspace);
  const hadesDirectory = resolveHadesDirectory(resolved.canonical, false);
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be an integer between 1 and 200");
  if (!hadesDirectory) return { scope: "structural_metadata_only", integrity: "untrusted_project_mirror", runCount: 0, runs: [], invalidRecordCount: 0 };
  const candidates = rotatedFiles(hadesDirectory);
  const activePath = path.join(hadesDirectory, activeFileName);
  if (fs.existsSync(activePath)) {
    const active = requireSafeFile(hadesDirectory, activePath);
    candidates.push({ filePath: active.realPath, size: active.status.size, mtimeMs: active.status.mtimeMs });
  }
  const records = [];
  let invalidRecordCount = 0;
  for (const candidate of candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)) {
    if (candidate.size > maxActiveBytes) continue;
    for (const line of fs.readFileSync(candidate.filePath, "utf8").split("\n")) {
      if (!line) continue;
      try {
        records.push(mirrorRecordSchema.parse(JSON.parse(line)));
      } catch {
        invalidRecordCount += 1;
      }
    }
  }
  const runs = records.sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt)).slice(0, limit);
  return { scope: "structural_metadata_only", integrity: "untrusted_project_mirror", runCount: runs.length, runs, invalidRecordCount };
}

export async function clearProjectMirror(configuration, workspace, confirmed = false) {
  if (!confirmed) throw new Error("clear requires --confirm");
  const resolved = resolveWorkspace(configuration, workspace);
  const hadesDirectory = resolveHadesDirectory(resolved.canonical, false);
  if (!hadesDirectory) return { cleared: 0, enabled: Boolean(readState(configuration).bindings[resolved.binding]) };
  return withFileLock(path.join(hadesDirectory, lockFileName), async () => {
    let cleared = 0;
    for (const entry of fs.readdirSync(hadesDirectory)) {
      if (entry !== activeFileName && !/^runs-[0-9TZ-]+-[a-f0-9-]{36}\.jsonl$/.test(entry) && !/^\.runs-[a-f0-9-]{36}\.tmp$/.test(entry)) continue;
      const filePath = path.join(hadesDirectory, entry);
      requireSafeFile(hadesDirectory, filePath);
      fs.rmSync(filePath);
      cleared += 1;
    }
    return { cleared, enabled: Boolean(readState(configuration).bindings[resolved.binding]) };
  });
}
