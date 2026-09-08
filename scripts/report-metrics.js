import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfiguration } from "../subagent-bridge/src/config.js";
import { getCostBudgetSnapshot, pruneMetricFiles } from "../subagent-bridge/src/metrics.js";

const configuration = loadConfiguration();
const metricsDirectory = path.join(configuration.statePaths.logs, "metrics");

function readMetricFile(metricsPath) {
  return fs.readFileSync(metricsPath, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

export function summarizeMetrics(records) {
  const healthRecords = records.filter((record) => record.recordType === "health_snapshot").sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt)).slice(-100);
  const directEditFeedback = new Map(records
    .filter((record) => record.recordType === "direct_edit_feedback" && record.executionIdHash)
    .map((record) => [record.executionIdHash, record.outcome]));
  const routingFeedback = new Map(records
    .filter((record) => record.recordType === "routing_feedback" && record.executionIdHash)
    .map((record) => [record.executionIdHash, record.outcome]));
  records = records.filter((record) => !record.recordType);
  const editRecords = records.filter((record) => record.mode === "edit" && record.outcomeStatus === "completed" && record.executionIdHash);
  const summarizeDirectEditRuns = (runs) => {
    const outcomes = { accepted: 0, minor_fix: 0, reverted: 0, security_concern: 0 };
    for (const record of runs) {
      const outcome = directEditFeedback.get(record.executionIdHash);
      if (outcome in outcomes) outcomes[outcome] += 1;
    }
    const labeledEditRuns = Object.values(outcomes).reduce((total, count) => total + count, 0);
    const interventionCount = outcomes.minor_fix + outcomes.reverted + outcomes.security_concern;
    return {
      totalEditRuns: runs.length,
      labeledEditRuns,
      pendingFeedback: runs.length - labeledEditRuns,
      outcomes,
      interventionRate: labeledEditRuns > 0 ? Number((interventionCount / labeledEditRuns).toFixed(4)) : null,
      rollbackOrSecurityRate: labeledEditRuns > 0 ? Number(((outcomes.reverted + outcomes.security_concern) / labeledEditRuns).toFixed(4)) : null,
      decisionReady: labeledEditRuns >= 30
    };
  };
  const directEditByBackend = {};
  const directEditByProfile = {};
  for (const record of editRecords) {
    const backend = record.backend || "unknown";
    (directEditByBackend[backend] ||= []).push(record);
    if (record.profile) (directEditByProfile[record.profile] ||= []).push(record);
  }
  const directEditBaseline = {
    ...summarizeDirectEditRuns(editRecords),
    byBackend: Object.fromEntries(Object.entries(directEditByBackend).map(([backend, runs]) => [backend, summarizeDirectEditRuns(runs)])),
    byProfile: Object.fromEntries(Object.entries(directEditByProfile).map(([profile, runs]) => [profile, summarizeDirectEditRuns(runs)]))
  };
  const routingByProfile = {};
  for (const record of records.filter((entry) => entry.profile && entry.executionIdHash)) {
    const aggregate = routingByProfile[record.profile] ||= { runs: 0, labeledRuns: 0, useful: 0, partial: 0, notUseful: 0, totalDurationMs: 0, totalCostUsd: 0 };
    aggregate.runs += 1;
    aggregate.totalDurationMs += record.usage?.durationMs || 0;
    aggregate.totalCostUsd += record.usage?.totalCostUsd || 0;
    const outcome = routingFeedback.get(record.executionIdHash);
    if (outcome === "useful") aggregate.useful += 1;
    if (outcome === "partial") aggregate.partial += 1;
    if (outcome === "not_useful") aggregate.notUseful += 1;
    if (outcome) aggregate.labeledRuns += 1;
  }
  for (const aggregate of Object.values(routingByProfile)) {
    aggregate.pendingFeedback = aggregate.runs - aggregate.labeledRuns;
    aggregate.usefulRate = aggregate.labeledRuns > 0 ? Number((aggregate.useful / aggregate.labeledRuns).toFixed(4)) : null;
    aggregate.averageDurationMs = aggregate.runs > 0 ? Math.round(aggregate.totalDurationMs / aggregate.runs) : 0;
    aggregate.totalCostUsd = Number(aggregate.totalCostUsd.toFixed(6));
    aggregate.decisionReady = aggregate.labeledRuns >= 15;
    delete aggregate.totalDurationMs;
  }
  const durations = records.map((record) => record.usage?.durationMs).filter(Number.isFinite).sort((left, right) => left - right);
  const percentile = (fraction) => durations.length === 0 ? 0 : durations[Math.min(durations.length - 1, Math.ceil(durations.length * fraction) - 1)];
  const byBackend = {};
  for (const record of records) {
    const backend = record.backend || "unknown";
    const aggregate = byBackend[backend] ||= { runs: 0, completed: 0, failed: 0, totalDurationMs: 0, cacheHits: 0, retries: 0 };
    aggregate.runs += 1;
    aggregate[record.outcomeStatus === "completed" ? "completed" : "failed"] += 1;
    aggregate.totalDurationMs += record.usage?.durationMs || 0;
    aggregate.cacheHits += record.cacheHit === true ? 1 : 0;
    aggregate.retries += record.retries ?? Math.max(0, (record.attempts?.length ?? 1) - 1);
  }
  for (const aggregate of Object.values(byBackend)) {
    aggregate.averageDurationMs = aggregate.runs > 0 ? Math.round(aggregate.totalDurationMs / aggregate.runs) : 0;
    delete aggregate.totalDurationMs;
  }
  const summary = records.reduce((aggregate, record) => {
    aggregate.runCount += 1;
    aggregate.totalDurationMs += record.usage?.durationMs || 0;
    aggregate.totalCostUsd += record.usage?.totalCostUsd || 0;
    aggregate.totalAttempts += record.attempts?.length ?? 1;
    aggregate.outcomes[record.outcomeStatus] = (aggregate.outcomes[record.outcomeStatus] || 0) + 1;
    if (record.failureClass) {
      aggregate.failureClasses[record.failureClass] = (aggregate.failureClasses[record.failureClass] || 0) + 1;
    }
    return aggregate;
  }, {
  runCount: 0,
  totalDurationMs: 0,
  totalCostUsd: 0,
  totalAttempts: 0,
  outcomes: {},
  failureClasses: {}
  });
  const healthByAdapter = {};
  for (const record of healthRecords) {
    for (const [adapterId, health] of Object.entries(record.adapters || {})) {
      const aggregate = healthByAdapter[adapterId] ||= { observations: 0, available: 0, lastObservedAt: null, lastStatus: "unavailable" };
      const available = health.installed === true && health.authValid !== false && !health.error;
      aggregate.observations += 1;
      aggregate.available += available ? 1 : 0;
      aggregate.lastObservedAt = record.recordedAt;
      aggregate.lastStatus = available ? "available" : "unavailable";
    }
  }
  for (const aggregate of Object.values(healthByAdapter)) {
    aggregate.availabilityRate = aggregate.observations > 0 ? Number((aggregate.available / aggregate.observations).toFixed(4)) : 0;
  }
  return {
    runCount: summary.runCount,
    averageDurationMs: summary.runCount > 0 ? Math.round(summary.totalDurationMs / summary.runCount) : 0,
    p50DurationMs: percentile(0.5),
    p95DurationMs: percentile(0.95),
    totalCostUsd: Number(summary.totalCostUsd.toFixed(6)),
    averageAttempts: summary.runCount > 0 ? Number((summary.totalAttempts / summary.runCount).toFixed(2)) : 0,
    outcomes: summary.outcomes,
    failureClasses: summary.failureClasses,
    byBackend,
    health: {
      observationCount: healthRecords.length,
      byAdapter: healthByAdapter
    },
    directEditBaseline,
    routingEvaluation: {
      byProfile: routingByProfile
    }
  };
}

export function readMetricsDirectory(directory) {
  return fs.existsSync(directory)
    ? fs.readdirSync(directory)
      .filter((entry) => /-runs(?:-[^.]+)?\.jsonl$/i.test(entry))
      .flatMap((entry) => readMetricFile(path.join(directory, entry)))
    : [];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const budget = await getCostBudgetSnapshot(configuration);
  if (process.argv.includes("--budget-only")) {
    console.log(JSON.stringify(budget, null, 2));
    process.exit(0);
  }
  const prunedFiles = process.argv.includes("--prune") ? pruneMetricFiles(configuration) : 0;
  const records = readMetricsDirectory(metricsDirectory);
  console.log(JSON.stringify({ ...summarizeMetrics(records), budget, metricsDirectory, prunedFiles }, null, 2));
}
