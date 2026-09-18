import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyRuntimeStateSchemaVersion, isCompatibleClassifiedVersion, runtimeStateSchemaVersion } from "./version-contract.js";

export const runtimeStateMigrationId = "state-layout-v0-to-v1";

function migrationDirectory(stateRoot) {
  return path.join(stateRoot, "migrations");
}

function manifestPath(stateRoot) {
  return path.join(migrationDirectory(stateRoot), `${runtimeStateMigrationId}.json`);
}

function lockPath(stateRoot) {
  return path.join(migrationDirectory(stateRoot), `${runtimeStateMigrationId}.lock`);
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function readManifest(stateRoot) {
  const filePath = manifestPath(stateRoot);
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "absent", manifest: null };
    return { status: "error", manifest: null };
  }
  if (stats.isSymbolicLink()) return { status: "symlink", manifest: null };
  if (!stats.isFile()) return { status: "invalid", manifest: null };
  try {
    const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (manifest?.migrationId !== runtimeStateMigrationId) return { status: "invalid", manifest: null };
    const classification = classifyRuntimeStateSchemaVersion(manifest.toVersion);
    if (classification.status === "future_incompatible") return { status: "future_incompatible", manifest: null };
    if (classification.status !== "current") return { status: "invalid", manifest: null };
    return { status: "current", manifest };
  } catch {
    return { status: "invalid", manifest: null };
  }
}

function withMigrationLock(stateRoot, callback) {
  const lockFile = lockPath(stateRoot);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const owner = { token: crypto.randomUUID(), pid: process.pid };
  const deadline = Date.now() + 5000;
  let descriptor = null;
  while (descriptor === null) {
    try {
      descriptor = fs.openSync(lockFile, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > 30000) fs.rmSync(lockFile, { force: true });
      } catch {
      }
      if (Date.now() >= deadline) throw new Error("state migration lock unavailable");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  fs.writeFileSync(descriptor, JSON.stringify(owner), "utf8");
  fs.fsyncSync(descriptor);
  try {
    return callback();
  } finally {
    fs.closeSync(descriptor);
    try {
      const current = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      if (current?.token === owner.token) fs.rmSync(lockFile, { force: true });
    } catch {
    }
  }
}

function countLegacyStateArtifacts(stateRoot) {
  const checkpointDirectory = path.join(stateRoot, "checkpoints");
  let stats;
  try {
    stats = fs.lstatSync(checkpointDirectory);
  } catch (error) {
    if (error.code === "ENOENT") return { count: 0, error: false };
    return { count: 0, error: true };
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return { count: 0, error: true };
  try {
    return { count: fs.readdirSync(checkpointDirectory).filter((entry) => entry.endsWith(".json")).length, error: false };
  } catch {
    return { count: 0, error: true };
  }
}

const windowsDirectoryOpenCodes = ["EISDIR", "EPERM", "EACCES", "UNKNOWN", "EINVAL"];

export function fsyncDirectory(directoryPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(directoryPath, "r");
  } catch (error) {
    if (process.platform === "win32" && windowsDirectoryOpenCodes.includes(error.code)) return;
    throw error;
  }
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    const unsupportedOnWindows = process.platform === "win32" && error.code === "EPERM";
    if (!["EINVAL", "ENOTSUP"].includes(error.code) && !unsupportedOnWindows) throw error;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function planRuntimeStateMigration({ stateRoot, now = new Date() }) {
  const manifest = readManifest(stateRoot);
  const stateRootExists = fs.existsSync(stateRoot);
  const requiresManifest = manifest.status === "absent" || manifest.status === "legacy_unversioned";
  const artifactScan = stateRootExists ? countLegacyStateArtifacts(stateRoot) : { count: 0, error: false };
  const failClosed = manifest.status === "symlink"
    || manifest.status === "invalid"
    || manifest.status === "future_incompatible"
    || manifest.status === "error"
    || artifactScan.error;
  return {
    migrationId: runtimeStateMigrationId,
    fromVersion: 0,
    toVersion: runtimeStateSchemaVersion,
    mode: "dry_run",
    stateRootExists,
    manifestStatus: manifest.status,
    failClosed,
    compatible: !failClosed && isCompatibleClassifiedVersion(classifyRuntimeStateSchemaVersion(manifest.manifest?.toVersion ?? null)),
    legacyArtifactCount: artifactScan.count,
    payloadRewritten: false,
    actions: failClosed ? [] : (requiresManifest ? ["write_version_manifest"] : []),
    plannedAt: now.toISOString()
  };
}

export function applyRuntimeStateMigration({ stateRoot, now = new Date() }) {
  fs.mkdirSync(stateRoot, { recursive: true });
  return withMigrationLock(stateRoot, () => {
    const plan = planRuntimeStateMigration({ stateRoot, now });
    if (plan.failClosed) return { ...plan, mode: "apply", applied: false, reason: "fail_closed" };
    if (plan.actions.length === 0) return { ...plan, mode: "apply", applied: false, reason: "already_current" };
    const preconditionHash = hashValue(`${plan.manifestStatus}:${plan.legacyArtifactCount}`);
    const manifest = {
      migrationId: runtimeStateMigrationId,
      fromVersion: 0,
      toVersion: runtimeStateSchemaVersion,
      status: "applied",
      mode: "apply",
      payloadRewritten: false,
      legacyArtifactCount: plan.legacyArtifactCount,
      preconditionHash,
      resultHash: hashValue(`${preconditionHash}:applied`),
      startedAt: plan.plannedAt,
      completedAt: new Date().toISOString()
    };
    const target = manifestPath(stateRoot);
    const temporaryPath = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporaryPath, "wx");
    try {
      fs.writeFileSync(descriptor, JSON.stringify(manifest), "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryPath, target);
    fsyncDirectory(path.dirname(target));
    return {
      migrationId: runtimeStateMigrationId,
      fromVersion: 0,
      toVersion: runtimeStateSchemaVersion,
      mode: "apply",
      stateRootExists: true,
      manifestStatus: "current",
      failClosed: false,
      compatible: true,
      legacyArtifactCount: plan.legacyArtifactCount,
      payloadRewritten: false,
      actions: ["write_version_manifest"],
      applied: true,
      manifest
    };
  });
}
