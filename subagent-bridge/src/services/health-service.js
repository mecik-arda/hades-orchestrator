import { runProcess } from "./execution-service.js";

const DEFAULT_TTL_MS = 45000;

const healthCache = new Map();
const pendingChecks = new Map();

export function createHealthCache({ ttlMs = DEFAULT_TTL_MS } = {}) {
  const cache = new Map();
  const pending = new Map();
  return {
    async check(key, operation) {
      const cached = cache.get(key);
      if (cached && Date.now() - cached.timestamp < ttlMs) return cached.result;
      if (pending.has(key)) return pending.get(key);
      const pendingResult = Promise.resolve().then(operation).then((result) => {
        cache.set(key, { result, timestamp: Date.now() });
        return result;
      });
      pending.set(key, pendingResult);
      try {
        return await pendingResult;
      } finally {
        pending.delete(key);
      }
    },
    clear() {
      cache.clear();
    }
  };
}

export function invalidateHealthCache() {
  healthCache.clear();
}

export function forceRefreshHealth() {
  invalidateHealthCache();
}

export async function checkAdapterHealth(adapterId, executable, options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cached = healthCache.get(adapterId);

  if (cached && Date.now() - cached.timestamp < ttlMs) {
    return cached.result;
  }

  if (pendingChecks.has(adapterId)) {
    return pendingChecks.get(adapterId);
  }

  const checkPromise = (async () => {
    const result = { installed: false, version: null, authValid: false, executable };

    try {
      const versionResult = await runProcess(executable, options.versionArgs || ["--version"], {
        timeoutMs: options.timeoutMs ?? 15000,
        maxOutputBytes: 65536,
        env: options.env || process.env
      });
      const output = versionResult.stdout.trim() || versionResult.stderr.trim();
      result.installed = versionResult.code === 0;
      result.version = output || null;
    } catch {
      result.error = "health check subprocess failed";
    }

    try {
      const authResult = await runProcess(executable, options.authArgs || ["--version"], {
        timeoutMs: options.timeoutMs ?? 15000,
        maxOutputBytes: 65536,
        env: options.env || process.env
      });
      result.authValid = authResult.code === 0;
    } catch {
      result.authValid = false;
    }

    healthCache.set(adapterId, { result, timestamp: Date.now() });
    return result;
  })();

  pendingChecks.set(adapterId, checkPromise);

  try {
    return await checkPromise;
  } finally {
    pendingChecks.delete(adapterId);
  }
}

export async function checkAllAdaptersHealth(adapterEntries) {
  const entries = await Promise.all(Object.entries(adapterEntries).map(async ([adapterId, adapter]) => {
    try {
      return [adapterId, await adapter.healthCheck()];
    } catch (error) {
      return [adapterId, {
        installed: false,
        version: null,
        authValid: false,
        executable: adapter?.executable || "unknown",
        error: error.message
      }];
    }
  }));
  return Object.fromEntries(entries);
}

export { checkAdapterHealth as healthCheck };
