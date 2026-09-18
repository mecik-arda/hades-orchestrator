import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyRuntimeStateMigration, fsyncDirectory, planRuntimeStateMigration, runtimeStateMigrationId } from "../subagent-bridge/src/runtime-state-migration.js";

function hashTree(root) {
  if (!fs.existsSync(root)) return "absent";
  const entries = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else entries.push([path.relative(root, fullPath), crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex")]);
    }
  };
  walk(root);
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function manifestFile(stateRoot) {
  return path.join(stateRoot, "migrations", `${runtimeStateMigrationId}.json`);
}

test("STATE-MIG-01: dry-run salt okunur plan üretir ve dosya yazmaz", (context) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-mig-dry-"));
  context.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateRoot, "checkpoints"), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "checkpoints", "legacy.json"), "{}", "utf8");
  const before = hashTree(stateRoot);
  const plan = planRuntimeStateMigration({ stateRoot });
  assert.equal(plan.mode, "dry_run");
  assert.equal(plan.payloadRewritten, true);
  assert.equal(plan.failClosed, false);
  assert.deepEqual(plan.actions, ["redact_legacy_checkpoints", "write_version_manifest"]);
  assert.equal(plan.legacyArtifactCount, 1);
  assert.equal(plan.checkpointRedactionCount, 1);
  assert.equal(hashTree(stateRoot), before);
});

test("STATE-MIG-02: apply manifest yazar, ikinci çalıştırma no-op olur", (context) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-mig-apply-"));
  context.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const first = applyRuntimeStateMigration({ stateRoot });
  assert.equal(first.applied, true);
  const manifest = JSON.parse(fs.readFileSync(manifestFile(stateRoot), "utf8"));
  assert.equal(manifest.migrationId, runtimeStateMigrationId);
  assert.equal(manifest.toVersion, 1);
  assert.equal(manifest.payloadRewritten, false);
  assert.equal(JSON.stringify(manifest).includes(stateRoot), false);
  const before = hashTree(stateRoot);
  const second = applyRuntimeStateMigration({ stateRoot });
  assert.equal(second.applied, false);
  assert.equal(second.reason, "already_current");
  assert.equal(hashTree(stateRoot), before);
});

test("STATE-MIG-03: bozuk ve ileri sürümlü manifest fail-closed olur", (context) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-mig-fail-"));
  context.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateRoot, "migrations"), { recursive: true });
  fs.writeFileSync(manifestFile(stateRoot), "{bozuk}", "utf8");
  assert.equal(planRuntimeStateMigration({ stateRoot }).failClosed, true);
  assert.equal(applyRuntimeStateMigration({ stateRoot }).reason, "fail_closed");
  fs.writeFileSync(manifestFile(stateRoot), JSON.stringify({ migrationId: runtimeStateMigrationId, toVersion: 99 }), "utf8");
  const future = planRuntimeStateMigration({ stateRoot });
  assert.equal(future.failClosed, true);
  assert.equal(future.manifestStatus, "future_incompatible");
  assert.equal(applyRuntimeStateMigration({ stateRoot }).applied, false);
});

test("STATE-MIG-05: yarım kalan geçici dosya ve başlangıç kapısı", async (context) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-mig-crash-"));
  context.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateRoot, "migrations"), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "migrations", `${runtimeStateMigrationId}.json.1234-abc.tmp`), "{yarim", "utf8");
  const plan = planRuntimeStateMigration({ stateRoot });
  assert.equal(plan.manifestStatus, "absent");
  assert.equal(plan.failClosed, false);
  const { ensureRuntimeDirectories } = await import("../subagent-bridge/src/config.js");
  const compatibleConfiguration = { statePaths: { logs: path.join(stateRoot, "logs"), state: stateRoot, cache: path.join(stateRoot, "cache") } };
  assert.doesNotThrow(() => ensureRuntimeDirectories(compatibleConfiguration));
  fs.writeFileSync(manifestFile(stateRoot), JSON.stringify({ migrationId: runtimeStateMigrationId, toVersion: 99 }), "utf8");
  assert.throws(() => ensureRuntimeDirectories(compatibleConfiguration), /incompatible/);
});

test("STATE-MIG-07: desteklenmeyen-dışı fsync hatası yükseltilir", () => {
  const missingDirectory = path.join(os.tmpdir(), `bridge-state-mig-missing-${Date.now()}`);
  assert.throws(() => fsyncDirectory(missingDirectory));
});

