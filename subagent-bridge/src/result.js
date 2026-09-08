import { z } from "zod";

const confidenceSchema = z.enum(["high", "medium", "low"]);

export const deepSeekResultSchema = z.object({
  status: z.enum(["completed", "needs_context", "blocked", "failed"]),
  summary: z.string().min(1).max(30000),
  findings: z.array(z.object({
    title: z.string().min(1).max(1000),
    evidence: z.string().min(1).max(12000),
    impact: z.string().min(1).max(12000),
    recommendation: z.string().min(1).max(12000),
    confidence: confidenceSchema
  }).strict()).max(100),
  proposed_steps: z.array(z.string().min(1).max(4000)).max(100),
  risks: z.array(z.string().min(1).max(4000)).max(100),
  questions: z.array(z.string().min(1).max(4000)).max(100),
  requires_human_approval: z.boolean()
}).strict();

export function validateDeepSeekResult(value) {
  return deepSeekResultSchema.safeParse(value);
}

export function createFailureResult(summary) {
  return {
    status: "failed",
    summary,
    findings: [],
    proposed_steps: [],
    risks: [],
    questions: [],
    requires_human_approval: false
  };
}

function extractJsonCandidates(raw) {
  const candidates = [];
  const fencedMatches = raw.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
  for (const match of fencedMatches) {
    candidates.push(match[1].trim());
  }
  const braceBlocks = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (raw[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        braceBlocks.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (const block of braceBlocks.reverse()) {
    candidates.push(block);
  }
  return [...new Set([raw.trim(), ...candidates])];
}

function repairJsonText(text) {
  let repaired = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  repaired = repaired.replace(/,(\s*[}\]])/g, "$1");
  repaired = repaired.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*:)/g, "$1\"$2\"$3");
  repaired = repaired.replace(/'/g, "\"");
  return repaired;
}

function tryParseWithRepair(candidate) {
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch {
  }
  const repaired = repairJsonText(candidate);
  try {
    return { ok: true, value: JSON.parse(repaired) };
  } catch {
  }
  return { ok: false, error: null };
}

export function parseDeepSeekEnvelope(stdout) {
  if (!stdout || !stdout.trim()) {
    return { ok: false, errorClass: "empty_output", envelope: null };
  }
  const candidates = extractJsonCandidates(stdout);
  for (const candidate of candidates) {
    if (candidate.length < 2) continue;
    const parseResult = tryParseWithRepair(candidate);
    if (!parseResult.ok) continue;
    const envelope = parseResult.value;
    const validation = validateDeepSeekResult(envelope?.structured_output || envelope);
    if (validation.success) {
      return { ok: true, envelope, result: validation.data };
    }
  }
  try {
    const firstBrute = JSON.parse(stdout.trim());
    const validation = validateDeepSeekResult(firstBrute?.structured_output || firstBrute);
    if (validation.success) {
      return { ok: true, envelope: firstBrute, result: validation.data };
    }
    return { ok: false, errorClass: "schema_invalid", envelope: firstBrute, validationIssues: validation.error.issues };
  } catch {
  }
  return { ok: false, errorClass: "output_parse_invalid", envelope: null };
}
