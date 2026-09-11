import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendProjectMirrorMetric } from "./project-runs.js";
import {
  capabilityFailureClassValues,
  capabilityStatusValues,
  failureStageValues,
  outputSizeBucketValues,
  processSignalValues,
  providerCodeValues,
  retryDecisionValues,
  retryStopReasonValues
} from "./schemas/core-schemas.js";

function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeCost(value) {
  return Number(value.toFixed(12));
}

export const directEditFeedbackOutcomes = ["accepted", "minor_fix", "reverted", "security_concern"];
export const routingFeedbackOutcomes = ["useful", "partial", "not_useful"];

const tokenPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const hashPattern = /^[a-f0-9]{64}$/;

function sanitizeDurationMs(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export function normalizeFailureStage(value) {
  return failureStageValues.includes(value) ? value : null;
}

export function normalizeProviderCode(value) {
  if (value === null || value === undefined) return null;
  return providerCodeValues.includes(value) ? value : "unclassified";
}

export function normalizeProcessSignal(value) {
  return processSignalValues.includes(value) ? value : null;
}

export function normalizeRetryDecision(value) {
  return retryDecisionValues.includes(value) ? value : "not_applicable";
}

export function normalizeRetryStopReason(value) {
  if (value === null || value === undefined) return null;
  return retryStopReasonValues.includes(value) ? value : null;
}

export function normalizeOutputSizeBucket(value) {
  return outputSizeBucketValues.includes(value) ? value : null;
}

export function outputSizeBucket(byteLength) {
  if (!Number.isFinite(byteLength) || byteLength < 0) return null;
  if (byteLength === 0) return "empty";
  if (byteLength <= 1024) return "lte_1_kib";
  if (byteLength <= 64 * 1024) return "lte_64_kib";
  if (byteLength <= 1024 * 1024) return "lte_1_mib";
  return "gt_1_mib";
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

function readMetricLock(lockPath) {
  try {
    const status = fs.lstatSync(lockPath);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) return null;
    const raw = fs.readFileSync(lockPath, "utf8");
    try {
      const value = JSON.parse(raw);
      if (typeof value.token === "string" && Number.isInteger(value.pid) && value.pid > 0) return { token: value.token, pid: value.pid, mtimeMs: status.mtimeMs };
    } catch {
    }
    return /^[0-9a-f-]{36}$/i.test(raw) ? { token: raw, pid: null, mtimeMs: status.mtimeMs } : null;
  } catch {
    return null;
  }
}

export async function withMetricLock(lockPath, callback, options = {}) {
  const owner = { token: crypto.randomUUID(), pid: process.pid, createdAt: new Date().toISOString() };
  const timeoutMs = options.timeoutMs ?? 5000;
  const staleLockMs = options.staleLockMs ?? 30000;
  const deadline = Date.now() + timeoutMs;
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
        if (Date.now() >= deadline) throw new Error("metric lock unavailable");
        await pause(10);
        continue;
      }
      if (!lockContended) throw error;
      const first = readMetricLock(lockPath);
      await pause(10);
      const second = readMetricLock(lockPath);
      const deadOwner = second?.pid !== null && second?.pid !== undefined && !processIsAlive(second.pid);
      const staleLegacyOwner = second?.pid === null && Date.now() - second.mtimeMs > staleLockMs;
      if (first && second && first.token === second.token && (deadOwner || staleLegacyOwner)) {
        try {
          if (readMetricLock(lockPath)?.token === second.token) fs.rmSync(lockPath);
        } catch {
        }
      }
      if (Date.now() >= deadline) throw new Error("metric lock unavailable");
      await pause(10);
    }
  }
  try {
    return await callback();
  } finally {
    fs.closeSync(descriptor);
    try {
      if (readMetricLock(lockPath)?.token === owner.token) fs.rmSync(lockPath, { force: true });
    } catch {
    }
  }
}

export function createRedactedRunMetric(checkpoint, backend = "deepseek") {
  return {
    recordedAt: new Date().toISOString(),
    backend,
    runIdHash: hashValue(checkpoint.runId),
    taskIdHash: hashValue(checkpoint.taskId),
    agent: checkpoint.agent,
    role: checkpoint.role,
    modelHash: hashValue(checkpoint.model),
    outcomeStatus: checkpoint.result.status,
    failureClass: checkpoint.failureClass,
    usage: checkpoint.usage,
    attempts: checkpoint.attempts.map((attempt) => ({
      number: attempt.number,
      failureClass: attempt.failureClass,
      exitCode: attempt.exitCode,
      durationMs: attempt.durationMs,
      apiDurationMs: attempt.apiDurationMs,
      turns: attempt.turns,
      totalCostUsd: attempt.totalCostUsd,
      retryDelayMs: attempt.retryDelayMs
    }))
  };
}