test("STATE-MIG-08: apply eski checkpoint'i redakte eder ve idempotent kalır", (context) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-mig-redact-"));
  context.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateRoot, "checkpoints"), { recursive: true });
  const plaintextRunId = "legacy-run-plaintext";
  fs.writeFileSync(
    path.join(stateRoot, "checkpoints", "11111111-2222-3333-4444-555555555555.json"),
    JSON.stringify({ runId: plaintextRunId, agent: "deepseek", role: "analyst", result: { status: "succeeded" }, prompt: "secret-ish" }),
    "utf8"
  );
  const first = applyRuntimeStateMigration({ stateRoot });
  assert.equal(first.applied, true);
  assert.equal(first.payloadRewritten, true);
  assert.equal(first.checkpointRedactionCount, 1);
  const entries = fs.readdirSync(path.join(stateRoot, "checkpoints"));
  assert.equal(entries.length, 1);
  assert.equal(entries[0], `${crypto.createHash("sha256").update(plaintextRunId).digest("hex")}.json`);
  const redactedContents = fs.readFileSync(path.join(stateRoot, "checkpoints", entries[0]), "utf8");
  assert.equal(redactedContents.includes(plaintextRunId), false);
  assert.equal(redactedContents.includes("prompt"), false);
  const manifest = JSON.parse(fs.readFileSync(manifestFile(stateRoot), "utf8"));
  assert.equal(manifest.payloadRewritten, true);
  assert.equal(manifest.checkpointRedactionCount, 1);
  const before = hashTree(stateRoot);
  const second = applyRuntimeStateMigration({ stateRoot });
  assert.equal(second.applied, false);
  assert.equal(second.reason, "already_current");
  assert.equal(hashTree(stateRoot), before);
});

test("STATE-MIG-09: başlangıç kapısı checkpoint'leri sessizce değiştirmez", async (context) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-mig-startup-"));
  context.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateRoot, "checkpoints"), { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, "checkpoints", "legacy.json"),
    JSON.stringify({ runId: "plaintext-run", agent: "deepseek" }),
    "utf8"
  );
  const before = hashTree(stateRoot);
  const { ensureRuntimeDirectories } = await import("../subagent-bridge/src/config.js");
  const compatibleConfiguration = { statePaths: { logs: path.join(stateRoot, "logs"), state: stateRoot, cache: path.join(stateRoot, "cache") } };
  assert.doesNotThrow(() => ensureRuntimeDirectories(compatibleConfiguration));
  assert.equal(hashTree(stateRoot), before);
  assert.equal(fs.readFileSync(path.join(stateRoot, "checkpoints", "legacy.json"), "utf8").includes("plaintext-run"), true);
});

test("STATE-MIG-10: geçersiz runIdHash checkpoint dizini dışına yazamaz", (context) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-mig-traversal-"));
  context.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateRoot, "checkpoints"), { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, "checkpoints", "legacy.json"),
    JSON.stringify({ runIdHash: "../../evil", agent: "deepseek" }),
    "utf8"
  );
  const result = applyRuntimeStateMigration({ stateRoot });
  assert.equal(result.applied, true);
  assert.equal(result.payloadRewritten, true);
  const entries = fs.readdirSync(path.join(stateRoot, "checkpoints"));
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^[a-f0-9]{64}\.json$/);
  assert.equal(fs.existsSync(path.resolve(stateRoot, "checkpoints", "..", "..", "evil.json")), false);
  assert.equal(fs.existsSync(path.resolve(stateRoot, "checkpoints", "..", "evil.json")), false);
});

test("STATE-MIG-11: hash adlı dosyadaki whitelist dışı alan redaksiyonla temizlenir", (context) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-mig-extra-"));
  context.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateRoot, "checkpoints"), { recursive: true });
  const runId = "run-with-extra-fields";
  const runIdHash = crypto.createHash("sha256").update(runId).digest("hex");
  fs.writeFileSync(
    path.join(stateRoot, "checkpoints", `${runIdHash}.json`),
    JSON.stringify({
      runIdHash,
      agent: "deepseek",
      exitCode: 0,
      completedAt: "2026-09-18T00:00:00.000Z",
      failureClass: null,
      attempts: [],
      usage: {},
      result: { status: "succeeded", requires_human_approval: false },
      prompt: "gizli istem metni"
    }),
    "utf8"
  );
  const result = applyRuntimeStateMigration({ stateRoot });
  assert.equal(result.applied, true);
  assert.equal(result.checkpointRedactionCount, 1);
  const contents = fs.readFileSync(path.join(stateRoot, "checkpoints", `${runIdHash}.json`), "utf8");
  assert.equal(contents.includes("gizli istem metni"), false);
  assert.equal(contents.includes("prompt"), false);
  const second = applyRuntimeStateMigration({ stateRoot });
  assert.equal(second.reason, "already_current");
});

