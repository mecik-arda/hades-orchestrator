import crypto from "node:crypto";
import { z } from "zod";

const MAX_EXCERPTS = 5;
const MAX_EXCERPT_CHARACTERS = 500;
const MAX_TOTAL_EXCERPT_CHARACTERS = 2000;
const sensitiveQueryNamePattern = /(?:^|_)(?:token|key|secret|password|passwd|pass|auth|authorization|signature|sig|session|cookie|credential|jwt|code|ticket|assertion|nonce|state)(?:_|$)/i;
const sensitiveCompactNamePattern = /^(?:api|access|refresh|id|auth|client|bearer|session)(?:token|key|secret|password|passwd|pass|assertion|code|id)$|^authorization(?:code|token|key)$/i;
const activeMarkupPattern = /<\s*(?:script|style|iframe|object|embed|form|svg|math)\b|\bon[a-z]+\s*=/i;
const markupPattern = /<\/?[a-z][^>]*>|<!--|<!doctype|<!\[cdata\[/i;
const disallowedUrlCharacterPattern = /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\u202A-\u202E\u2060-\u2064\u2066-\u2069\u00AD\u034F\u061C\u180E\uFEFF]/u;
const excerptSecretPatterns = [
  /-----BEGIN[\s\S]{0,80}PRIVATE[\s\S]{0,20}KEY-----/i,
  /\b(?:api[\s_-]*key|client[\s_-]*secret|private[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|authorization|proxy[\s_-]*authorization|token|password|passwd|secret|cookie|set[\s_-]*cookie)\s*[:=]\s*\S+/i,
  /\bbearer\s+\S+/i,
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_=-]{8,}/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/i,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/i,
  /\b(?:ya29\.[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:sk|rk)[_-](?:live|test|proj)[-_][A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|dop_v1_[A-Za-z0-9_-]{16,})\b/i
];
const httpUrlPattern = /https?\s*:\s*\/\s*\/\s*\S+/i;
const webIntentPromptPattern = /https?:\/\/|\bread_url\b|\bweb\b|\binternet\b|\bonline\b|\bsearch\b|\bresearch\b|\bbrowse\b|araştır|arastir|güncel|guncel|haber|fiyat|kaynak|atıf|citation|today|latest/i;
const webIntentOutputPattern = /(?:^|\n)\s*(?:\[\d+\]|\d+[.)])\s*(?:kaynak|source)|kayna[ğg]a göre|according to|retrieved from|accessed on|\bdoi:|\bwww\./i;

const sourceUrlHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const confidenceSchema = z.literal("low");
const verificationStatusSchema = z.literal("unverified");
const webEvidenceInputSchema = z.object({
  sourceUrl: z.string().min(1),
  retrievedAt: z.string().datetime().optional(),
  excerpts: z.array(z.string()).min(1).max(MAX_EXCERPTS),
  confidence: z.string().optional(),
  verificationStatus: z.string().optional()
}).strict();
export const providerWebEvidenceCarrierSchema = z.object({
  result: z.string().min(1),
  webEvidence: webEvidenceInputSchema.nullable()
}).strict();
const excerptSchema = z.string().min(1).max(MAX_EXCERPT_CHARACTERS).refine(
  (value) => value.trim().length > 0 && value === value.normalize("NFC") && !activeMarkupPattern.test(value) && !markupPattern.test(value) && !hasDisallowedExcerptCharacter(value) && !hasSecretLikeExcerpt(value),
  "web evidence excerpt rejected"
);
const excerptsSchema = z.array(excerptSchema).min(1).max(MAX_EXCERPTS).superRefine((excerpts, context) => {
  if (excerpts.reduce((total, excerpt) => total + excerpt.length, 0) > MAX_TOTAL_EXCERPT_CHARACTERS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "web evidence excerpts rejected" });
  }
});

export const webEvidenceEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  evidenceSourceType: z.literal("untrusted_web"),
  sourceUrlHash: sourceUrlHashSchema,
  retrievedAt: z.string().datetime(),
  excerpts: excerptsSchema,
  confidence: confidenceSchema,
  verificationStatus: verificationStatusSchema,
  contentTrust: z.literal("untrusted"),
  quarantineStatus: z.literal("quarantined")
}).strict();

function canonicalizeSourceUrl(sourceUrl) {
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) throw new Error("invalid web evidence source URL");
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("invalid web evidence source URL");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("web evidence source URL rejected");
  }
  for (const [name, value] of parsed.searchParams.entries()) {
    const decodedValue = decodeUrlComponentBounded(value);
    if (isSensitiveParameterName(name) || containsSensitiveWebValue(decodedValue)) throw new Error("web evidence source URL rejected");
  }
  const decodedPath = decodeUrlComponentBounded(parsed.pathname);
  if (containsSensitiveWebValue(decodedPath)) throw new Error("web evidence source URL rejected");
  if (containsSensitiveFragment(parsed.hash)) throw new Error("web evidence source URL rejected");
  return parsed.toString();
}

function isSensitiveParameterName(name) {
  const normalized = decodeUrlComponentBounded(String(name)).normalize("NFC")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLocaleLowerCase("en-US");
  return sensitiveQueryNamePattern.test(normalized) || sensitiveCompactNamePattern.test(normalized);
}