function sanitizeFailureClass(value) {
  return typeof value === "string" && tokenPattern.test(value) ? value : "unclassified_failure";
}

function sanitizeBackend(value) {
  return typeof value === "string" && tokenPattern.test(value) ? value : "subagent";
}

function sanitizeHash(value) {
  return typeof value === "string" && hashPattern.test(value) ? value : null;
}

function sanitizeProfile(value) {
  return typeof value === "string" && tokenPattern.test(value) ? value : null;
}

const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function sanitizeTimestamp(value) {
  return typeof value === "string" && isoPattern.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}

function sanitizeRecordedAt(value) {
  return sanitizeTimestamp(value) ?? new Date().toISOString();
}

function sanitizeUsage(usage) {
  const source = usage && typeof usage === "object" ? usage : {};
  const sanitized = {};
  for (const key of ["durationMs", "apiDurationMs", "turns"]) {
    if (Number.isFinite(source[key]) && source[key] >= 0) sanitized[key] = source[key];
  }
  sanitized.totalCostUsd = Number.isFinite(source.totalCostUsd) && source.totalCostUsd >= 0 ? source.totalCostUsd : null;
  return sanitized;
}

function sanitizeAttemptV1(attempt) {
  const source = attempt && typeof attempt === "object" ? attempt : {};
  const sanitized = {};
  if (Number.isInteger(source.number) && source.number > 0) sanitized.number = source.number;
  sanitized.failureClass = source.failureClass === null || source.failureClass === undefined ? null : sanitizeFailureClass(source.failureClass);
  if (Number.isInteger(source.exitCode)) sanitized.exitCode = source.exitCode;
  for (const key of ["durationMs", "apiDurationMs", "turns", "retryDelayMs"]) {
    if (Number.isFinite(source[key]) && source[key] >= 0) sanitized[key] = source[key];
  }
  sanitized.totalCostUsd = Number.isFinite(source.totalCostUsd) && source.totalCostUsd >= 0 ? source.totalCostUsd : null;
  return sanitized;
}

function sanitizeAttemptV2(attempt) {
  const source = attempt && typeof attempt === "object" ? attempt : {};
  const sanitized = {};
  if (Number.isInteger(source.number) && source.number > 0) sanitized.number = source.number;
  sanitized.failureClass = source.failureClass === null || source.failureClass === undefined ? null : sanitizeFailureClass(source.failureClass);
  sanitized.failureStage = normalizeFailureStage(source.failureStage);
  sanitized.providerCode = normalizeProviderCode(source.providerCode);
  sanitized.exitCode = Number.isInteger(source.exitCode) ? source.exitCode : null;
  sanitized.signal = normalizeProcessSignal(source.signal);
  sanitized.retryDecision = normalizeRetryDecision(source.retryDecision);
  sanitized.retryStopReason = normalizeRetryStopReason(source.retryStopReason);
  sanitized.settingsLockWaitMs = sanitizeDurationMs(source.settingsLockWaitMs);
  sanitized.providerExecutionMs = sanitizeDurationMs(source.providerExecutionMs);
  sanitized.stdoutBucket = normalizeOutputSizeBucket(source.stdoutBucket);
  sanitized.stderrBucket = normalizeOutputSizeBucket(source.stderrBucket);
  sanitized.durationMs = sanitizeDurationMs(source.durationMs) ?? 0;
  sanitized.totalCostUsd = Number.isFinite(source.totalCostUsd) && source.totalCostUsd >= 0 ? source.totalCostUsd : null;
  return sanitized;
}

export function createRedactedExecutionMetric({ executionId, workspace, mode, profile, metricBackend, result }) {
  const attempts = (Array.isArray(result.metrics?.attempts) ? result.metrics.attempts : []).map(sanitizeAttemptV2);
  const lastAttempt = attempts.at(-1) || null;
  return {
    schemaVersion: 2,
    recordedAt: new Date().toISOString(),
    backend: metricBackend || result.backend,
    modelHash: hashValue(result.resolvedModel || result.model || "unavailable"),
    executionIdHash: hashValue(executionId),
    workspaceHash: hashValue(workspace || "unavailable"),
    mode: mode === "edit" ? "edit" : "read_only",
    profile: sanitizeProfile(profile),
    outcomeStatus: result.ok ? "completed" : "failed",
    failureClass: result.ok ? null : (lastAttempt ? lastAttempt.failureClass : sanitizeFailureClass(result.reason)),
    failureStage: result.ok ? null : (lastAttempt?.failureStage ?? null),
    providerCode: result.ok ? null : (lastAttempt?.providerCode ?? null),
    retryStopReason: result.ok ? null : (lastAttempt?.retryStopReason ?? null),
    usage: {
      durationMs: sanitizeDurationMs(result.durationMs),
      totalCostUsd: Number.isFinite(result.metrics?.totalCostUsd) && result.metrics.totalCostUsd >= 0 ? result.metrics.totalCostUsd : null
    },
    attempts,
    retries: Number.isInteger(result.metrics?.retries) && result.metrics.retries >= 0 ? result.metrics.retries : 0,
    queueWaitMs: Number.isFinite(result.metrics?.queueWaitMs) && result.metrics.queueWaitMs >= 0 ? result.metrics.queueWaitMs : 0,
    cacheHit: result.metrics?.cacheHit === true
  };
}