test("STATE-MIG-12: güncel biçimli checkpoint gereksiz redaksiyona alınmaz", (context) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-mig-current-"));
  context.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateRoot, "checkpoints"), { recursive: true });
  const runId = "current-format-run";
  const runIdHash = crypto.createHash("sha256").update(runId).digest("hex");
  fs.writeFileSync(
    path.join(stateRoot, "checkpoints", `${runIdHash}.json`),
    JSON.stringify({
      runIdHash,
      agent: "codex",
      role: "reviewer",
      model: "gpt-5.6-sol",
      requestedModel: "gpt-5.6-sol",
      resolvedModel: "gpt-5.6-sol",
      accessMode: "read_only",
      exitCode: 0,
      completedAt: "2026-09-18T00:00:00.000Z",
      failureClass: null,
      attempts: [{
        number: 1,
        failureClass: null,
        failureStage: "none",
        providerCode: null,
        exitCode: 0,
        signal: null,
        retryDecision: "not_applicable",
        retryStopReason: null,
        settingsLockWaitMs: null,
        providerExecutionMs: null,
        stdoutBucket: null,
        stderrBucket: null,
        durationMs: 100,
        totalCostUsd: 0.0001
      }],
      usage: { durationMs: 100, apiDurationMs: null, turns: null, totalCostUsd: 0.0001 },
      result: { status: "succeeded", requires_human_approval: false }
    }),
    "utf8"
  );
  const before = hashTree(stateRoot);
  const checkpointBefore = fs.readFileSync(path.join(stateRoot, "checkpoints", `${runIdHash}.json`), "utf8");
  const plan = planRuntimeStateMigration({ stateRoot });
  assert.equal(plan.checkpointRedactionCount, 0);
  assert.equal(plan.payloadRewritten, false);
  assert.deepEqual(plan.actions, ["write_version_manifest"]);
  const result = applyRuntimeStateMigration({ stateRoot });
  assert.equal(result.applied, true);
  assert.equal(result.payloadRewritten, false);
  assert.equal(fs.readFileSync(path.join(stateRoot, "checkpoints", `${runIdHash}.json`), "utf8"), checkpointBefore);
  assert.notEqual(hashTree(stateRoot), before);
});

test("STATE-MIG-13: manifest güncelken riskli checkpoint yine redakte edilir", (context) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-mig-current-risk-"));
  context.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  assert.equal(applyRuntimeStateMigration({ stateRoot }).applied, true);
  const manifestBefore = fs.readFileSync(manifestFile(stateRoot), "utf8");
  fs.mkdirSync(path.join(stateRoot, "checkpoints"), { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, "checkpoints", "legacy.json"),
    JSON.stringify({ runId: "late-plaintext-run", agent: "deepseek", prompt: "gizli" }),
    "utf8"
  );
  const plan = planRuntimeStateMigration({ stateRoot });
  assert.equal(plan.checkpointRedactionCount, 1);
  assert.equal(plan.payloadRewritten, true);
  assert.deepEqual(plan.actions, ["redact_legacy_checkpoints"]);
  const result = applyRuntimeStateMigration({ stateRoot });
  assert.equal(result.applied, true);
  assert.equal(result.payloadRewritten, true);
  assert.equal(result.checkpointRedactionCount, 1);
  assert.equal(fs.readFileSync(manifestFile(stateRoot), "utf8"), manifestBefore);
  const entries = fs.readdirSync(path.join(stateRoot, "checkpoints"));
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^[a-f0-9]{64}\.json$/);
  assert.equal(fs.readFileSync(path.join(stateRoot, "checkpoints", entries[0]), "utf8").includes("gizli"), false);
  assert.equal(applyRuntimeStateMigration({ stateRoot }).reason, "already_current");
});

test("STATE-MIG-14: iç içe fazla alanlar temizlenir ve redaksiyon idempotent kalır", (context) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-mig-nested-"));
  context.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateRoot, "checkpoints"), { recursive: true });
  const runIdHash = crypto.createHash("sha256").update("nested-run").digest("hex");
  const checkpointPath = path.join(stateRoot, "checkpoints", `${runIdHash}.json`);
  fs.writeFileSync(
    checkpointPath,
    JSON.stringify({
      runIdHash,
      agent: "deepseek",
      exitCode: 0,
      completedAt: "2026-09-18T00:00:00.000Z",
      failureClass: null,
      attempts: [{ number: 1, prompt: "gizli istem" }],
      usage: { durationMs: 5, apiKey: "gizli anahtar" },
      result: { status: "succeeded", requires_human_approval: false }
    }),
    "utf8"
  );
  const plan = planRuntimeStateMigration({ stateRoot });
  assert.equal(plan.checkpointRedactionCount, 1);
  assert.equal(applyRuntimeStateMigration({ stateRoot }).payloadRewritten, true);
  const contents = fs.readFileSync(checkpointPath, "utf8");
  assert.equal(contents.includes("gizli"), false);
  const redacted = JSON.parse(contents);
  assert.deepEqual(redacted.attempts, [{ number: 1 }]);
  assert.deepEqual(redacted.usage, { durationMs: 5 });
  assert.equal(applyRuntimeStateMigration({ stateRoot }).reason, "already_current");
});

