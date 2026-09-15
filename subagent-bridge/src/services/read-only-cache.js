import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const fingerprintLimits = Object.freeze({
  maxEntries: 512,
  maxFileBytes: 1048576,
  maxTotalBytes: 8388608,
  maxStagedBytes: 262144
});

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const execFileAsync = promisify(execFile);

function parseStatusEntry(line) {
  if (line.length < 4) return null;
  const status = line.slice(0, 2);
  let entry = line.slice(3);
  if (status.includes("R") || status.includes("C")) {
    const arrow = entry.indexOf(" -> ");
    if (arrow >= 0) entry = entry.slice(arrow + 4);
  }
  if (entry.startsWith("\"") && entry.endsWith("\"")) entry = entry.slice(1, -1);
  if (!entry || entry.endsWith("/") || entry.includes("\u0000")) return null;
  return entry;
}

async function fingerprintEntry(workspaceRoot, entry) {
  const absolutePath = path.resolve(workspaceRoot, entry);
  if (absolutePath !== workspaceRoot && !absolutePath.startsWith(workspaceRoot + path.sep)) return null;
  let linkStatus;
  try {
    linkStatus = await fs.lstat(absolutePath);
  } catch {
    return null;
  }
  if (!linkStatus.isFile() || linkStatus.isSymbolicLink()) return null;
  let handle;
  try {
    handle = await fs.open(absolutePath, "r");
  } catch {
    return null;
  }
  try {
    const status = await handle.stat();
    if (!status.isFile()) return null;
    if (linkStatus.ino && status.ino && linkStatus.ino !== status.ino) return null;
    if (status.size > fingerprintLimits.maxFileBytes) return null;
    const buffer = Buffer.alloc(status.size);
    let offset = 0;
    while (offset < status.size) {
      const { bytesRead } = await handle.read(buffer, offset, status.size - offset, offset);
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== status.size || after.mtimeMs !== status.mtimeMs) return null;
    return { bytes: status.size, fingerprint: `${entry}\u0000${status.size}\u0000${hash(buffer)}` };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function workspaceRevision(workspace) {
  try {
    const { stdout: headOutput } = await execFileAsync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true });
    const head = headOutput.trim();
    if (!head) return null;
    const { stdout: stagedOutput } = await execFileAsync("git", ["-C", workspace, "diff-index", "--cached", "--raw", "-z", "HEAD"], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    if (Buffer.byteLength(stagedOutput, "utf8") > fingerprintLimits.maxStagedBytes) return null;
    const workspaceRoot = path.resolve(workspace);
    const { stdout: statusOutput } = await execFileAsync("git", ["-C", workspace, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true });
    const lines = statusOutput.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) return hash(`${head}\u0000${stagedOutput}`);
    if (lines.length > fingerprintLimits.maxEntries) return null;
    const entries = [];
    let totalBytes = 0;
    for (const line of lines) {
      const entry = parseStatusEntry(line);
      if (!entry) return null;
      const result = await fingerprintEntry(workspaceRoot, entry);
      if (!result) return null;
      totalBytes += result.bytes;
      if (totalBytes > fingerprintLimits.maxTotalBytes) return null;
      entries.push(result.fingerprint);
    }
    entries.sort((left, right) => left.localeCompare(right, "en"));
    return hash(`${head}\u0000${stagedOutput}\u0000${entries.join("\u0001")}`);
  } catch {
    return null;
  }
}

export function createReadOnlyResultCache({ enabled = true, ttlMs = 600000, maxEntryBytes = 262144, maxEntries = 100 } = {}) {
  const entries = new Map();

  async function keyFor({ workspace, backend, model, profile, prompt }) {
    const revision = await workspaceRevision(workspace);
    if (!enabled || !revision) return null;
    return hash(JSON.stringify({ workspace: hash(workspace), revision, backend, model, profile: profile || null, prompt }));
  }

  function get(key) {
    if (!key) return null;
    const entry = entries.get(key);
    if (!entry || Date.now() - entry.storedAt > ttlMs) {
      entries.delete(key);
      return null;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  function set(key, result) {
    if (!key || !result.ok || typeof result.result !== "string") return;
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized, "utf8") > maxEntryBytes) return;
    entries.delete(key);
    entries.set(key, { storedAt: Date.now(), value: result });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  return { keyFor, get, set };
}
