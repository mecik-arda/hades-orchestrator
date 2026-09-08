import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withStateLock(lockPath, callback) {
  const ownerId = crypto.randomUUID();
  const deadline = Date.now() + 5000;
  let descriptor = null;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (descriptor === null) {
    try {
      descriptor = fs.openSync(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 30000) fs.rmSync(lockPath, { force: true });
      } catch {
      }
      if (Date.now() >= deadline) throw new Error("provider circuit state lock unavailable");
      await wait(10);
    }
  }
  fs.writeFileSync(descriptor, ownerId, "utf8");
  try {
    return await callback();
  } finally {
    fs.closeSync(descriptor);
    try {
      if (fs.readFileSync(lockPath, "utf8") === ownerId) fs.rmSync(lockPath, { force: true });
    } catch {
    }
  }
}

function defaultState() {
  return { state: "closed", failures: [], openedAt: null, probeUntil: null, transitionedAt: new Date(0).toISOString() };
}

function readState(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!["closed", "open", "half_open"].includes(value.state) || !Array.isArray(value.failures)) return defaultState();
    return value;
  } catch {
    return defaultState();
  }
}

function writeState(filePath, state) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(state), { encoding: "utf8", flag: "wx" });
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    throw error;
  }
}

export function createProviderCircuitBreaker({ stateDirectory, failureThreshold = 5, windowMs = 60000, openMs = 30000 } = {}) {
  if (!stateDirectory) throw new Error("provider circuit state directory is required");

  function pathsFor(providerId) {
    const key = crypto.createHash("sha256").update(providerId).digest("hex");
    return {
      statePath: path.join(stateDirectory, `${key}.json`),
      lockPath: path.join(stateDirectory, `${key}.lock`)
    };
  }

  async function beforeCall(providerId, now = Date.now()) {
    const { statePath, lockPath } = pathsFor(providerId);
    try {
      return await withStateLock(lockPath, async () => {
        const state = readState(statePath);
        state.failures = state.failures.filter((timestamp) => Number.isFinite(timestamp) && timestamp >= now - windowMs);
        if (state.state === "open" && Number.isFinite(state.openedAt) && now - state.openedAt < openMs) {
          writeState(statePath, state);
          return { allowed: false, state: "open" };
        }
        if (state.state === "open" || state.state === "half_open") {
          if (state.state === "half_open" && Number.isFinite(state.probeUntil) && state.probeUntil > now) {
            return { allowed: false, state: "half_open" };
          }
          const nextState = {
            ...state,
            state: "half_open",
            probeUntil: now + openMs,
            transitionedAt: new Date(now).toISOString()
          };
          writeState(statePath, nextState);
          return { allowed: true, state: "half_open", probe: true };
        }
        writeState(statePath, state);
        return { allowed: true, state: "closed", probe: false };
      });
    } catch {
      return { allowed: true, state: "unavailable", probe: false };
    }
  }

  async function recordSuccess(providerId, now = Date.now()) {
    const { statePath, lockPath } = pathsFor(providerId);
    try {
      await withStateLock(lockPath, async () => writeState(statePath, {
        state: "closed",
        failures: [],
        openedAt: null,
        probeUntil: null,
        transitionedAt: new Date(now).toISOString()
      }));
    } catch {
    }
  }

  async function recordFailure(providerId, now = Date.now()) {
    const { statePath, lockPath } = pathsFor(providerId);
    try {
      await withStateLock(lockPath, async () => {
        const state = readState(statePath);
        const failures = [...state.failures.filter((timestamp) => Number.isFinite(timestamp) && timestamp >= now - windowMs), now];
        const shouldOpen = state.state === "half_open" || failures.length >= failureThreshold;
        writeState(statePath, {
          state: shouldOpen ? "open" : "closed",
          failures,
          openedAt: shouldOpen ? now : null,
          probeUntil: null,
          transitionedAt: new Date(now).toISOString()
        });
      });
    } catch {
    }
  }

  async function snapshot(providerIds, now = Date.now()) {
    const entries = await Promise.all(providerIds.map(async (providerId) => {
      const { statePath, lockPath } = pathsFor(providerId);
      try {
        return await withStateLock(lockPath, async () => {
          const state = readState(statePath);
          const failures = state.failures.filter((timestamp) => Number.isFinite(timestamp) && timestamp >= now - windowMs);
          return [providerId, {
            state: state.state,
            failureCount: failures.length,
            transitionedAt: state.transitionedAt
          }];
        });
      } catch {
        return [providerId, { state: "unavailable", failureCount: 0, transitionedAt: null }];
      }
    }));
    return Object.fromEntries(entries);
  }

  return { beforeCall, recordSuccess, recordFailure, snapshot };
}
