import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withMetricLock } from "../metrics.js";

export const parallelBatchRegistrySchemaVersion = 1;

export const parallelBatchTerminalStatuses = new Set(["integrated", "failed", "cancelled", "unknown"]);
export const parallelTaskTerminalStatuses = new Set(["completed", "failed", "blocked", "cancelled", "unknown"]);

const batchTransitions = {
  created: new Set(["planned", "queued", "failed", "cancelled"]),
  planned: new Set(["queued", "failed", "cancelled", "expired"]),
  queued: new Set(["running", "cancelled", "failed", "unknown"]),
  running: new Set(["result_ready", "blocked", "failed", "cancelling", "cancel_requested", "unknown"]),
  cancel_requested: new Set(["cancelling", "cancelled", "result_ready", "blocked", "failed", "unknown"]),
  cancelling: new Set(["cancelled", "unknown", "blocked", "failed", "result_ready"]),
  result_ready: new Set(["integrating", "ready_for_approval", "failed", "cancelled", "blocked"]),
  blocked: new Set(["failed", "cancelled", "unknown"]),
  integrating: new Set(["ready_for_approval", "integrated", "blocked", "failed", "unknown"]),
  ready_for_approval: new Set(["integrating", "integrated", "failed", "cancelled", "blocked"]),
  integrated: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  unknown: new Set(),
  expired: new Set()
};

const taskTransitions = {
  queued: new Set(["running", "cancelled", "blocked", "failed", "unknown"]),
  running: new Set(["completed", "failed", "blocked", "cancelled", "unknown"]),
  completed: new Set(),
  failed: new Set(),
  blocked: new Set(),
  cancelled: new Set(),
  unknown: new Set()
};

const interruptedBatchStatuses = new Set(["queued", "running", "cancel_requested", "cancelling", "integrating"]);

function nowIso() {
  return new Date().toISOString();
}

function writeJsonAtomic(filePath, value, assertOwner = () => true) {
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  if (assertOwner() !== true) return false;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (assertOwner() !== true) return false;
  if (assertOwner() !== true) return false;
  fs.renameSync(temporaryPath, filePath);
  return assertOwner() === true;
}

function roundCost(value) {
  return Number(Math.max(0, value).toFixed(12));
}

function reconcileBudget(manifest) {
  const pendingReservedUsd = (manifest.taskOrder || []).reduce((total, taskId) => {
    const task = manifest.tasks?.[taskId];
    return task && (task.status === "queued" || task.status === "running")
      ? total + (Number.isFinite(task.allocationUsd) ? task.allocationUsd : 0)
      : total;
  }, 0);
  const committedUsd = manifest.budget.spentKnownUsd + manifest.budget.unknownReservedUsd + pendingReservedUsd;
  manifest.budget.remainingUsd = roundCost(Math.max(0, manifest.budget.capUsd - committedUsd));
  manifest.budget.overageUsd = roundCost(Math.max(0, committedUsd - manifest.budget.capUsd));
}