function sanitizeEvaluation(evaluation) {
  const source = evaluation && typeof evaluation === "object" ? evaluation : {};
  const sanitized = {};
  for (const key of ["caseCount", "abstentionAccuracy", "averageEstimatedContextTokens", "mrr", "aggregateNdcg"]) {
    if (Number.isFinite(source[key]) && source[key] >= 0) sanitized[key] = source[key];
  }
  if (Array.isArray(source.cutoffs)) sanitized.cutoffs = source.cutoffs.filter((value) => Number.isFinite(value) && value >= 0).slice(0, 20);
  return sanitized;
}

function sanitizeExecutionMetricV1(metric) {
  const sanitized = {
    recordedAt: sanitizeRecordedAt(metric.recordedAt),
    backend: sanitizeBackend(metric.backend)
  };
  for (const key of ["modelHash", "executionIdHash", "workspaceHash", "runIdHash", "taskIdHash"]) {
    const value = sanitizeHash(metric[key]);
    if (value) sanitized[key] = value;
  }
  if (metric.agent === "deepseek") sanitized.agent = "deepseek";
  if (["analyst", "researcher", "reviewer", "planner"].includes(metric.role)) sanitized.role = metric.role;
  if (["read_only", "edit", "not_applicable"].includes(metric.mode)) sanitized.mode = metric.mode;
  const profile = sanitizeProfile(metric.profile);
  if (profile) sanitized.profile = profile;
  if (["completed", "failed"].includes(metric.outcomeStatus)) sanitized.outcomeStatus = metric.outcomeStatus;
  sanitized.failureClass = metric.failureClass === null || metric.failureClass === undefined ? null : sanitizeFailureClass(metric.failureClass);
  if (metric.usage && typeof metric.usage === "object") sanitized.usage = sanitizeUsage(metric.usage);
  if (metric.evaluation && typeof metric.evaluation === "object") sanitized.evaluation = sanitizeEvaluation(metric.evaluation);
  if (Array.isArray(metric.attempts)) sanitized.attempts = metric.attempts.slice(0, 100).map(sanitizeAttemptV1);
  if (Number.isInteger(metric.retries) && metric.retries >= 0) sanitized.retries = metric.retries;
  if (Number.isFinite(metric.queueWaitMs) && metric.queueWaitMs >= 0) sanitized.queueWaitMs = metric.queueWaitMs;
  if (typeof metric.cacheHit === "boolean") sanitized.cacheHit = metric.cacheHit;
  return sanitized;
}

function sanitizeExecutionMetricV2(metric) {
  const usage = metric.usage && typeof metric.usage === "object" ? metric.usage : {};
  const attempts = Array.isArray(metric.attempts) ? metric.attempts.slice(0, 100).map(sanitizeAttemptV2) : [];
  const lastAttempt = attempts.at(-1) || null;
  const failed = metric.outcomeStatus === "failed";
  return {
    schemaVersion: 2,
    recordedAt: sanitizeRecordedAt(metric.recordedAt),
    backend: sanitizeBackend(metric.backend),
    modelHash: sanitizeHash(metric.modelHash) || hashValue("model-unavailable"),
    executionIdHash: sanitizeHash(metric.executionIdHash) || hashValue("execution-unavailable"),
    workspaceHash: sanitizeHash(metric.workspaceHash) || hashValue("workspace-unavailable"),
    mode: metric.mode === "edit" ? "edit" : "read_only",
    profile: sanitizeProfile(metric.profile),
    outcomeStatus: failed ? "failed" : "completed",
    failureClass: failed ? (lastAttempt ? lastAttempt.failureClass : (metric.failureClass === null || metric.failureClass === undefined ? null : sanitizeFailureClass(metric.failureClass))) : null,
    failureStage: failed ? (lastAttempt ? lastAttempt.failureStage : normalizeFailureStage(metric.failureStage)) : null,
    providerCode: failed ? (lastAttempt ? lastAttempt.providerCode : normalizeProviderCode(metric.providerCode)) : null,
    retryStopReason: failed ? (lastAttempt ? lastAttempt.retryStopReason : normalizeRetryStopReason(metric.retryStopReason)) : null,
    usage: {
      durationMs: sanitizeDurationMs(usage.durationMs),
      totalCostUsd: Number.isFinite(usage.totalCostUsd) && usage.totalCostUsd >= 0 ? usage.totalCostUsd : null
    },
    attempts,
    retries: attempts.length > 0 ? Math.max(0, attempts.length - 1) : (Number.isInteger(metric.retries) && metric.retries >= 0 ? metric.retries : 0),
    queueWaitMs: Number.isFinite(metric.queueWaitMs) && metric.queueWaitMs >= 0 ? metric.queueWaitMs : 0,
    cacheHit: metric.cacheHit === true
  };
}

