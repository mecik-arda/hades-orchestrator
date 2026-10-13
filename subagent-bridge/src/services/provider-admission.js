import crypto from "node:crypto";
import { OPENCODE_MODEL_MAP } from "../adapters/opencode-adapter.js";

export function resolveProviderAdmissionProfile(route, configuration = {}) {
  const backend = typeof route?.backend === "string" ? route.backend.toLocaleLowerCase("en-US") : "unknown";
  const requestedModel = typeof route?.model === "string" ? route.model.trim().toLocaleLowerCase("en-US") : "default";
  const model = backend === "opencode" ? OPENCODE_MODEL_MAP[requestedModel] || requestedModel : requestedModel;
  const requestedRouteKey = `${backend}:${requestedModel}`;
  const namespace = backend === "opencode" ? model.split("/")[0] || "default" : backend;
  const routeKey = `${backend}:${model}`;
  const namespaceKey = `${backend}:${namespace}`;
  return configuration.profileByRoute?.[requestedRouteKey]
    || configuration.profileByRoute?.[routeKey]
    || configuration.profileByRoute?.[namespaceKey]
    || namespaceKey;
}

export function createProviderAdmission({
  workspaceCoordinator,
  defaultConcurrency = 2,
  profileConcurrency = {},
  maxQueuedPerProfile = 50,
  pollIntervalMs = 50,
  maxWaitMs = 600000,
  clock = Date.now
} = {}) {
  if (!workspaceCoordinator || typeof workspaceCoordinator.tryAcquire !== "function" || typeof workspaceCoordinator.release !== "function") {
    throw new TypeError("provider admission requires a shared workspace coordinator");
  }
  if (!Number.isInteger(defaultConcurrency) || defaultConcurrency < 1 || defaultConcurrency > 10) {
    throw new TypeError("provider admission default concurrency must be between 1 and 10");
  }
  if (!Number.isInteger(maxQueuedPerProfile) || maxQueuedPerProfile < 1) {
    throw new TypeError("provider admission queue capacity must be a positive integer");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 1000) {
    throw new TypeError("provider admission poll interval must be between 10 and 1000 milliseconds");
  }
  if (!Number.isInteger(maxWaitMs) || maxWaitMs < 1) {
    throw new TypeError("provider admission wait limit must be a positive integer");
  }

  const profileQueues = new Map();
  const pendingByExecution = new Map();
  const activeByExecution = new Map();
  const nextSlotByProfile = new Map();

  function concurrencyFor(profileId) {
    const configured = profileConcurrency[profileId];
    return Number.isInteger(configured) && configured >= 1 && configured <= 10
      ? configured
      : defaultConcurrency;
  }

  function queueFor(profileId) {
    if (!profileQueues.has(profileId)) profileQueues.set(profileId, { entries: [], draining: false, pollTimer: null });
    return profileQueues.get(profileId);
  }

  function removePending(entry) {
    const queue = profileQueues.get(entry.profileId);
    if (!queue) return;
    const index = queue.entries.indexOf(entry);
    if (index >= 0) queue.entries.splice(index, 1);
    pendingByExecution.delete(entry.executionId);
    entry.signal?.removeEventListener?.("abort", entry.abortListener);
    if (queue.entries.length === 0) {
      if (queue.pollTimer) clearTimeout(queue.pollTimer);
      profileQueues.delete(entry.profileId);
    }
  }

  function finishPending(entry, result) {
    if (!pendingByExecution.has(entry.executionId)) return false;
    removePending(entry);
    entry.resolve(result);
    drain(entry.profileId);
    return true;
  }

  function scheduleDrain(profileId, queue) {
    if (queue.pollTimer || queue.entries.length === 0) return;
    queue.pollTimer = setTimeout(() => {
      queue.pollTimer = null;
      drain(profileId);
    }, pollIntervalMs);
  }

  function acquireSlot(profileId, executionId, concurrency) {
    const firstSlot = nextSlotByProfile.get(profileId) || 0;
    for (let offset = 0; offset < concurrency; offset += 1) {
      const slot = (firstSlot + offset) % concurrency;
      const leaseId = crypto.randomUUID();
      const lockWorkspace = `provider-admission:${profileId}:slot:${slot}`;
      let grant;
      try {
        grant = workspaceCoordinator.tryAcquire(lockWorkspace, leaseId);
      } catch {
        grant = null;
      }
      if (!grant) continue;
      nextSlotByProfile.set(profileId, (slot + 1) % concurrency);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          activeByExecution.delete(executionId);
          workspaceCoordinator.release(leaseId);
          drain(profileId);
        }
      };
    }
    return null;
  }

  function drain(profileId) {
    const queue = profileQueues.get(profileId);
    if (!queue || queue.draining) return;
    queue.draining = true;
    try {
      while (queue.entries.length > 0) {
        const entry = queue.entries[0];
        if (entry.signal?.aborted) {
          finishPending(entry, { ok: false, reason: "cancelled", queueWaitMs: Math.max(0, clock() - entry.enqueuedAt) });
          continue;
        }
        const now = clock();
        if (now >= entry.deadline) {
          finishPending(entry, { ok: false, reason: "provider_queue_timeout", queueWaitMs: Math.max(0, now - entry.enqueuedAt) });
          continue;
        }
        const concurrency = concurrencyFor(profileId);
        const slot = acquireSlot(profileId, entry.executionId, concurrency);
        if (!slot) break;
        const queueWaitMs = Math.max(0, now - entry.enqueuedAt);
        removePending(entry);
        activeByExecution.set(entry.executionId, slot);
        entry.resolve({ ok: true, queueWaitMs, release: slot.release });
      }
    } finally {
      queue.draining = false;
      if (queue.entries.length === 0) {
        if (queue.pollTimer) clearTimeout(queue.pollTimer);
        profileQueues.delete(profileId);
      } else {
        scheduleDrain(profileId, queue);
      }
    }
  }

  function acquire(profileId, executionId, options = {}) {
    if (typeof profileId !== "string" || !profileId.trim() || typeof executionId !== "string" || !executionId.trim()) {
      return Promise.resolve({ ok: false, reason: "provider_admission_unavailable", queueWaitMs: 0 });
    }
    if (pendingByExecution.has(executionId) || activeByExecution.has(executionId)) {
      return Promise.resolve({ ok: false, reason: "duplicate_execution_id", queueWaitMs: 0 });
    }
    if (options.signal?.aborted) return Promise.resolve({ ok: false, reason: "cancelled", queueWaitMs: 0 });
    drain(profileId);
    const queue = queueFor(profileId);
    if (queue.entries.length >= maxQueuedPerProfile) {
      if (queue.entries.length === 0 && !queue.draining && !queue.pollTimer) profileQueues.delete(profileId);
      return Promise.resolve({ ok: false, reason: "provider_queue_full", queueWaitMs: 0 });
    }
    const enqueuedAt = clock();
    const requestedWaitMs = Number.isInteger(options.timeoutMs) && options.timeoutMs >= 0 ? options.timeoutMs : maxWaitMs;
    const deadline = enqueuedAt + Math.min(maxWaitMs, requestedWaitMs);
    return new Promise((resolve) => {
      const entry = {
        profileId,
        executionId,
        enqueuedAt,
        deadline,
        signal: options.signal,
        resolve,
        abortListener: null
      };
      entry.abortListener = () => finishPending(entry, { ok: false, reason: "cancelled", queueWaitMs: Math.max(0, clock() - enqueuedAt) });
      pendingByExecution.set(executionId, entry);
      queue.entries.push(entry);
      entry.signal?.addEventListener?.("abort", entry.abortListener, { once: true });
      if (entry.signal?.aborted) entry.abortListener();
      else drain(profileId);
    });
  }

  function cancel(executionId) {
    const entry = pendingByExecution.get(executionId);
    if (!entry) return false;
    return finishPending(entry, { ok: false, reason: "cancelled", queueWaitMs: Math.max(0, clock() - entry.enqueuedAt) });
  }

  return { acquire, cancel };
}
