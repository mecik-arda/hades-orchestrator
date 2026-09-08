import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function workspaceKey(workspace) {
  return crypto.createHash("sha256").update(workspace).digest("hex");
}

function executionKey(executionId) {
  return crypto.createHash("sha256").update(executionId).digest("hex");
}

function stale(filePath, staleLockMs) {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs > staleLockMs;
  } catch {
    return false;
  }
}

function cleanStaleLocks(directory, staleLockMs) {
  try {
    const entries = fs.readdirSync(directory);
    const remainingEntries = [];
    for (const entry of entries) {
      const filePath = path.join(directory, entry);
      if (stale(filePath, staleLockMs)) {
        fs.rmSync(filePath, { force: true });
      } else {
        remainingEntries.push(entry);
      }
    }
    return remainingEntries;
  } catch {
    return null;
  }
}

function createLease(lockPath, ownerId, leaseHeartbeatMs) {
  const descriptor = fs.openSync(lockPath, "wx");
  fs.writeFileSync(descriptor, ownerId, "utf8");
  const heartbeat = setInterval(() => {
    try {
      fs.futimesSync(descriptor, new Date(), new Date());
    } catch {
      clearInterval(heartbeat);
    }
  }, leaseHeartbeatMs);
  heartbeat.unref?.();
  return () => {
    clearInterval(heartbeat);
    try {
      fs.closeSync(descriptor);
    } catch {
    }
    try {
      if (fs.readFileSync(lockPath, "utf8") === ownerId) fs.rmSync(lockPath, { force: true });
    } catch {
    }
  };
}

export function withGuard(directory, staleLockMs, callback) {
  const guardPath = path.join(directory, "guard.lock");
  const ownerId = crypto.randomUUID();
  let descriptor;
  try {
    descriptor = fs.openSync(guardPath, "wx");
  } catch (error) {
    if (error.code !== "EEXIST" || !stale(guardPath, staleLockMs)) return null;
    try {
      fs.rmSync(guardPath, { force: true });
      descriptor = fs.openSync(guardPath, "wx");
    } catch {
      return null;
    }
  }
  fs.writeFileSync(descriptor, ownerId, "utf8");
  try {
    return callback();
  } finally {
    fs.closeSync(descriptor);
    try {
      if (fs.readFileSync(guardPath, "utf8") === ownerId) fs.rmSync(guardPath, { force: true });
    } catch {
    }
  }
}