function sanitizeVersionText(value) {
  if (typeof value !== "string") return null;
  const match = /\b[vV]?\d+(?:\.\d+){1,3}\b/.exec(value);
  return match ? match[0] : null;
}

function sanitizeProbeStatusMap(probes) {
  const source = probes && typeof probes === "object" ? probes : {};
  const sanitized = {};
  if (["available", "unavailable"].includes(source.cli)) sanitized.cli = source.cli;
  for (const key of ["modelAccess", "toolFreeResponse", "workspaceRead", "webRead"]) {
    if (capabilityStatusValues.includes(source[key])) sanitized[key] = source[key];
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function sanitizeCapabilityProbes(capabilityProbes) {
  const source = capabilityProbes && typeof capabilityProbes === "object" ? capabilityProbes : {};
  const sanitized = {};
  for (const [model, probe] of Object.entries(source)) {
    if (!tokenPattern.test(model) || !probe || typeof probe !== "object") continue;
    sanitized[model] = {
      modelAccess: capabilityStatusValues.includes(probe.modelAccess) ? probe.modelAccess : "not_probed",
      toolFreeResponse: capabilityStatusValues.includes(probe.toolFreeResponse) ? probe.toolFreeResponse : "not_probed",
      workspaceRead: capabilityStatusValues.includes(probe.workspaceRead) ? probe.workspaceRead : "not_probed",
      webRead: capabilityStatusValues.includes(probe.webRead) ? probe.webRead : "not_probed",
      failureClass: probe.failureClass === null || probe.failureClass === undefined
        ? null
        : (capabilityFailureClassValues.includes(probe.failureClass) ? probe.failureClass : "unclassified"),
      checkedAt: sanitizeTimestamp(probe.checkedAt)
    };
  }
  return sanitized;
}

function sanitizeHealthSnapshotMetric(metric) {
  const sanitizedAdapters = {};
  const adapters = metric.adapters && typeof metric.adapters === "object" ? metric.adapters : {};
  for (const [adapterId, entry] of Object.entries(adapters)) {
    if (!tokenPattern.test(adapterId) || !entry || typeof entry !== "object") continue;
    const sanitizedEntry = {
      installed: entry.installed === true,
      version: sanitizeVersionText(entry.version),
      authValid: typeof entry.authValid === "boolean" ? entry.authValid : null,
      error: entry.error === "unavailable" ? "unavailable" : null
    };
    const probes = sanitizeProbeStatusMap(entry.probes);
    if (probes) sanitizedEntry.probes = probes;
    const capabilityProbes = sanitizeCapabilityProbes(entry.capabilityProbes);
    if (Object.keys(capabilityProbes).length > 0) sanitizedEntry.capabilityProbes = capabilityProbes;
    sanitizedAdapters[adapterId] = sanitizedEntry;
  }
  return {
    recordType: "health_snapshot",
    recordedAt: sanitizeRecordedAt(metric.recordedAt),
    backend: sanitizeBackend(metric.backend),
    adapters: sanitizedAdapters
  };
}

function sanitizeFeedbackMetric(metric, recordType) {
  const allowedOutcomes = recordType === "direct_edit_feedback" ? directEditFeedbackOutcomes : routingFeedbackOutcomes;
  if (!allowedOutcomes.includes(metric.outcome)) throw new Error("invalid feedback outcome");
  const executionIdHash = sanitizeHash(metric.executionIdHash);
  if (!executionIdHash) throw new Error("invalid feedback execution id hash");
  return {
    recordType,
    recordedAt: sanitizeRecordedAt(metric.recordedAt),
    backend: sanitizeBackend(metric.backend),
    executionIdHash,
    outcome: metric.outcome
  };
}

function sanitizeRecordTypeMetric(metric) {
  if (metric.recordType === "health_snapshot") return sanitizeHealthSnapshotMetric(metric);
  if (metric.recordType === "direct_edit_feedback") return sanitizeFeedbackMetric(metric, "direct_edit_feedback");
  if (metric.recordType === "routing_feedback") return sanitizeFeedbackMetric(metric, "routing_feedback");
  return {
    recordType: typeof metric.recordType === "string" && tokenPattern.test(metric.recordType) ? metric.recordType : "unknown_record",
    recordedAt: sanitizeRecordedAt(metric.recordedAt),
    backend: sanitizeBackend(metric.backend)
  };
}

function sanitizeRunMetric(metric) {
  if (Object.hasOwn(metric, "recordType") && typeof metric.recordType === "string") return sanitizeRecordTypeMetric(metric);
  return Object.hasOwn(metric, "schemaVersion") && metric.schemaVersion === 2 ? sanitizeExecutionMetricV2(metric) : sanitizeExecutionMetricV1(metric);
}

function metricRecords(metricsDirectory, periodStart = 0) {
  if (!fs.existsSync(metricsDirectory)) return { records: [], invalidRecordCount: 0 };
  let invalidRecordCount = 0;
  const records = fs.readdirSync(metricsDirectory)
    .filter((entry) => entry.endsWith(".jsonl"))
    .flatMap((entry) => {
      try {
        const metricPath = path.join(metricsDirectory, entry);
        if (fs.statSync(metricPath).mtimeMs < periodStart) return [];
        return fs.readFileSync(metricPath, "utf8").split("\n").filter(Boolean).flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            invalidRecordCount += 1;
            return [];
          }
        });
      } catch {
        invalidRecordCount += 1;
        return [];
      }
    });
  return { records, invalidRecordCount };
}

