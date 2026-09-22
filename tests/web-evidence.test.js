import assert from "node:assert/strict";
import test from "node:test";
import {
  createUntrustedWebEvidenceEnvelope,
  validateUntrustedWebEvidence
} from "../subagent-bridge/src/web-evidence.js";
import {
  createSuccessSubagentResult,
  subagentExecutionRequestSchema,
  validateSubagentResult
} from "../subagent-bridge/src/schemas/core-schemas.js";

function validInput(overrides = {}) {
  return {
    sourceUrl: "https://Example.com/docs?b=2&a=1#section",
    retrievedAt: "2026-09-12T10:00:00.000Z",
    excerpts: ["A short untrusted excerpt."],
    confidence: "low",
    verificationStatus: "unverified",
    ...overrides
  };
}

test("WEB-01: envelope canonical URL hashi ve untrusted siniri korur", () => {
  const first = createUntrustedWebEvidenceEnvelope(validInput());
  const second = createUntrustedWebEvidenceEnvelope(validInput({ sourceUrl: "https://example.com/docs?b=2&a=1#section" }));
  const differentQueryOrder = createUntrustedWebEvidenceEnvelope(validInput({ sourceUrl: "https://example.com/docs?a=1&b=2#section" }));
  const differentFragment = createUntrustedWebEvidenceEnvelope(validInput({ sourceUrl: "https://example.com/docs?b=2&a=1#other" }));

  assert.equal(first.schemaVersion, 1);
  assert.equal(first.evidenceSourceType, "untrusted_web");
  assert.equal(first.contentTrust, "untrusted");
  assert.equal(first.quarantineStatus, "quarantined");
  assert.equal(first.sourceUrlHash, second.sourceUrlHash);
  assert.notEqual(first.sourceUrlHash, differentQueryOrder.sourceUrlHash);
  assert.notEqual(first.sourceUrlHash, differentFragment.sourceUrlHash);
  assert.equal(JSON.stringify(first).includes("example.com"), false);
  assert.equal(validateUntrustedWebEvidence(first).success, true);
});

test("WEB-01b: meşru query adları hassas compact eşleşmeyle reddedilmez", () => {
  for (const name of ["author", "passage", "monkey", "zipcode", "statement"]) {
    assert.doesNotThrow(() => createUntrustedWebEvidenceEnvelope(validInput({ sourceUrl: `https://example.com/docs?${name}=public` })));
  }
});

test("WEB-02: credential ve hassas query URL'leri reddedilir", () => {
  for (const sourceUrl of [
    "https://user:password@example.com/docs",
    "https://example.com/docs?access_token=secret",
    "https://example.com/docs?apiKey=secret",
    "https://example.com/docs?sig=secret",
    "https://example.com/docs?jwt=secret",
    "https://example.com/docs?client_assertion=secret",
    "https://example.com/docs#access_token=secret",
    "https://example.com/docs?api%256b%2565%2579=secret",
    "https://example.com/docs?accesstoken=secret",
    "https://example.com/docs?authkey=secret",
    "https://example.com/docs?auth[token]=secret",
    "https://example.com/docs?client.secret=secret",
    "https://example.com/docs?clientpassword=secret",
    "https://example.com/docs?bearertoken=secret",
    "https://example.com/docs?name=%ZZ",
    "https://example.com/docs?safe%25E2%2580%258B=secret",
    "https://example.com/docs#%2561ccess_token=secret",
    "https://example.com/docs#safe%25E2%2580%258B=1",
    "https://example.com/docs#clientpassword=secret",
    "https://example.com/docs?note=AKIAIOSFODNN7EXAMPLE",
    "https://example.com/docs?note=%41%4B%49%41%49%4F%53%46%4F%44%4E%4E%37%45%58%41%4D%50%4C%45",
    "https://example.com/docs#note=glpat-abcdefghijklmnop",
    "https://example.com/docs/AKIAIOSFODNN7EXAMPLE",
    "https://example.com/docs/%41%4B%49%41%49%4F%53%46%4F%44%4E%4E%37%45%58%41%4D%50%4C%45",
    "ftp://example.com/docs",
    "not a url"
  ]) {
    assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ sourceUrl })), /web evidence source URL|invalid/);
  }
});

