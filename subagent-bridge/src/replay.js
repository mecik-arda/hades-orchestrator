import { validateRunManifestRecord } from "./recent-runs.js";

const manifestKeys = Object.freeze([
  "manifestVersion",
  "recordedAt",
  "backend",
  "modelHash",
  "requestedModelHash",
  "executionIdHash",
  "workspaceHash",
  "mode",
  "accessMode",
  "profile",
  "outcomeStatus",
  "failureClass",
  "failureStage",
  "providerCode",
  "retryStopReason",
  "usage",
  "attempts",
  "retries",
  "queueWaitMs",
  "cacheHit",
  "capability",
  "artifactHashes",
  "webEvidenceRepair"
]);

function projectUsage(usage) {
  const source = usage && typeof usage === "object" ? usage : {};
  return {
    durationMs: source.durationMs ?? null,
    totalCostUsd: source.totalCostUsd ?? null
  };
}

function projectAttempt(attempt) {
  const source = attempt && typeof attempt === "object" ? attempt : {};
  return {
    number: source.number ?? null,
    failureClass: source.failureClass ?? null,
    failureStage: source.failureStage ?? null,
    providerCode: source.providerCode ?? null,
    retryDecision: source.retryDecision ?? null,
    retryStopReason: source.retryStopReason ?? null,
    exitCode: source.exitCode ?? null,
    signal: source.signal ?? null,
    settingsLockWaitMs: source.settingsLockWaitMs ?? null,
    providerExecutionMs: source.providerExecutionMs ?? null,
    stdoutBucket: source.stdoutBucket ?? null,
    stderrBucket: source.stderrBucket ?? null,
    durationMs: source.durationMs ?? null,
    totalCostUsd: source.totalCostUsd ?? null
  };
}

function projectCapability(capability) {
  if (!capability || typeof capability !== "object") return null;
  return {
    canRead: capability.canRead === true,
    canWrite: capability.canWrite === true,
    supportsSandbox: capability.supportsSandbox === true,
    supportsModelSelection: capability.supportsModelSelection === true
  };
}

function projectArtifactHashes(value) {
  if (!Array.isArray(value)) return null;
  const hashes = value.filter((entry) => typeof entry === "string" && /^[a-f0-9]{64}$/.test(entry)).slice(0, 100);
  return hashes.length > 0 ? hashes : null;
}

function projectRecordedAt(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function projectRunManifest(record) {
  const validation = validateRunManifestRecord(record);
  if (!validation.success) throw new Error("replay record is not a run manifest");
  const value = validation.data;
  return {
    manifestVersion: 2,
    recordedAt: projectRecordedAt(value.recordedAt),
    backend: value.backend ?? null,
    modelHash: value.modelHash ?? null,
    requestedModelHash: value.requestedModelHash ?? null,
    executionIdHash: value.executionIdHash ?? null,
    workspaceHash: value.workspaceHash ?? null,
    mode: value.mode ?? null,
    accessMode: value.accessMode ?? value.mode ?? null,
    profile: value.profile ?? null,
    outcomeStatus: value.outcomeStatus ?? null,
    failureClass: value.failureClass ?? null,
    failureStage: value.failureStage ?? null,
    providerCode: value.providerCode ?? null,
    retryStopReason: value.retryStopReason ?? null,
    usage: projectUsage(value.usage),
    attempts: Array.isArray(value.attempts) ? value.attempts.slice(0, 100).map(projectAttempt) : [],
    retries: value.retries ?? 0,
    queueWaitMs: value.queueWaitMs ?? 0,
    cacheHit: value.cacheHit === true,
    capability: projectCapability(value.capability),
    artifactHashes: projectArtifactHashes(value.artifactHashes),
    webEvidenceRepair: value.webEvidenceRepair === true
  };
}

export function selectReplayRecord(records, { executionIdHash, latest = false } = {}) {
  const manifests = [...records].filter((record) => validateRunManifestRecord(record).success);
  if (executionIdHash) return manifests.find((record) => record.executionIdHash === executionIdHash) || null;
  if (!latest) return null;
  return manifests
    .filter((record) => projectRecordedAt(record.recordedAt) !== null)
    .reduce((latestRecord, record) => !latestRecord || Date.parse(record.recordedAt) >= Date.parse(latestRecord.recordedAt) ? record : latestRecord, null);
}

export { manifestKeys as replayManifestKeys };