function directEditFeedbackState(records) {
  const editRuns = records.filter((record) => !record.recordType && record.mode === "edit" && record.outcomeStatus === "completed" && record.executionIdHash);
  const feedbackByExecution = new Map(records
    .filter((record) => record.recordType === "direct_edit_feedback" && record.executionIdHash)
    .map((record) => [record.executionIdHash, record]));
  return { editRuns, feedbackByExecution };
}

function routingFeedbackState(records) {
  const profileRuns = records.filter((record) => !record.recordType && record.profile && record.executionIdHash);
  const feedbackByExecution = new Map(records
    .filter((record) => record.recordType === "routing_feedback" && record.executionIdHash)
    .map((record) => [record.executionIdHash, record]));
  return { profileRuns, feedbackByExecution };
}

export function listPendingDirectEditFeedback(configuration) {
  const metricsDirectory = path.join(configuration.statePaths.logs, "metrics");
  const { records } = metricRecords(metricsDirectory);
  const { editRuns, feedbackByExecution } = directEditFeedbackState(records);
  return editRuns
    .filter((record) => !feedbackByExecution.has(record.executionIdHash))
    .sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt))
    .map((record) => ({
      feedbackId: record.executionIdHash.slice(0, 12),
      backend: record.backend || "unknown",
      recordedAt: record.recordedAt,
      outcomeStatus: record.outcomeStatus,
      durationMs: Number.isFinite(record.usage?.durationMs) ? record.usage.durationMs : null,
      totalCostUsd: Number.isFinite(record.usage?.totalCostUsd) ? record.usage.totalCostUsd : null
    }));
}

export async function recordDirectEditFeedback(configuration, feedbackId, outcome) {
  if (!directEditFeedbackOutcomes.includes(outcome)) throw new Error("unsupported direct edit feedback outcome");
  if (!/^[a-f0-9]{8,64}$/i.test(feedbackId)) throw new Error("invalid feedback ID");
  const metricsDirectory = path.join(configuration.statePaths.logs, "metrics");
  fs.mkdirSync(metricsDirectory, { recursive: true });
  return withMetricLock(path.join(metricsDirectory, "direct-edit-feedback.lock"), async () => {
    const { records } = metricRecords(metricsDirectory);
    const { editRuns, feedbackByExecution } = directEditFeedbackState(records);
    const matches = editRuns.filter((record) => record.executionIdHash.startsWith(feedbackId.toLowerCase()));
    if (matches.length === 0) throw new Error("direct edit feedback ID not found");
    if (matches.length > 1) throw new Error("direct edit feedback ID is ambiguous");
    const executionIdHash = matches[0].executionIdHash;
    if (feedbackByExecution.has(executionIdHash)) throw new Error("direct edit feedback already recorded");
    const metric = {
      recordType: "direct_edit_feedback",
      recordedAt: new Date().toISOString(),
      backend: "direct-edit-baseline",
      executionIdHash,
      outcome
    };
    await appendRedactedRunMetric(configuration, metric);
    return { recorded: true, feedbackId: executionIdHash.slice(0, 12), outcome };
  });
}