function containsSensitiveFragment(fragment) {
  const decoded = decodeUrlComponentBounded(fragment);
  if (containsSensitiveWebValue(decoded)) return true;
  return decoded.split(/[?&#]/).some((part) => isSensitiveParameterName(part.split("=", 1)[0]));
}

function decodeUrlComponentBounded(value) {
  let decoded = value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (disallowedUrlCharacterPattern.test(decoded)) throw new Error("web evidence source URL rejected");
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new Error("web evidence source URL rejected");
    }
    if (disallowedUrlCharacterPattern.test(next)) throw new Error("web evidence source URL rejected");
    if (next === decoded) return decoded;
    decoded = next;
  }
  throw new Error("web evidence source URL rejected");
}

function hasDisallowedExcerptCharacter(value) {
  for (const character of value) {
    if (character === "\t" || character === "\n" || character === "\r") continue;
    if (/\p{Cc}|\p{Cf}/u.test(character)) return true;
  }
  return false;
}

function hasSecretLikeExcerpt(value) {
  return containsSensitiveWebValue(value);
}

export function containsHttpUrl(value) {
  return textVariants(value).some((variant) => hasMalformedPercentEncoding(variant) || httpUrlPattern.test(variant));
}

export function containsWebMarkup(value) {
  return textVariants(value).some((variant) => markupPattern.test(variant) || activeMarkupPattern.test(variant));
}

export function detectWebIntent(prompt, resultText) {
  const promptSuggestsWeb = typeof prompt === "string" && webIntentPromptPattern.test(prompt);
  const outputSuggestsWeb = typeof resultText === "string" && webIntentOutputPattern.test(resultText);
  return promptSuggestsWeb || outputSuggestsWeb;
}

export function containsSensitiveWebValue(value) {
  return textVariants(value).some((variant) => hasMalformedPercentEncoding(variant) || excerptSecretPatterns.some((pattern) => pattern.test(variant)));
}

function textVariants(value) {
  if (typeof value !== "string") return [];
  const queue = [value];
  const variants = new Set();
  while (queue.length > 0 && variants.size < 16) {
    const current = queue.shift();
    if (variants.has(current)) continue;
    variants.add(current);
    for (const normalized of [current.normalize("NFC"), current.normalize("NFKC")]) {
      if (!variants.has(normalized)) queue.push(normalized);
    }
    if (/%[0-9a-f]{2}/i.test(current)) {
      const decoded = current.replace(/(?:%[0-9a-f]{2})+/gi, (encodedRun) => {
        try {
          return decodeURIComponent(encodedRun);
        } catch {
          return encodedRun;
        }
      });
      if (decoded !== current && !variants.has(decoded)) queue.push(decoded);
    }
  }
  return [...variants];
}

function hasMalformedPercentEncoding(value) {
  return /%(?![0-9a-f]{2})/i.test(value);
}

function hashSourceUrl(sourceUrl) {
  return crypto.createHash("sha256").update(canonicalizeSourceUrl(sourceUrl), "utf8").digest("hex");
}

function sanitizeExcerpt(value) {
  if (typeof value !== "string") throw new Error("web evidence excerpt must be text");
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > MAX_EXCERPT_CHARACTERS || activeMarkupPattern.test(normalized) || markupPattern.test(normalized) || hasDisallowedExcerptCharacter(normalized) || hasSecretLikeExcerpt(normalized) || containsHttpUrl(normalized)) {
    throw new Error("web evidence excerpt rejected");
  }
  return normalized;
}

function sanitizeExcerpts(excerpts) {
  if (!Array.isArray(excerpts) || excerpts.length === 0 || excerpts.length > MAX_EXCERPTS) {
    throw new Error("web evidence excerpts rejected");
  }
  const sanitized = excerpts.map(sanitizeExcerpt);
  if (sanitized.reduce((total, excerpt) => total + excerpt.length, 0) > MAX_TOTAL_EXCERPT_CHARACTERS) {
    throw new Error("web evidence excerpts rejected");
  }
  const joinedValues = ["", " ", "\n"].map((separator) => sanitized.join(separator));
  if (joinedValues.some((joined) => containsHttpUrl(joined) || containsSensitiveWebValue(joined))) throw new Error("web evidence excerpts rejected");
  return sanitized;
}

export function createUntrustedWebEvidenceEnvelope(input) {
  const inputValidation = webEvidenceInputSchema.safeParse(input);
  if (!inputValidation.success) {
    if (inputValidation.error.issues.some((issue) => issue.path[0] === "excerpts")) throw new Error("web evidence excerpts rejected");
    throw new Error("web evidence input rejected");
  }
  const { sourceUrl, excerpts, confidence, verificationStatus } = inputValidation.data;
  if ((confidence ?? "low") !== "low" || (verificationStatus ?? "unverified") !== "unverified") {
    throw new Error("web evidence verification is host controlled");
  }
  const envelope = {
    schemaVersion: 1,
    evidenceSourceType: "untrusted_web",
    sourceUrlHash: hashSourceUrl(sourceUrl),
    retrievedAt: inputValidation.data.retrievedAt || new Date().toISOString(),
    excerpts: sanitizeExcerpts(excerpts),
    confidence: "low",
    verificationStatus: "unverified",
    contentTrust: "untrusted",
    quarantineStatus: "quarantined"
  };
  return webEvidenceEnvelopeSchema.parse(envelope);
}

export function validateUntrustedWebEvidence(value) {
  return webEvidenceEnvelopeSchema.safeParse(value);
}

export function normalizeUntrustedWebEvidence(value) {
  const inputValidation = webEvidenceInputSchema.safeParse(value);
  if (!inputValidation.success) throw new Error("web evidence input rejected");
  return createUntrustedWebEvidenceEnvelope(inputValidation.data);
}
