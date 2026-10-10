import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { containsSecretLikeValue } from "./disposable-workspace.js";

export const parallelArtifactSchemaVersion = 1;

export function sliceByUtf8Bytes(content, cursorBytes, maxBytes) {
  const totalBytes = Buffer.byteLength(content, "utf8");
  if (!Number.isInteger(cursorBytes) || cursorBytes < 0 || cursorBytes > totalBytes) return { content: "", nextCursor: null, startBytes: 0 };
  let currentBytes = 0;
  let startIndex = 0;
  while (startIndex < content.length && currentBytes < cursorBytes) {
    const codePoint = content.codePointAt(startIndex);
    const character = String.fromCodePoint(codePoint);
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (currentBytes + characterBytes > cursorBytes) break;
    currentBytes += characterBytes;
    startIndex += character.length;
  }
  let sliceBytes = 0;
  let endIndex = startIndex;
  while (endIndex < content.length && sliceBytes < maxBytes) {
    const codePoint = content.codePointAt(endIndex);
    const character = String.fromCodePoint(codePoint);
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (sliceBytes + characterBytes > maxBytes) break;
    sliceBytes += characterBytes;
    endIndex += character.length;
  }
  const nextCursor = endIndex >= content.length ? null : currentBytes + sliceBytes;
  return { content: content.slice(startIndex, endIndex), nextCursor, startBytes: currentBytes };
}

function readArtifactFile(filePath) {
  try {
    const status = fs.lstatSync(filePath);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed?.schemaVersion !== parallelArtifactSchemaVersion || typeof parsed?.content !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createParallelArtifactStore({ rootDirectory, ttlMs, maxArtifactBytes, maxTotalBytes, now = () => Date.now() } = {}) {
  if (!rootDirectory) throw new Error("parallel artifact root directory is required");
  const artifactTtlMs = Number.isInteger(ttlMs) && ttlMs > 0 ? ttlMs : 86400000;
  const artifactMaxBytes = Number.isInteger(maxArtifactBytes) && maxArtifactBytes > 0 ? maxArtifactBytes : 1048576;
  const artifactTotalBytes = Number.isInteger(maxTotalBytes) && maxTotalBytes > 0 ? maxTotalBytes : 52428800;
  const storeDirectory = rootDirectory;

  function ensureDirectory() {
    fs.mkdirSync(storeDirectory, { recursive: true });
  }

  function artifactPath(detailRef) {
    return path.join(storeDirectory, `${detailRef}.json`);
  }

  function listArtifacts() {
    try {
      return fs.readdirSync(storeDirectory)
        .filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))
        .map((entry) => path.join(storeDirectory, entry));
    } catch {
      return [];
    }
  }

  function totalArtifactBytes() {
    let total = 0;
    for (const filePath of listArtifacts()) {
      try {
        total += fs.statSync(filePath).size;
      } catch {
      }
    }
    return total;
  }

  function sweep() {
    ensureDirectory();
    const currentTime = now();
    let removed = 0;
    for (const filePath of listArtifacts()) {
      const parsed = readArtifactFile(filePath);
      const expiresAt = parsed?.expiresAt ? Date.parse(parsed.expiresAt) : NaN;
      if (!parsed || (Number.isFinite(expiresAt) && expiresAt <= currentTime)) {
        try {
          fs.rmSync(filePath, { force: true });
          removed += 1;
        } catch {
        }
      }
    }
    return removed;
  }

  function store({ callerHash, workspaceHash, batchIdHash, taskIdHash, content, contentType = "application/json" }) {
    if (typeof callerHash !== "string" || typeof workspaceHash !== "string" || typeof batchIdHash !== "string" || typeof taskIdHash !== "string") {
      return { stored: false, reason: "artifact_binding_invalid" };
    }
    const serialized = typeof content === "string" ? content : JSON.stringify(content);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > artifactMaxBytes) return { stored: false, reason: "artifact_too_large", bytes };
    if (containsSecretLikeValue(serialized)) return { stored: false, reason: "secret_detected", bytes };
    ensureDirectory();
    sweep();
    if (totalArtifactBytes() + bytes > artifactTotalBytes) return { stored: false, reason: "artifact_quota_exceeded", bytes };
    const detailRef = crypto.createHash("sha256")
      .update(crypto.randomBytes(32))
      .update(serialized)
      .digest("hex");
    const createdAt = new Date(now()).toISOString();
    const envelope = {
      schemaVersion: parallelArtifactSchemaVersion,
      detailRef,
      createdAt,
      expiresAt: new Date(now() + artifactTtlMs).toISOString(),
      callerHash,
      workspaceHash,
      batchIdHash,
      taskIdHash,
      contentType,
      bytes,
      sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
      content: serialized
    };
    const targetPath = artifactPath(detailRef);
    const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 384 });
    fs.renameSync(temporaryPath, targetPath);
    return { stored: true, detailRef, bytes, expiresAt: envelope.expiresAt };
  }

  function read({ detailRef, callerHash, workspaceHash, batchIdHash, taskIdHash, cursor = 0, maxBytes = 16384 }) {
    if (typeof detailRef !== "string" || !/^[a-f0-9]{64}$/.test(detailRef)) return { ok: false, reason: "artifact_ref_invalid" };
    const filePath = artifactPath(detailRef);
    const parsed = readArtifactFile(filePath);
    if (!parsed) return { ok: false, reason: "artifact_not_found" };
    const expiresAtMs = parsed.expiresAt ? Date.parse(parsed.expiresAt) : NaN;
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= now()) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
      }
      return { ok: false, reason: "artifact_expired" };
    }
    if (parsed.callerHash !== callerHash || parsed.workspaceHash !== workspaceHash || parsed.batchIdHash !== batchIdHash || parsed.taskIdHash !== taskIdHash) {
      return { ok: false, reason: "artifact_unauthorized" };
    }
    const totalBytes = Buffer.byteLength(parsed.content, "utf8");
    const page = sliceByUtf8Bytes(parsed.content, cursor, maxBytes);
    return {
      ok: true,
      content: page.content,
      cursor,
      nextCursor: page.nextCursor,
      totalBytes,
      expiresAt: parsed.expiresAt ?? null
    };
  }

  return { store, read, sweep, totalArtifactBytes };
}