export function listPendingRoutingFeedback(configuration) {
  const metricsDirectory = path.join(configuration.statePaths.logs, "metrics");
  const { records } = metricRecords(metricsDirectory);
  const { profileRuns, feedbackByExecution } = routingFeedbackState(records);
  return profileRuns
    .filter((record) => !feedbackByExecution.has(record.executionIdHash))
    .sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt))
    .map((record) => ({
      feedbackId: record.executionIdHash.slice(0, 12),
      profile: record.profile,
      backend: record.backend || "unknown",
      modelHash: record.modelHash,
      recordedAt: record.recordedAt,
      outcomeStatus: record.outcomeStatus,
      durationMs: Number.isFinite(record.usage?.durationMs) ? record.usage.durationMs : null,
      totalCostUsd: Number.isFinite(record.usage?.totalCostUsd) ? record.usage.totalCostUsd : null
    }));
}

export async function recordRoutingFeedback(configuration, feedbackId, outcome) {
  if (!routingFeedbackOutcomes.includes(outcome)) throw new Error("unsupported routing feedback outcome");
  if (!/^[a-f0-9]{8,64}$/i.test(feedbackId)) throw new Error("invalid feedback ID");
  const metricsDirectory = path.join(configuration.statePaths.logs, "metrics");
  fs.mkdirSync(metricsDirectory, { recursive: true });
  return withMetricLock(path.join(metricsDirectory, "routing-feedback.lock"), async () => {
    const { records } = metricRecords(metricsDirectory);
    const { profileRuns, feedbackByExecution } = routingFeedbackState(records);
    const matches = profileRuns.filter((record) => record.executionIdHash.startsWith(feedbackId.toLowerCase()));
    if (matches.length === 0) throw new Error("routing feedback ID not found");
    if (matches.length > 1) throw new Error("routing feedback ID is ambiguous");
    const executionIdHash = matches[0].executionIdHash;
    if (feedbackByExecution.has(executionIdHash)) throw new Error("routing feedback already recorded");
    const metric = {
      recordType: "routing_feedback",
      recordedAt: new Date().toISOString(),
      backend: "routing-evaluation",
      executionIdHash,
      outcome
    };
    await appendRedactedRunMetric(configuration, metric);
    return { recorded: true, feedbackId: executionIdHash.slice(0, 12), outcome };
  });
}

function periodCost(records, periodStart) {
  const executions = new Map();
  const reservations = new Map();
  const settlements = new Map();
  const now = Date.now();
  for (const record of records) {
    const recordedAt = Date.parse(record.recordedAt);
    if (!Number.isFinite(recordedAt) || recordedAt < periodStart) continue;
    if (record.recordType === "cost_reservation" && record.executionIdHash && Number.isFinite(record.reservedCostUsd) && (!record.expiresAt || Date.parse(record.expiresAt) > now)) {
      reservations.set(record.executionIdHash, record.reservedCostUsd);
    }
    if (record.recordType === "cost_settlement" && record.executionIdHash && Number.isFinite(record.chargedCostUsd)) {
      settlements.set(record.executionIdHash, record.chargedCostUsd);
    }
    if (!record.recordType && record.executionIdHash) {
      executions.set(record.executionIdHash, Number.isFinite(record.usage?.totalCostUsd) ? record.usage.totalCostUsd : 0);
    }
  }
  let total = 0;
  for (const [executionIdHash, reservedCostUsd] of reservations) {
    if (settlements.has(executionIdHash)) total += settlements.get(executionIdHash);
    else total += executions.has(executionIdHash) ? executions.get(executionIdHash) : reservedCostUsd;
  }
  for (const [executionIdHash, totalCostUsd] of executions) {
    if (!reservations.has(executionIdHash) && !settlements.has(executionIdHash)) total += totalCostUsd;
  }
  for (const [executionIdHash, chargedCostUsd] of settlements) {
    if (!reservations.has(executionIdHash)) total += chargedCostUsd;
  }
  return total;
}

function appendJournalRecord(filePath, record) {
  const descriptor = fs.openSync(filePath, "a");
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function rotateCostJournal(configuration, metricsDirectory, serializedBytes) {
  const metricsPath = path.join(metricsDirectory, "cost-budget-runs.jsonl");
  const existingBytes = fs.existsSync(metricsPath) ? fs.statSync(metricsPath).size : 0;
  if (existingBytes > 0 && existingBytes + serializedBytes > configuration.observability?.maxMetricFileBytes) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.renameSync(metricsPath, path.join(metricsDirectory, `cost-budget-runs-${timestamp}-${crypto.randomUUID()}.jsonl`));
  }
  return metricsPath;
}

function currentPeriodStarts(now = new Date()) {
  return {
    day: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    month: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  };
}

