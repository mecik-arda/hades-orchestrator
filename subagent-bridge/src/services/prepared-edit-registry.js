import crypto from "node:crypto";
import { approvalClassValues, isOrchestratorApprovableClass } from "./approval-boundary.js";

const hashPattern = /^[a-f0-9]{64}$/;
const changeTypeValues = new Set(["created", "modified"]);
const defaultTtlMs = 300000;
const defaultMaxEntries = 50;
const defaultMaxTotalBytes = 8388608;

function requireHash(value, label) {
  if (typeof value !== "string" || !hashPattern.test(value)) throw new Error(`invalid prepared edit ${label}`);
  return value;
}

function requireSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid prepared edit path");
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || pathIsAbsolute(normalized)) throw new Error("invalid prepared edit path");
  if (normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) throw new Error("invalid prepared edit path");
  return normalized;
}

function pathIsAbsolute(value) {
  return /^[a-z]:\//i.test(value) || value.startsWith("//");
}

function normalizeChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) throw new Error("prepared edit requires changes");
  return changes.map((change) => {
    const relativePath = requireSafeRelativePath(change.relativePath);
    if (!changeTypeValues.has(change.changeType)) throw new Error("invalid prepared edit change type");
    if (!Buffer.isBuffer(change.content)) throw new Error("invalid prepared edit content");
    if (typeof change.diff !== "string") throw new Error("invalid prepared edit diff");
    return {
      relativePath,
      changeType: change.changeType,
      diff: change.diff,
      contentSha256: crypto.createHash("sha256").update(change.content).digest("hex"),
      content: Buffer.from(change.content)
    };
  });
}

function calculateContentDigest(changes) {
  const digest = crypto.createHash("sha256");
  for (const change of [...changes].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    digest.update(change.relativePath);
    digest.update("\0");
    digest.update(change.changeType);
    digest.update("\0");
    digest.update(crypto.createHash("sha256").update(change.content).digest());
  }
  return digest.digest("hex");
}

