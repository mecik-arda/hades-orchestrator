import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentConfigurationVersion, loadConfiguration } from "../subagent-bridge/src/config.js";
import { checkPersistentMemory, findQuarantinedMemoryNotes, reviewPersistentMemory } from "../subagent-bridge/src/memory.js";

const doctorSchemaVersion = 2;

function readFileHead(filePath, maximumBytes) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maximumBytes);
    const bytesRead = fs.readSync(descriptor, buffer, 0, maximumBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function readAuditRaceEvents(configuration) {
  const auditDirectory = configuration.statePaths?.logs ? path.join(configuration.statePaths.logs, "audit") : null;
  if (!auditDirectory || !fs.existsSync(auditDirectory)) return { events: [], error: false };
  let names;
  try {
    names = fs.readdirSync(auditDirectory).filter((name) => /^memory-events.*\.jsonl$/.test(name));
  } catch {
    return { events: [], error: true };
  }
  const maximumBytes = configuration.memory?.auditMaxBytes ?? 5242880;
  const events = [];
  let error = false;
  for (const name of names) {
    try {
      const content = readFileHead(path.join(auditDirectory, name), maximumBytes);
      for (const line of content.split("\n").filter(Boolean)) {
        try {
          const record = JSON.parse(line);
          if (record.event === "PROMOTE_RACE_CONDITION") events.push({ noteIdHash: record.noteIdHash });
        } catch {
          error = true;
        }
      }
    } catch {
      error = true;
    }
  }
  return { events, error };
}

function buildAttentionFlags(review, bodyCollisions, quarantine, auditRaceEvents, configurationVersion) {
  return review.counts.invalidMetadata > 0
    || review.counts.expiredNotes > 0
    || bodyCollisions.length > 0
    || quarantine.notes.length > 0
    || quarantine.scanErrorCount > 0
    || auditRaceEvents.events.length > 0
    || auditRaceEvents.error
    || !(configurationVersion && configurationVersion.active === currentConfigurationVersion);
}

export function buildMemoryDoctorReport(configuration) {
  let health;
  try {
    health = checkPersistentMemory(configuration);
  } catch {
    const enabled = configuration.memory?.enabled !== false;
    return {
      enabled,
      readable: false,
      writable: false,
      status: enabled ? "unreadable" : "disabled",
      schemaVersion: doctorSchemaVersion,
      error: enabled ? "vault_unreadable" : "memory_unavailable"
    };
  }
  if (health.readable !== true) {
    return {
      enabled: health.enabled,
      readable: false,
      writable: health.writable,
      status: "unreadable",
      schemaVersion: doctorSchemaVersion,
      error: "vault_unreadable"
    };
  }
  let review;
  try {
    review = reviewPersistentMemory(configuration);
  } catch {
    return {
      enabled: true,
      readable: true,
      writable: health.writable,
      status: "error",
      schemaVersion: doctorSchemaVersion,
      error: "review_failed"
    };
  }
  let quarantine;
  try {
    quarantine = findQuarantinedMemoryNotes(configuration);
  } catch {
    quarantine = { notes: [], scanErrorCount: 1 };
  }
  const auditRaceEvents = readAuditRaceEvents(configuration);
  const bodyCollisions = review.promotionRaceConditions.map((entry) => ({
    draftPaths: entry.draftPaths,
    publishedPaths: entry.publishedPaths
  }));
  const configurationVersion = configuration.configurationVersion || null;
  return {
    enabled: true,
    readable: true,
    writable: health.writable,
    status: buildAttentionFlags(review, bodyCollisions, quarantine, auditRaceEvents, configurationVersion) ? "attention" : "ok",
    schemaVersion: doctorSchemaVersion,
    indexedFiles: review.indexedFiles,
    truncatedIndex: review.truncatedIndex,
    counts: review.counts,
    diagnostics: {
      invalidMetadata: review.invalidMetadata.map((entry) => ({
        relativePath: entry.relativePath,
        fields: entry.fields.map((field) => field.field)
      })),
      softExpired: review.expiredNotes.map((entry) => entry.relativePath),
      quarantine: quarantine.notes,
      quarantineScanErrorCount: quarantine.scanErrorCount,
      hashIntegrity: {
        bodyCollisions,
        auditRaceEvents: auditRaceEvents.events.length,
        auditEventHashes: auditRaceEvents.events.map((entry) => entry.noteIdHash),
        auditReadError: auditRaceEvents.error
      },
      versionCompatibility: {
        configuration: configurationVersion,
        expectedActive: currentConfigurationVersion,
        compatible: Boolean(configurationVersion && configurationVersion.active === currentConfigurationVersion)
      }
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const configuration = loadConfiguration();
  console.log(JSON.stringify(buildMemoryDoctorReport(configuration), null, 2));
}