function activeReservationCount(records, now = Date.now()) {
  const reservations = new Map();
  const completed = new Set();
  for (const record of records) {
    if (!record.executionIdHash) continue;
    if (record.recordType === "cost_reservation" && Number.isFinite(record.reservedCostUsd) && Date.parse(record.expiresAt) > now) {
      reservations.set(record.executionIdHash, record);
    } else if (record.recordType === "cost_settlement" || !record.recordType) {
      completed.add(record.executionIdHash);
    }
  }
  return [...reservations.keys()].filter((executionIdHash) => !completed.has(executionIdHash)).length;
}

export async function getCostBudgetSnapshot(configuration, now = new Date()) {
  const dailyLimit = Number.isFinite(configuration.reliability?.dailyCostLimitUsd) ? configuration.reliability.dailyCostLimitUsd : null;
  const monthlyLimit = Number.isFinite(configuration.reliability?.monthlyCostLimitUsd) ? configuration.reliability.monthlyCostLimitUsd : null;
  const warningThresholdPercent = Number.isFinite(configuration.reliability?.warningThresholdPercent) ? configuration.reliability.warningThresholdPercent : 100;
  const metricsDirectory = path.join(configuration.statePaths.logs, "metrics");
  fs.mkdirSync(metricsDirectory, { recursive: true });
  return withMetricLock(path.join(metricsDirectory, "cost-budget.lock"), async () => {
    const periods = currentPeriodStarts(now);
    const { records, invalidRecordCount } = metricRecords(metricsDirectory, periods.month);
    const dailySpentUsd = normalizeCost(periodCost(records, periods.day));
    const monthlySpentUsd = normalizeCost(periodCost(records, periods.month));
    const dailyUsagePercent = dailyLimit === null ? null : normalizeCost((dailySpentUsd / dailyLimit) * 100);
    const monthlyUsagePercent = monthlyLimit === null ? null : normalizeCost((monthlySpentUsd / monthlyLimit) * 100);
    return {
      dailyLimitUsd: dailyLimit,
      dailySpentUsd,
      dailyRemainingUsd: dailyLimit === null ? null : normalizeCost(Math.max(0, dailyLimit - dailySpentUsd)),
      monthlyLimitUsd: monthlyLimit,
      monthlySpentUsd,
      monthlyRemainingUsd: monthlyLimit === null ? null : normalizeCost(Math.max(0, monthlyLimit - monthlySpentUsd)),
      dailyUsagePercent,
      monthlyUsagePercent,
      dailyWarning: dailyUsagePercent !== null && dailyUsagePercent >= warningThresholdPercent,
      monthlyWarning: monthlyUsagePercent !== null && monthlyUsagePercent >= warningThresholdPercent,
      warningThresholdPercent,
      activeReservations: activeReservationCount(records, now.getTime()),
      droppedMetricRecords: invalidRecordCount
    };
  });
}

export async function reserveCostBudget(configuration, executionId, reservedCostUsd) {
  const dailyCostLimitUsd = configuration.reliability?.dailyCostLimitUsd;
  const monthlyCostLimitUsd = configuration.reliability?.monthlyCostLimitUsd;
  if (!Number.isFinite(dailyCostLimitUsd) && !Number.isFinite(monthlyCostLimitUsd)) return { allowed: true };
  const metricsDirectory = path.join(configuration.statePaths.logs, "metrics");
  fs.mkdirSync(metricsDirectory, { recursive: true });
  return withMetricLock(path.join(metricsDirectory, "cost-budget.lock"), async () => {
    const periods = currentPeriodStarts();
    const { records } = metricRecords(metricsDirectory);
    const executionIdHash = hashValue(executionId);
    if (records.some((record) => record.executionIdHash === executionIdHash && ["cost_reservation", "cost_settlement"].includes(record.recordType))) {
      return { allowed: false, reason: "duplicate_cost_reservation" };
    }
    const dailyCostUsd = periodCost(records, periods.day);
    const monthlyCostUsd = periodCost(records, periods.month);
    if (Number.isFinite(dailyCostLimitUsd) && dailyCostUsd + reservedCostUsd > dailyCostLimitUsd) {
      return {
        allowed: false,
        reason: "daily_cost_budget_exhausted",
        budget: {
          period: "daily",
          limitUsd: normalizeCost(dailyCostLimitUsd),
          spentUsd: normalizeCost(dailyCostUsd),
          remainingUsd: normalizeCost(Math.max(0, dailyCostLimitUsd - dailyCostUsd))
        }
      };
    }
    if (Number.isFinite(monthlyCostLimitUsd) && monthlyCostUsd + reservedCostUsd > monthlyCostLimitUsd) {
      return {
        allowed: false,
        reason: "monthly_cost_budget_exhausted",
        budget: {
          period: "monthly",
          limitUsd: normalizeCost(monthlyCostLimitUsd),
          spentUsd: normalizeCost(monthlyCostUsd),
          remainingUsd: normalizeCost(Math.max(0, monthlyCostLimitUsd - monthlyCostUsd))
        }
      };
    }
    const record = {
      recordType: "cost_reservation",
      recordedAt: new Date().toISOString(),
      executionIdHash,
      reservedCostUsd,
      expiresAt: new Date(Date.now() + (configuration.reliability?.maxTotalDurationMs || 1200000)).toISOString()
    };
    const serializedBytes = Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8");
    appendJournalRecord(rotateCostJournal(configuration, metricsDirectory, serializedBytes), record);
    return { allowed: true };
  });
}

