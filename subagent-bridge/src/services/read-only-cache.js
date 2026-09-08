import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const execFileAsync = promisify(execFile);

async function workspaceRevision(workspace) {
  try {
    const { stdout: status } = await execFileAsync("git", ["-C", workspace, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true });
    if (status.trim()) return null;
    const { stdout } = await execFileAsync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true });
    return stdout.trim();
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