test("WEB-03: excerpt sinirlari ve aktif markup karantinasi uygulanir", () => {
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: [] })), /excerpts rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: Array.from({ length: 6 }, () => "x") })), /excerpts rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["x".repeat(501)] })), /excerpt rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["<script>alert(1)</script>"] })), /excerpt rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["safe\u0000 text"] })), /excerpt rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["bidi\u202E text"] })), /excerpt rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["zero\u200Bwidth text"] })), /excerpt rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["soft\u00ADhyphen text"] })), /excerpt rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["arabic\u061Cmark text"] })), /excerpt rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["Source: https://example.com/docs"] })), /excerpt rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["xhttps://example.com/docs"] })), /excerpt rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["https%3A%2F%2Fexample.com/docs"] })), /excerpt rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["https%3A%2F%2Fexample.com/docs/%ZZ"] })), /excerpt rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["-----BEGIN PRIVATE KEY-----"] })), /excerpt rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["-----BEGIN PRIVATE", " KEY-----"] })), /excerpts rejected/);
  for (const excerpt of [
    "Authorization: Bearer abcdefghijklmnop",
    "Cookie: session=abcdefghijklmnop",
    "api_key=abcdefghijklmnop",
    "Bearer abcdefghijklmnop",
    "token: x",
    "password=x",
    "API key: x",
    "private-key = x",
    "Cookie= x",
    "Authorization= x",
    "Bearer x",
    "AKIAIOSFODNN7EXAMPLE",
    "ASIAIOSFODNN7EXAMPLE",
    "sk-proj-abcdefghijklmnop",
    "glpat-abcdefghijklmnop",
    "xoxb-abcdefghijklmnop",
    "ya29.abcdefghijklmnopqrst"
  ]) {
    assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: [excerpt] })), /excerpt rejected/);
  }
  for (const excerpt of [
    "Bearer%20abcdefghijklmnop",
    "%41%4B%49%41%49%4F%53%46%4F%44%4E%4E%37%45%58%41%4D%50%4C%45"
  ]) {
    assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: [excerpt] })), /excerpt rejected/);
  }
  for (const excerpt of [
    "npm_abcdefghijklmnopqrst",
    "pypi-abcdefghijklmnopqrst",
    "hf_abcdefghijklmnopqrst"
  ]) {
    assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: [excerpt] })), /excerpt rejected/);
  }
  for (const excerpt of [
    "npm-installation-guide",
    "hf-transformers-model",
    "pypi-package-index"
  ]) {
    assert.doesNotThrow(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: [excerpt] })));
  }
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["https:/", "/example.com/source"] })), /excerpts? rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["https:", "//example.com/source"] })), /excerpts? rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["AKIAIOSFODNN7", "EXAMPLE"] })), /excerpts rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: ["Bearer", "abcdefghijklmnop"] })), /excerpts rejected/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ excerpts: Array.from({ length: 5 }, () => "x".repeat(500)) })), /excerpts rejected/);
  const validEnvelope = createUntrustedWebEvidenceEnvelope(validInput());
  assert.equal(validateUntrustedWebEvidence({ ...validEnvelope, excerpts: ["<script>alert(1)</script>"] }).success, false);
  assert.equal(validateUntrustedWebEvidence({ ...validEnvelope, excerpts: Array.from({ length: 5 }, () => "x".repeat(500)) }).success, false);
  assert.equal(validateUntrustedWebEvidence({ ...validEnvelope, excerpts: ["N\u0303"] }).success, false);
  assert.equal(validateUntrustedWebEvidence({ ...validEnvelope, confidence: "high" }).success, false);
  assert.equal(validateUntrustedWebEvidence({ ...validEnvelope, verificationStatus: "verified" }).success, false);
  assert.equal(validateUntrustedWebEvidence({ ...validEnvelope, excerpts: ["   "] }).success, false);
  assert.equal(validateUntrustedWebEvidence({ ...validEnvelope, excerpts: ["Cookie: session=abcdefghijklmnop"] }).success, false);
  assert.equal(validateUntrustedWebEvidence({ ...validEnvelope, webEvidence: null }).success, false);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ confidence: "high" })), /host controlled/);
  assert.throws(() => createUntrustedWebEvidenceEnvelope(validInput({ verificationStatus: "verified" })), /host controlled/);
});

test("WEB-04: envelope unknown ve yetki alanlarini kabul etmez", () => {
  const envelope = createUntrustedWebEvidenceEnvelope(validInput());
  for (const field of ["tool", "model", "permission", "fallback", "edit", "command"]) {
    assert.equal(validateUntrustedWebEvidence({ ...envelope, [field]: true }).success, false);
  }
  assert.equal(validateUntrustedWebEvidence({ ...envelope, extra: true }).success, false);
});