export async function settleCostBudget(configuration, executionId, actualCostUsd = null) {
  const dailyCostLimitUsd = configuration.reliability?.dailyCostLimitUsd;
  const monthlyCostLimitUsd = configuration.reliability?.monthlyCostLimitUsd;
  if (!Number.isFinite(dailyCostLimitUsd) && !Number.isFinite(monthlyCostLimitUsd)) return { settled: false };
  const metricsDirectory = path.join(configuration.statePaths.logs, "metrics");
  fs.mkdirSync(metricsDirectory, { recursive: true });
  return withMetricLock(path.join(metricsDirectory, "cost-budget.lock"), async () => {
    const executionIdHash = hashValue(executionId);
    const { records } = metricRecords(metricsDirectory);
    const reservation = [...records].reverse().find((record) => record.recordType === "cost_reservation" && record.executionIdHash === executionIdHash);
    const existingSettlement = [...records].reverse().find((record) => record.recordType === "cost_settlement" && record.executionIdHash === executionIdHash);
    if (!reservation || existingSettlement) return { settled: false };
    const chargedCostUsd = Number.isFinite(actualCostUsd) ? Math.max(0, actualCostUsd) : reservation.reservedCostUsd;
    const record = {
      recordType: "cost_settlement",
      recordedAt: new Date().toISOString(),
      executionIdHash,
      chargedCostUsd,
      actualCostKnown: Number.isFinite(actualCostUsd)
    };
    const serializedBytes = Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8");
    appendJournalRecord(rotateCostJournal(configuration, metricsDirectory, serializedBytes), record);
    return { settled: true, chargedCostUsd };
  });
}

export function pruneMetricFiles(configuration, now = Date.now()) {
  const metricsDirectory = path.join(configuration.statePaths.logs, "metrics");
  const maxMetricRetentionDays = configuration.observability?.maxMetricRetentionDays;
  if (!Number.isInteger(maxMetricRetentionDays) || maxMetricRetentionDays < 1 || !fs.existsSync(metricsDirectory)) return 0;
  const cutoff = now - maxMetricRetentionDays * 86400000;
  let deleted = 0;
  for (const entry of fs.readdirSync(metricsDirectory)) {
    if (!/-runs-[^.]+\.jsonl$/i.test(entry)) continue;
    const metricPath = path.join(metricsDirectory, entry);
    try {
      if (fs.statSync(metricPath).mtimeMs < cutoff) {
        fs.rmSync(metricPath, { force: true });
        deleted += 1;
      }
    } catch {
    }
  }
  return deleted;
}

export async function appendRedactedRunMetric(configuration, metric, options = {}) {
  const metricsDirectory = path.join(configuration.statePaths.logs, "metrics");
  fs.mkdirSync(metricsDirectory, { recursive: true });
  const redactedMetric = sanitizeRunMetric(metric);
  const safeBackend = sanitizeBackend(redactedMetric.backend);
  const metricsPath = path.join(metricsDirectory, `${safeBackend}-runs.jsonl`);
  const serialized = `${JSON.stringify(redactedMetric)}\n`;
  await withMetricLock(`${metricsPath}.lock`, async () => {
    const existingBytes = fs.existsSync(metricsPath) ? fs.statSync(metricsPath).size : 0;
    if (existingBytes > 0 && existingBytes + Buffer.byteLength(serialized, "utf8") > configuration.observability.maxMetricFileBytes) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.renameSync(metricsPath, path.join(metricsDirectory, `${safeBackend}-runs-${timestamp}-${crypto.randomUUID()}.jsonl`));
    }
    fs.appendFileSync(metricsPath, serialized, "utf8");
  });
  const mirror = options.workspace
    ? await appendProjectMirrorMetric(configuration, options.workspace, redactedMetric)
    : { written: false, reason: "not_requested" };
  return { written: true, path: metricsPath, mirror };
}