function readJsonFile(filePath) {
  try {
    const status = fs.lstatSync(filePath);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function createParallelBatchRegistry({ stateDirectory, staleLockMs = 1500000 } = {}) {
  if (!stateDirectory) throw new Error("parallel batch state directory is required");
  const rootDirectory = stateDirectory;
  const plansDirectory = path.join(rootDirectory, "plans");
  const batchesDirectory = path.join(rootDirectory, "batches");
  const lockPath = path.join(rootDirectory, "parallel-batches.lock");
  fs.mkdirSync(plansDirectory, { recursive: true });
  fs.mkdirSync(batchesDirectory, { recursive: true });

  function planPath(planId) {
    return path.join(plansDirectory, `${planId}.json`);
  }

  function batchPath(batchId) {
    return path.join(batchesDirectory, `${batchId}.json`);
  }

  async function withStateLock(callback) {
    return withMetricLock(lockPath, callback, { timeoutMs: 10000, staleLockMs });
  }

  function validateBatchTransition(previousStatus, nextStatus) {
    if (previousStatus === nextStatus) return true;
    return batchTransitions[previousStatus]?.has(nextStatus) === true;
  }

  function validateTaskTransition(previousStatus, nextStatus) {
    if (previousStatus === nextStatus) return true;
    return taskTransitions[previousStatus]?.has(nextStatus) === true;
  }

  async function savePlan(plan) {
    return withStateLock(() => {
      writeJsonAtomic(planPath(plan.planId), plan);
      return { saved: true };
    });
  }

  async function getPlan(planId) {
    return readJsonFile(planPath(planId));
  }

  async function claimPlan({ planId, planHash, batchId }) {
    return withStateLock(() => {
      const plan = readJsonFile(planPath(planId));
      if (!plan) return { ok: false, reason: "plan_not_found" };
      if (plan.planHash !== planHash) return { ok: false, reason: "plan_hash_mismatch" };
      if (plan.status === "claimed" && plan.usedByBatchId) {
        return { ok: true, claimed: false, plan, batchId: plan.usedByBatchId };
      }
      if (plan.status !== "planned") return { ok: false, reason: "plan_not_claimable" };
      if (plan.expiresAt && Date.parse(plan.expiresAt) <= Date.now()) {
        plan.status = "expired";
        writeJsonAtomic(planPath(planId), plan);
        return { ok: false, reason: "plan_expired" };
      }
      plan.status = "claimed";
      plan.usedByBatchId = batchId;
      plan.claimedAt = nowIso();
      writeJsonAtomic(planPath(planId), plan);
      return { ok: true, claimed: true, plan };
    });
  }

  async function createBatch(manifest) {
    return withStateLock(() => {
      if (fs.existsSync(batchPath(manifest.batchId))) return { created: false, reason: "duplicate_batch" };
      writeJsonAtomic(batchPath(manifest.batchId), manifest);
      return { created: true };
    });
  }

  async function getBatch(batchId) {
    return readJsonFile(batchPath(batchId));
  }

  async function updateBatch(batchId, mutator, options = {}) {
    return withStateLock(() => {
      const manifest = readJsonFile(batchPath(batchId));
      if (!manifest) return { ok: false, reason: "batch_not_found" };
      const candidate = JSON.parse(JSON.stringify(manifest));
      const previousStatus = candidate.status;
      if (options.assertOwner && options.assertOwner() !== true) return { ok: false, reason: "owner_lost" };
      const result = mutator(candidate);
      if (result === false || result === null) return { ok: false, reason: "mutation_rejected" };
      const nextStatus = candidate.status;
      if (options.allowAnyTransition !== true && !validateBatchTransition(previousStatus, nextStatus)) {
        return { ok: false, reason: "invalid_batch_transition", previousStatus, nextStatus };
      }
      candidate.updatedAt = nowIso();
      if (!writeJsonAtomic(batchPath(batchId), candidate, options.assertOwner)) return { ok: false, reason: "owner_lost" };
      return { ok: true, manifest: candidate };
    });
  }

  async function renewBatchLease(batchId, { ownerId, ownerEpoch, ownerLeaseExpiresAt } = {}) {
    const leaseExpiration = Date.parse(ownerLeaseExpiresAt || "");
    if (typeof ownerId !== "string" || ownerId.length < 16 || ownerId.length > 128 || !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1 || !Number.isFinite(leaseExpiration) || leaseExpiration <= Date.now()) {
      return { ok: false, reason: "invalid_batch_lease" };
    }
    return withStateLock(() => {
      const manifest = readJsonFile(batchPath(batchId));
      if (!manifest) return { ok: false, reason: "batch_not_found" };
      if (manifest.ownerId !== ownerId || manifest.ownerEpoch !== ownerEpoch || !interruptedBatchStatuses.has(manifest.status)) return { ok: false, reason: "batch_lease_owner_mismatch" };
      const candidate = JSON.parse(JSON.stringify(manifest));
      candidate.ownerLeaseExpiresAt = ownerLeaseExpiresAt;
      candidate.updatedAt = nowIso();
      writeJsonAtomic(batchPath(batchId), candidate);
      return { ok: true, manifest: candidate };
    });
  }

  function assertBatchOwner(batchId, ownerId, ownerEpoch, allowedStatuses = interruptedBatchStatuses, allowExpiredLease = false) {
    try {
      const manifest = readJsonFile(batchPath(batchId));
      return manifest?.ownerId === ownerId
        && manifest.ownerEpoch === ownerEpoch
        && (allowExpiredLease || (Number.isFinite(Date.parse(manifest.ownerLeaseExpiresAt || ""))
          && Date.parse(manifest.ownerLeaseExpiresAt) > Date.now()))
        && (allowedStatuses instanceof Set ? allowedStatuses.has(manifest.status) : allowedStatuses.includes(manifest.status));
    } catch {
      return false;
    }
  }

  async function listBatches() {
    try {
      return fs.readdirSync(batchesDirectory)
        .filter((entry) => /^[a-f0-9]{16,64}\.json$/.test(entry))
        .map((entry) => readJsonFile(path.join(batchesDirectory, entry)))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async function recoverInterruptedBatches({ workspaceHash, assertOwner = () => true } = {}) {
    if (typeof workspaceHash !== "string" || !/^[a-f0-9]{64}$/.test(workspaceHash)) {
      return { recovered: [], unscopedCount: 0, reason: "workspace_hash_required" };
    }
    return withStateLock(() => {
      const recovered = [];
      let unscopedCount = 0;
      let liveOwnerCount = 0;
      for (const entry of fs.existsSync(batchesDirectory) ? fs.readdirSync(batchesDirectory) : []) {
        if (assertOwner() !== true) return { recovered, unscopedCount, liveOwnerCount, reason: "owner_lost" };
        if (!/^[a-f0-9]{16,64}\.json$/.test(entry)) continue;
        const manifest = readJsonFile(path.join(batchesDirectory, entry));
        if (!manifest || !interruptedBatchStatuses.has(manifest.status)) continue;
        if (workspaceHash !== undefined && manifest.workspaceHash !== workspaceHash) {
          if (typeof manifest.workspaceHash !== "string" || !/^[a-f0-9]{64}$/.test(manifest.workspaceHash)) unscopedCount += 1;
          continue;
        }
        const ownerLeaseExpiresAt = Date.parse(manifest.ownerLeaseExpiresAt || "");
        if (typeof manifest.ownerId === "string" && Number.isFinite(ownerLeaseExpiresAt) && ownerLeaseExpiresAt > Date.now()) {
          liveOwnerCount += 1;
          continue;
        }
        const recoveredAt = nowIso();
        let hadRunningTask = false;
        manifest.ownerEpoch = Number.isSafeInteger(manifest.ownerEpoch) ? manifest.ownerEpoch + 1 : 1;
        manifest.ownerId = null;
        manifest.ownerLeaseExpiresAt = null;
        manifest.budget ||= { capUsd: 0, spentKnownUsd: 0, unknownReservedUsd: 0, refundedUsd: 0, remainingUsd: 0, overageUsd: 0 };
        for (const taskId of manifest.taskOrder || []) {
          const task = manifest.tasks?.[taskId];
          if (!task || parallelTaskTerminalStatuses.has(task.status)) continue;
          if (task.status === "running") {
            hadRunningTask = true;
            task.status = "unknown";
            task.failureClass = "host_restart_unknown";
            if (task.budgetSettled !== true) {
              manifest.budget.unknownReservedUsd = roundCost(manifest.budget.unknownReservedUsd + (task.allocationUsd || 0));
              task.budgetSettled = true;
            }
            task.attempts = (task.attempts || []).map((attempt) => attempt.status === "running"
              ? { ...attempt, status: "unknown", endedAt: recoveredAt, failureClass: attempt.failureClass || "host_restart_unknown" }
              : attempt);
          } else {
            task.status = "blocked";
            task.failureClass = "host_restart_not_started";
            if (task.budgetSettled !== true) {
              manifest.budget.refundedUsd = roundCost(manifest.budget.refundedUsd + (task.allocationUsd || 0));
              task.budgetSettled = true;
            }
          }
          task.endedAt = recoveredAt;
          task.actionRequired = "blocked";
        }
        reconcileBudget(manifest);
        manifest.status = hadRunningTask ? "unknown" : "blocked";
        manifest.recoveredAt = recoveredAt;
        manifest.updatedAt = recoveredAt;
        if (!writeJsonAtomic(path.join(batchesDirectory, entry), manifest, assertOwner)) {
          return { recovered, unscopedCount, liveOwnerCount, reason: "owner_lost" };
        }
        recovered.push(manifest.batchId);
      }
      return { recovered, unscopedCount, liveOwnerCount };
    });
  }

  return {
    savePlan,
    getPlan,
    claimPlan,
    createBatch,
    getBatch,
    updateBatch,
    renewBatchLease,
    assertBatchOwner,
    listBatches,
    recoverInterruptedBatches,
    validateBatchTransition,
    validateTaskTransition,
    rootDirectory
  };
}
