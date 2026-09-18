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
  assert.equal(plan.payloadRewritten, false);
  assert.equal(plan.failClosed, false);
  assert.deepEqual(plan.actions, ["write_version_manifest"]);
  assert.equal(plan.legacyArtifactCount, 1);
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