export function createWorkspaceCoordinator({ lockDirectory, staleLockMs = 1500000, leaseHeartbeatMs = Math.max(1000, Math.floor(staleLockMs / 3)), maxQueuedPerWorkspace = 100 } = {}) {
  const directory = lockDirectory || path.join(process.cwd(), ".subagent-bridge-locks");
  const queues = new Map();
  const active = new Map();
  const pending = new Map();

  function lockDirectoryFor(workspace) {
    const target = path.join(directory, workspaceKey(workspace));
    fs.mkdirSync(target, { recursive: true });
    return target;
  }

  function writerIntentPath(workspace, executionId) {
    return path.join(lockDirectoryFor(workspace), `writer-${executionKey(executionId)}.intent`);
  }

  function registerWriterIntent(workspace, executionId, priority, enqueuedAt) {
    try {
      const target = lockDirectoryFor(workspace);
      return withGuard(target, staleLockMs, () => {
        try {
          fs.writeFileSync(writerIntentPath(workspace, executionId), JSON.stringify({ priority, enqueuedAt }), { flag: "wx" });
        } catch (error) {
          if (error.code !== "EEXIST") return false;
        }
        return true;
      }) === true;
    } catch {
      return false;
    }
  }

  function clearWriterIntent(workspace, executionId) {
    try {
      fs.rmSync(writerIntentPath(workspace, executionId), { force: true });
    } catch {
    }
  }

  function earliestWriterIntent(target) {
    return fs.readdirSync(target)
      .filter((entry) => entry.startsWith("writer-"))
      .map((entry) => {
        try {
          const value = JSON.parse(fs.readFileSync(path.join(target, entry), "utf8"));
          return { entry, priority: Number.isFinite(value.priority) ? value.priority : 0, enqueuedAt: Number.isFinite(value.enqueuedAt) ? value.enqueuedAt : 0 };
        } catch {
          return { entry, priority: 0, enqueuedAt: 0 };
        }
      })
      .sort((left, right) => right.priority - left.priority || left.enqueuedAt - right.enqueuedAt)[0] || null;
  }

  function acquireExternal(workspace, mode, executionId, priority, enqueuedAt) {
    try {
      const target = lockDirectoryFor(workspace);
      return withGuard(target, staleLockMs, () => {
        const entries = cleanStaleLocks(target, staleLockMs) || fs.readdirSync(target);
        const writeExists = entries.includes("write.lock");
        const readExists = entries.some((entry) => entry.startsWith("read-"));
        const selectedWriterIntent = earliestWriterIntent(target);
        const writerIntentExists = selectedWriterIntent !== null;
        if ((mode === "read_only" && (writeExists || writerIntentExists)) || (mode === "edit" && (writeExists || readExists))) {
          return null;
        }
        if (mode === "edit" && selectedWriterIntent?.entry !== path.basename(writerIntentPath(workspace, executionId))) {
          return null;
        }
        const lockPath = mode === "edit"
          ? path.join(target, "write.lock")
          : path.join(target, `read-${executionKey(executionId)}.lock`);
        const ownerId = crypto.randomUUID();
        try {
          return createLease(lockPath, ownerId, leaseHeartbeatMs);
        } catch {
          return null;
        }
      });
    } catch {
      return null;
    }
  }

  function queueFor(workspace) {
    const key = workspaceKey(workspace);
    if (!queues.has(key)) queues.set(key, []);
    return queues.get(key);
  }

  function scheduleDrain(workspace, queue) {
    if (queue.retryTimer) return;
    queue.retryTimer = setTimeout(() => {
      queue.retryTimer = null;
      drain(workspace);
    }, 50);
  }

  function drain(workspace) {
    const queue = queueFor(workspace);
    while (queue.length > 0) {
      const queuedWriter = queue.filter((entry) => entry.mode === "edit").sort((left, right) => right.priority - left.priority || left.enqueuedAt - right.enqueuedAt)[0];
      const eligible = queuedWriter
        ? queue.filter((entry) => entry.enqueuedAt <= queuedWriter.enqueuedAt)
        : queue;
      const next = eligible.sort((left, right) => right.priority - left.priority || left.enqueuedAt - right.enqueuedAt)[0];
      if (next.cancelled) {
        queue.splice(queue.indexOf(next), 1);
        if (next.mode === "edit") clearWriterIntent(workspace, next.executionId);
        next.resolve(null);
        continue;
      }
      if (next.mode === "edit" && !registerWriterIntent(workspace, next.executionId, next.priority, next.enqueuedAt)) {
        scheduleDrain(workspace, queue);
        break;
      }
      const release = acquireExternal(workspace, next.mode, next.executionId, next.priority, next.enqueuedAt);
      if (!release) {
        scheduleDrain(workspace, queue);
        break;
      }
      queue.splice(queue.indexOf(next), 1);
      if (next.mode === "edit") clearWriterIntent(workspace, next.executionId);
      active.set(next.executionId, { workspace, release });
      next.resolve({ queueWaitMs: Date.now() - next.enqueuedAt });
    }
    if (queue.length === 0) {
      if (queue.retryTimer) clearTimeout(queue.retryTimer);
      queues.delete(workspaceKey(workspace));
    }
  }

  function acquire(workspace, mode, executionId, priority = 0) {
    const queue = queueFor(workspace);
    if (queue.length >= maxQueuedPerWorkspace) return Promise.resolve(null);
    return new Promise((resolve) => {
      const enqueuedAt = Date.now();
      const entry = { workspace, mode, executionId, priority, enqueuedAt, cancelled: false, resolve, retryTimer: null };
      const enqueue = () => {
        if (entry.cancelled) {
          pending.delete(executionId);
          resolve(null);
          return;
        }
        if (mode === "edit" && !registerWriterIntent(workspace, executionId, priority, enqueuedAt)) {
          pending.set(executionId, entry);
          entry.retryTimer = setTimeout(enqueue, 50);
          return;
        }
        pending.delete(executionId);
        queue.push(entry);
        drain(workspace);
      };
      enqueue();
    });
  }

  function release(executionId) {
    const entry = active.get(executionId);
    if (!entry) return;
    active.delete(executionId);
    entry.release();
    drain(entry.workspace);
  }

  function cancel(executionId) {
    const pendingEntry = pending.get(executionId);
    if (pendingEntry) {
      pendingEntry.cancelled = true;
      if (pendingEntry.retryTimer) clearTimeout(pendingEntry.retryTimer);
      pending.delete(executionId);
      pendingEntry.resolve(null);
      return true;
    }
    for (const queue of queues.values()) {
      const entry = queue.find((candidate) => candidate.executionId === executionId);
      if (entry) {
        entry.cancelled = true;
        if (entry.mode === "edit") clearWriterIntent(entry.workspace, entry.executionId);
        drain(entry.workspace);
        return true;
      }
    }
    return false;
  }

  function snapshot(now = Date.now()) {
    const queuedEntries = [...queues.values()].flatMap((queue) => [...queue]);
    const pendingEntries = [...pending.values()];
    const waitingEntries = [...queuedEntries, ...pendingEntries];
    const externalFiles = [];
    try {
      const workspaceDirectories = fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : [];
      for (const workspaceDirectory of workspaceDirectories) {
        if (!workspaceDirectory.isDirectory()) continue;
        const workspaceLockDirectory = path.join(directory, workspaceDirectory.name);
        for (const entry of fs.readdirSync(workspaceLockDirectory, { withFileTypes: true })) {
          if (entry.isFile() && entry.name !== "guard.lock") externalFiles.push(path.join(workspaceDirectory.name, entry.name));
        }
      }
    } catch {
    }
    externalFiles.sort((left, right) => left.localeCompare(right, "en"));
    return {
      localActive: active.size,
      localQueued: waitingEntries.length,
      oldestQueueEntryMs: waitingEntries.length > 0 ? Math.max(0, now - Math.min(...waitingEntries.map((entry) => entry.enqueuedAt))) : null,
      externalDiskLocks: externalFiles.map((_, index) => `lock-${index + 1}`),
      lockCount: externalFiles.length,
      leaseHeartbeatMs
    };
  }

  return { acquire, release, cancel, snapshot };
}