test("STATE-MIG-15: nesne biçimli result alanları güvenli değerlere indirgenir", (context) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-mig-result-"));
  context.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateRoot, "checkpoints"), { recursive: true });
  const runIdHash = crypto.createHash("sha256").update("result-run").digest("hex");
  const checkpointPath = path.join(stateRoot, "checkpoints", `${runIdHash}.json`);
  fs.writeFileSync(
    checkpointPath,
    JSON.stringify({
      runIdHash,
      agent: "deepseek",
      result: { status: { prompt: "gizli" }, requires_human_approval: "yes" }
    }),
    "utf8"
  );
  const plan = planRuntimeStateMigration({ stateRoot });
  assert.equal(plan.checkpointRedactionCount, 1);
  assert.equal(applyRuntimeStateMigration({ stateRoot }).applied, true);
  const redacted = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  assert.deepEqual(redacted.result, { status: "failed", requires_human_approval: false });
  assert.equal(fs.readFileSync(checkpointPath, "utf8").includes("gizli"), false);
  assert.equal(applyRuntimeStateMigration({ stateRoot }).reason, "already_current");
});

test("STATE-MIG-16: nesne biçimli kök alanları redaksiyonda düşürülür ve idempotent kalır", (context) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-mig-root-"));
  context.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateRoot, "checkpoints"), { recursive: true });
  const runIdHash = crypto.createHash("sha256").update("root-run").digest("hex");
  const checkpointPath = path.join(stateRoot, "checkpoints", `${runIdHash}.json`);
  fs.writeFileSync(
    checkpointPath,
    JSON.stringify({
      runIdHash,
      agent: { prompt: "gizli ajan" },
      role: ["gizli rol"],
      model: 42,
      exitCode: { secret: "gizli kod" },
      completedAt: { nested: "gizli zaman" },
      result: { status: "succeeded", requires_human_approval: false }
    }),
    "utf8"
  );
  const plan = planRuntimeStateMigration({ stateRoot });
  assert.equal(plan.checkpointRedactionCount, 1);
  assert.equal(applyRuntimeStateMigration({ stateRoot }).applied, true);
  const contents = fs.readFileSync(checkpointPath, "utf8");
  assert.equal(contents.includes("gizli"), false);
  const redacted = JSON.parse(contents);
  assert.equal("agent" in redacted, false);
  assert.equal("role" in redacted, false);
  assert.equal("model" in redacted, false);
  assert.equal("exitCode" in redacted, false);
  assert.equal("completedAt" in redacted, false);
  assert.equal(applyRuntimeStateMigration({ stateRoot }).reason, "already_current");
});

test("STATE-MIG-06: taranamayan checkpoint yolu fail-closed olur", (context) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-mig-scan-"));
  context.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(stateRoot, "checkpoints"), "not-a-directory", "utf8");
  const plan = planRuntimeStateMigration({ stateRoot });
  assert.equal(plan.failClosed, true);
  assert.equal(applyRuntimeStateMigration({ stateRoot }).applied, false);
});

test("STATE-MIG-04: eşzamanlı apply tek kez yazar", async (context) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-mig-concurrent-"));
  context.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(path.resolve("subagent-bridge/src/runtime-state-migration.js")).href;
  const applyInChild = () => new Promise((resolve, reject) => {
    const source = `import { applyRuntimeStateMigration } from ${JSON.stringify(moduleUrl)}; const result = applyRuntimeStateMigration({ stateRoot: ${JSON.stringify(stateRoot)} }); process.stdout.write(JSON.stringify({ applied: result.applied, reason: result.reason || null }));`;
    const child = childProcess.spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`migration child exited with ${code}: ${stderr}`)));
  });
  const results = await Promise.all([applyInChild(), applyInChild()]);
  assert.equal(results.filter((result) => result.applied).length, 1);
  assert.equal(results.filter((result) => result.reason === "already_current").length, 1);
  const manifest = JSON.parse(fs.readFileSync(manifestFile(stateRoot), "utf8"));
  assert.equal(manifest.toVersion, 1);
  assert.equal(fs.existsSync(path.join(stateRoot, "migrations", `${runtimeStateMigrationId}.lock`)), false);
});
