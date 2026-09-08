import path from "node:path";

const readLocks = new Map();
const writeLocks = new Map();

function normalizeWorkspace(workspace) {
  return path.normalize(workspace).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function acquireReadLock(workspace) {
  const key = normalizeWorkspace(workspace);
  if (writeLocks.has(key)) return false;
  readLocks.set(key, (readLocks.get(key) || 0) + 1);
  return true;
}

export function releaseReadLock(workspace) {
  const key = normalizeWorkspace(workspace);
  const current = readLocks.get(key);
  if (current === undefined) return;
  if (current <= 1) readLocks.delete(key);
  else readLocks.set(key, current - 1);
}

export function acquireWriteLock(workspace) {
  const key = normalizeWorkspace(workspace);
  if (writeLocks.has(key) || readLocks.has(key)) return false;
  writeLocks.set(key, Date.now());
  return true;
}

export function releaseWriteLock(workspace) {
  writeLocks.delete(normalizeWorkspace(workspace));
}

export function releaseAllLocks() {
  readLocks.clear();
  writeLocks.clear();
}
