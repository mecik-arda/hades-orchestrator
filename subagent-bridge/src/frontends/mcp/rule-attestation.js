import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hasSecretLikeContent } from "../../memory.js";

export const RULE_ATTESTATION_URI = "hades://rules/attestation/v1";
export const RULE_ATTESTATION_NAME = "rule-attestation-v1";
export const RULE_ATTESTATION_MIME_TYPE = "application/json";
export const RULE_ATTESTATION_CONTRACT_VERSION = "1";
export const RULE_ATTESTATION_BYTE_CONTRACT = "raw_utf8_file_bytes";
export const RULE_ATTESTATION_MAX_FILE_BYTES = 256 * 1024;
export const RULE_ATTESTATION_MAX_TOTAL_BYTES = 768 * 1024;

const ruleEntries = [
  { id: "agents", path: "AGENTS.md" },
  { id: "claude", path: "CLAUDE.md" },
  { id: "agent-rules", path: "config/agent-rules.md" }
];

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const manifestEntrySchema = z.object({
  sizeBytes: z.number().int().nonnegative(),
  sha256: hashSchema
}).strict();

export const ruleAttestationSchema = z.object({
  contractVersion: z.literal(RULE_ATTESTATION_CONTRACT_VERSION),
  status: z.literal("verified"),
  sourceClass: z.literal("mcp_resource"),
  comparison: z.enum(["match", "mismatch", "unavailable"]),
  hashAlgorithm: z.literal("sha256"),
  byteContract: z.literal(RULE_ATTESTATION_BYTE_CONTRACT),
  manifestSha256: hashSchema,
  entries: z.tuple([
    manifestEntrySchema.extend({ id: z.literal("agents"), path: z.literal("AGENTS.md") }),
    manifestEntrySchema.extend({ id: z.literal("claude"), path: z.literal("CLAUDE.md") }),
    manifestEntrySchema.extend({ id: z.literal("agent-rules"), path: z.literal("config/agent-rules.md") })
  ]),
  evidence: z.object({
    workspace_file: z.object({
      status: z.literal("verified"),
      manifestSha256: hashSchema
    }).strict(),
    startup_context: z.object({
      status: z.literal("unavailable")
    }).strict(),
    mcp_resource: z.object({
      status: z.literal("verified"),
      manifestSha256: hashSchema
    }).strict()
  }).strict()
}).strict();

export class RuleAttestationError extends Error {
  constructor(code) {
    super(code);
    this.name = "RuleAttestationError";
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedPath(value) {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isSamePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function isSameIdentity(left, right) {
  const sameOptional = (key) => left[key] === 0 || right[key] === 0 || left[key] === right[key];
  return sameOptional("dev") && sameOptional("ino") && left.size === right.size && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function assertSafePathComponents(rootPath, candidatePath) {
  const relativePath = path.relative(rootPath, candidatePath);
  let currentPath = rootPath;
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const status = fs.lstatSync(currentPath);
    if (status.isSymbolicLink()) throw new RuleAttestationError("rule_attestation_unsafe_file");
  }
}

function readRuleFile(rootPath, relativePath) {
  const candidatePath = path.resolve(rootPath, relativePath);
  const resolvedRelativePath = path.relative(rootPath, candidatePath);
  if (!resolvedRelativePath || resolvedRelativePath.startsWith(".." + path.sep) || path.isAbsolute(resolvedRelativePath)) {
    throw new RuleAttestationError("rule_attestation_unsafe_file");
  }
  const rootRealPath = fs.realpathSync(rootPath);
  const candidateRealPath = fs.realpathSync(candidatePath);
  if (!isSamePath(candidateRealPath, candidatePath) || !isSamePath(rootRealPath, rootPath)) {
    throw new RuleAttestationError("rule_attestation_unsafe_file");
  }
  assertSafePathComponents(rootPath, candidatePath);
  const before = fs.lstatSync(candidatePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > RULE_ATTESTATION_MAX_FILE_BYTES) {
    throw new RuleAttestationError("rule_attestation_unsafe_file");
  }
  const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(candidatePath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !isSameIdentity(before, opened)) {
      throw new RuleAttestationError("rule_attestation_mutation");
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytesRead <= 0) throw new RuleAttestationError("rule_attestation_mutation");
      offset += bytesRead;
    }
    const after = fs.fstatSync(descriptor);
    if (!isSameIdentity(opened, after)) throw new RuleAttestationError("rule_attestation_mutation");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new RuleAttestationError("rule_attestation_invalid_encoding");
    }
    if (text.includes("\u0000") || hasSecretLikeContent(text)) {
      throw new RuleAttestationError("unsafe_rule_content");
    }
    return { sizeBytes: buffer.length, sha256: sha256(buffer) };
  } catch (error) {
    if (error instanceof RuleAttestationError) throw error;
    throw new RuleAttestationError("rule_attestation_unavailable");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function createManifest(rootPath) {
  let totalBytes = 0;
  const entries = ruleEntries.map((entry) => {
    const result = readRuleFile(rootPath, entry.path);
    totalBytes += result.sizeBytes;
    if (totalBytes > RULE_ATTESTATION_MAX_TOTAL_BYTES) {
      throw new RuleAttestationError("rule_attestation_too_large");
    }
    return { ...entry, ...result };
  });
  const core = {
    contractVersion: RULE_ATTESTATION_CONTRACT_VERSION,
    hashAlgorithm: "sha256",
    byteContract: RULE_ATTESTATION_BYTE_CONTRACT,
    entries
  };
  return { core, manifestSha256: sha256(canonicalizeJson(core)) };
}

export function calculateRuleManifestSha256(core) {
  return sha256(canonicalizeJson(core));
}

export function createRuleAttestation(trustedWorkspace) {
  try {
    const rootPath = fs.realpathSync(trustedWorkspace);
    const rootStatus = fs.lstatSync(rootPath);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) throw new RuleAttestationError("rule_attestation_unsafe_workspace");
    const { core, manifestSha256 } = createManifest(rootPath);
    const result = {
      ...core,
      status: "verified",
      sourceClass: "mcp_resource",
      comparison: "match",
      manifestSha256,
      evidence: {
        workspace_file: { status: "verified", manifestSha256 },
        startup_context: { status: "unavailable" },
        mcp_resource: { status: "verified", manifestSha256 }
      }
    };
    return ruleAttestationSchema.parse(result);
  } catch (error) {
    if (error instanceof RuleAttestationError) throw error;
    throw new RuleAttestationError("rule_attestation_unavailable");
  }
}