function normalizeSourceStateEntries(entries, changedPaths) {
  if (!Array.isArray(entries) || entries.length !== changedPaths.length) throw new Error("invalid prepared edit source state");
  const normalized = entries.map((entry) => {
    const relativePath = requireSafeRelativePath(entry.relativePath);
    if (entry.state === "absent") return { relativePath, state: "absent" };
    if (entry.state === "present" && hashPattern.test(entry.sha256)) return { relativePath, state: "present", sha256: entry.sha256 };
    throw new Error("invalid prepared edit source state");
  });
  const expectedPaths = [...changedPaths].sort().join("\n");
  const actualPaths = normalized.map((entry) => entry.relativePath).sort().join("\n");
  if (expectedPaths !== actualPaths) throw new Error("prepared edit source state does not match changes");
  return normalized;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid prepared edit ${label}`);
  return value;
}

function project(entry) {
  return {
    approvalRequestId: entry.approvalRequestId,
    executionIdHash: entry.executionIdHash,
    changeSetHash: entry.changeSetHash,
    approvalClass: entry.approvalClass,
    workspaceHash: entry.workspaceHash,
    sourceStateHash: entry.sourceStateHash,
    changedPaths: [...entry.changedPaths],
    filesChanged: [...entry.filesChanged],
    backend: entry.backend,
    model: entry.model,
    requestedModel: entry.requestedModel,
    resolvedModel: entry.resolvedModel,
    providerLabel: entry.providerLabel,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt
  };
}

function matchesBinding(entry, binding) {
  return entry.executionIdHash === binding.executionIdHash
    && entry.changeSetHash === binding.changeSetHash
    && entry.approvalClass === binding.approvalClass
    && entry.workspaceHash === binding.workspaceHash
    && entry.sourceStateHash === binding.sourceStateHash;
}

export function createPreparedEditRegistry({ ttlMs = defaultTtlMs, maxEntries = defaultMaxEntries, maxTotalBytes = defaultMaxTotalBytes, now = () => Date.now() } = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000) throw new Error("invalid prepared edit expiration");
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000) throw new Error("invalid prepared edit capacity");
  if (!Number.isInteger(maxTotalBytes) || maxTotalBytes < 1024 || maxTotalBytes > 67108864) throw new Error("invalid prepared edit size limit");
  const entries = new Map();

  function pruneExpired() {
    const currentTime = now();
    for (const [approvalRequestId, entry] of entries.entries()) {
      if (entry.state === "pending" && Date.parse(entry.expiresAt) <= currentTime) entries.delete(approvalRequestId);
    }
  }

  function currentTotalBytes() {
    let total = 0;
    for (const entry of entries.values()) total += entry.sizeBytes;
    return total;
  }

  function evictOldest() {
    const candidates = [...entries.entries()].filter(([, entry]) => entry.state !== "pending");
    const pending = [...entries.entries()].filter(([, entry]) => entry.state === "pending");
    const pool = pending.length > 0 ? pending : candidates;
    let oldest = null;
    for (const candidate of pool) {
      if (!oldest || Date.parse(candidate[1].createdAt) < Date.parse(oldest[1].createdAt)) oldest = candidate;
    }
    if (oldest) entries.delete(oldest[0]);
  }

  function store(record) {
    const executionIdHash = requireHash(record.executionIdHash, "execution hash");
    const changeSetHash = requireHash(record.changeSetHash, "change set hash");
    const workspaceHash = requireHash(record.workspaceHash, "workspace hash");
    const sourceStateHash = requireHash(record.sourceStateHash, "source state hash");
    if (!approvalClassValues.includes(record.approvalClass) || !isOrchestratorApprovableClass(record.approvalClass)) throw new Error("prepared edit class is not approvable in the orchestrator channel");
    const changes = normalizeChanges(record.changes);
    const changedPaths = changes.map((change) => change.relativePath);
    if (changedPaths.some((relativePath) => ["opencode.json", "opencode.jsonc"].includes(relativePath.split("/").pop().toLocaleLowerCase("en-US")))) throw new Error("invalid prepared edit path");
    const sourceStateEntries = normalizeSourceStateEntries(record.sourceStateEntries, changedPaths);
    const filesChanged = Array.isArray(record.filesChanged) ? record.filesChanged.map(requireSafeRelativePath) : changedPaths;
    if (filesChanged.length !== changedPaths.length || [...filesChanged].sort().join("\n") !== [...changedPaths].sort().join("\n")) throw new Error("invalid prepared edit file list");
    if (typeof record.diff !== "string") throw new Error("invalid prepared edit diff");
    const backend = requireText(record.backend, "backend");
    const model = requireText(record.model, "model");
    const providerLabel = requireText(record.providerLabel, "provider label");
    const requestedModel = record.requestedModel === undefined ? undefined : requireText(record.requestedModel, "requested model");
    const resolvedModel = record.resolvedModel === undefined || record.resolvedModel === null ? null : requireText(record.resolvedModel, "resolved model");
    const sizeBytes = changes.reduce((total, change) => total + change.content.length, 0) + Buffer.byteLength(record.diff, "utf8");
    if (sizeBytes > maxTotalBytes) throw new Error("prepared edit exceeds storage limit");
    pruneExpired();
    while (entries.size >= maxEntries) evictOldest();
    while (currentTotalBytes() + sizeBytes > maxTotalBytes) evictOldest();
    const approvalRequestId = crypto.randomBytes(32).toString("hex");
    const createdAt = new Date(now()).toISOString();
    const expiresAt = new Date(now() + ttlMs).toISOString();
    entries.set(approvalRequestId, {
      approvalRequestId,
      executionIdHash,
      changeSetHash,
      approvalClass: record.approvalClass,
      workspaceHash,
      sourceStateHash,
      changedPaths,
      filesChanged,
      sourceStateEntries,
      changes,
      contentDigest: calculateContentDigest(changes),
      diff: record.diff,
      sizeBytes,
      backend,
      model,
      requestedModel,
      resolvedModel,
      providerLabel,
      state: "pending",
      createdAt,
      expiresAt
    });
    return { approvalRequestId, expiresAt };
  }

  function peek(approvalRequestId) {
    if (typeof approvalRequestId !== "string") return null;
    pruneExpired();
    const entry = entries.get(approvalRequestId);
    if (!entry || entry.state !== "pending") return null;
    return project(entry);
  }

  function consume(approvalRequestId, binding) {
    if (typeof approvalRequestId !== "string" || !binding) return null;
    pruneExpired();
    const entry = entries.get(approvalRequestId);
    if (!entry || entry.state !== "pending") return null;
    if (!matchesBinding(entry, binding)) return null;
    if (calculateContentDigest(entry.changes) !== entry.contentDigest) {
      entries.delete(approvalRequestId);
      return null;
    }
    entry.state = "applying";
    return {
      ...project(entry),
      changes: entry.changes.map((change) => ({ ...change, content: Buffer.from(change.content) })),
      sourceStateEntries: entry.sourceStateEntries.map((sourceState) => ({ ...sourceState })),
      diff: entry.diff
    };
  }

  function settle(approvalRequestId) {
    entries.delete(approvalRequestId);
  }

  function invalidate(approvalRequestId) {
    const entry = entries.get(approvalRequestId);
    if (entry && entry.state === "pending") entries.delete(approvalRequestId);
  }

  function release(approvalRequestId) {
    const entry = entries.get(approvalRequestId);
    if (!entry || entry.state !== "applying") return;
    if (Date.parse(entry.expiresAt) <= now()) entries.delete(approvalRequestId);
    else entry.state = "pending";
  }

  return {
    store,
    peek,
    consume,
    settle,
    invalidate,
    release,
    stats() {
      pruneExpired();
      return { entries: entries.size, totalBytes: currentTotalBytes() };
    }
  };
}