test("WEB-05: subagent sonucu webEvidence'i pasif optional alan olarak kabul eder", () => {
  const webEvidence = createUntrustedWebEvidenceEnvelope(validInput());
  const result = createSuccessSubagentResult("antigravity", "gemini-3.8-flash-high", {
    result: "advisory result",
    webEvidence
  });
  const validation = validateSubagentResult(result);

  assert.equal(validation.success, true);
  assert.deepEqual(validation.data.webEvidence, webEvidence);
  assert.equal(Object.hasOwn(validation.data.webEvidence, "tool"), false);
  assert.equal(Object.hasOwn(validation.data.webEvidence, "model"), false);
  assert.equal(Object.hasOwn(validation.data.webEvidence, "permission"), false);
  assert.equal(Object.hasOwn(validation.data.webEvidence, "fallback"), false);
  assert.equal(Object.hasOwn(validation.data.webEvidence, "edit"), false);
  assert.equal(subagentExecutionRequestSchema.safeParse({
    executionId: "execution",
    backend: "antigravity",
    prompt: "read only",
    model: "gemini-3.8-flash-high",
    mode: "read_only",
    workspace: "C:\\workspace",
    delegationDepth: 0,
    caller: "openCode",
    timeoutMs: 10000,
    webEvidence
  }).success, false);
});

test("WEB-06: core result alt nesnelerinde bilinmeyen alanlar kabul edilmez", () => {
  const webEvidence = createUntrustedWebEvidenceEnvelope(validInput());
  const result = createSuccessSubagentResult("antigravity", "gemini-3.8-flash-high", { webEvidence });

  assert.equal(validateSubagentResult({ ...result, metrics: { ...result.metrics, tool: "read_url" } }).success, false);
  assert.equal(validateSubagentResult({ ...result, artifacts: { summary: "safe", command: "rm -rf" } }).success, false);
  assert.equal(validateSubagentResult({ ...result, webEvidence: null }).success, true);
  assert.equal(validateSubagentResult({ ...result, metrics: { ...result.metrics, fallbacks: 1 } }).success, true);
  assert.equal(Object.hasOwn(createSuccessSubagentResult("antigravity", "gemini-3.8-flash-high"), "webEvidence"), false);
  assert.equal(Object.hasOwn(createSuccessSubagentResult("antigravity", "gemini-3.8-flash-high", { webEvidence: null }), "webEvidence"), true);
});

test("WEB-07: containsWebMarkup etkin etiketleri yakalar ve mesru metni yanlis isaretlemez", async () => {
  const { containsWebMarkup } = await import("../subagent-bridge/src/web-evidence.js");
  assert.equal(containsWebMarkup("<script>alert(1)</script>"), true);
  assert.equal(containsWebMarkup(">img onerror=alert(1)<"), true);
  assert.equal(containsWebMarkup("<![CDATA[payload]]>"), true);
  assert.equal(containsWebMarkup("synchronize=true and monolithic=false"), false);
  assert.equal(containsWebMarkup("plain analysis of local files"), false);
});

test("WEB-08: detectWebIntent web niyetini ve atif kaliplarini yakalar", async () => {
  const { detectWebIntent } = await import("../subagent-bridge/src/web-evidence.js");
  assert.equal(detectWebIntent("Güncel fiyatı araştır", "plain summary"), true);
  assert.equal(detectWebIntent("Research this online", "plain summary"), true);
  assert.equal(detectWebIntent("Browse the internet for sources", "plain summary"), true);
  assert.equal(detectWebIntent("Inspect local files and summarize", "plain summary"), false);
  assert.equal(detectWebIntent("inspect the current implementation", "plain summary"), false);
  assert.equal(detectWebIntent("Inspect local files", "Kaynağa göre özet: sentetik"), true);
  assert.equal(detectWebIntent("Inspect local files", "1. source: example.org"), true);
  assert.equal(detectWebIntent("kaynak dosyayı incele ve özetle", "plain summary"), false);
  assert.equal(detectWebIntent("kaynak kodunu analiz et", "plain summary"), false);
  assert.equal(detectWebIntent("kaynak bul", "plain summary"), true);
  assert.equal(detectWebIntent("kaynakları göster", "plain summary"), true);
  assert.equal(detectWebIntent("Google'da doğrula", "plain summary"), true);
  assert.equal(detectWebIntent("bu siteyi incele", "plain summary"), true);
  assert.equal(detectWebIntent("sayfadaki bilgiyi kontrol et", "plain summary"), true);
});
