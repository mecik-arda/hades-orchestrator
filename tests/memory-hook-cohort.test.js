import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  expectedMemoryHookProjectTarget,
  canonicalizeMemoryHookPath,
  memoryHookCohortRegistryMaxBytes,
  memoryHookCohortRegistryPath,
  parseMemoryHookCohortRegistry,
  readMemoryHookCohortRegistry,
  resolveMemoryHookProjectCohort,
  resolveOpenCodeProjectCohort,
  validateMemoryHookProjectInstallation
} from "../subagent-bridge/src/services/memory-hook-cohort.js";

function createRegistryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-hook-cohort-"));
  const project_alpha = path.join(root, "project_alpha");
  const project_beta = path.join(root, "project_beta");
  fs.mkdirSync(project_alpha);
  fs.mkdirSync(project_beta);
  const registryPath = path.join(root, "settings", "memory-hook-cohorts.json");
  fs.mkdirSync(path.dirname(registryPath));
  const registry = {
    schemaVersion: 1,
    projects: [
      { cohort: "project_alpha", roots: [project_alpha] },
      { cohort: "project_beta", roots: [project_beta] }
    ]
  };
  fs.writeFileSync(registryPath, JSON.stringify(registry), "utf8");
  return { root, project_alpha, project_beta, registryPath, registry };
}

test("HOOK-COHORT-01: registry exact root eşleşmesi ve proje hedefi doğrulanır", (context) => {
  const fixture = createRegistryFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const loaded = readMemoryHookCohortRegistry({ registryPath: fixture.registryPath });
  assert.ok(loaded);
  assert.deepEqual(resolveMemoryHookProjectCohort({ projectRoots: [fixture.project_alpha], registryPath: fixture.registryPath }), {
    projectCohort: "project_alpha",
    status: "matched"
  });
  assert.deepEqual(resolveMemoryHookProjectCohort({ projectRoots: [path.join(fixture.project_alpha, "nested")], registryPath: fixture.registryPath }), {
    projectCohort: "unassigned",
    status: "root_unmatched"
  });
  assert.equal(resolveMemoryHookProjectCohort({ projectRoots: [fixture.project_alpha], requestedCohort: "project_beta", registryPath: fixture.registryPath }).status, "cohort_mismatch");
  assert.equal(resolveMemoryHookProjectCohort({ projectRoots: [fixture.project_alpha], requestedCohort: "invalid", registryPath: fixture.registryPath }).projectCohort, "unassigned");
  assert.deepEqual(validateMemoryHookProjectInstallation({
    projectRoot: fixture.project_alpha,
    cohort: "project_alpha",
    client: "opencode",
    targetPath: expectedMemoryHookProjectTarget(fixture.project_alpha, "opencode"),
    registryPath: fixture.registryPath
  }), {
    valid: true,
    status: "matched",
    expectedTargetPath: expectedMemoryHookProjectTarget(fixture.project_alpha, "opencode")
  });
  assert.equal(validateMemoryHookProjectInstallation({
    projectRoot: fixture.project_alpha,
    cohort: "project_alpha",
    client: "opencode",
    targetPath: path.join(fixture.root, "elsewhere.js"),
    registryPath: fixture.registryPath
  }).status, "target_scope_invalid");
  const aliasedRoot = path.join(fixture.root, "project_alpha-alias");
  fs.symlinkSync(fixture.project_alpha, aliasedRoot, process.platform === "win32" ? "junction" : "dir");
  const aliasedTarget = path.join(aliasedRoot, ".opencode", "plugins", "second-brain-memory.js");
  assert.equal(
    canonicalizeMemoryHookPath(aliasedTarget),
    canonicalizeMemoryHookPath(expectedMemoryHookProjectTarget(fixture.project_alpha, "opencode"))
  );
  assert.equal(validateMemoryHookProjectInstallation({
    projectRoot: fixture.project_alpha,
    cohort: "project_alpha",
    client: "opencode",
    targetPath: aliasedTarget,
    registryPath: fixture.registryPath
  }).valid, true);
});

test("HOOK-COHORT-02: alias kayıtları explicit olmalı ve ambiguous cohort reddedilmeli", (context) => {
  const fixture = createRegistryFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const worktree = path.join(fixture.root, "project_alpha-worktree");
  fs.mkdirSync(worktree);
  assert.equal(resolveMemoryHookProjectCohort({ projectRoots: [worktree], registryPath: fixture.registryPath }).projectCohort, "unassigned");
  fixture.registry.projects[0].roots.push(worktree);
  fs.writeFileSync(fixture.registryPath, JSON.stringify(fixture.registry), "utf8");
  assert.equal(resolveMemoryHookProjectCohort({ projectRoots: [fixture.project_alpha, worktree], registryPath: fixture.registryPath }).projectCohort, "project_alpha");
  fixture.registry.projects[1].roots.push(worktree);
  assert.equal(parseMemoryHookCohortRegistry(fixture.registry), null);
  assert.equal(resolveOpenCodeProjectCohort({
    directory: fixture.project_alpha,
    worktree: fixture.project_beta,
    project: { directory: fixture.project_alpha },
    registryPath: fixture.registryPath
  }).status, "root_ambiguous");
  assert.equal(resolveOpenCodeProjectCohort({
    directory: path.join(fixture.root, "unknown"),
    worktree: fixture.project_alpha,
    project: { root: fixture.project_beta },
    registryPath: fixture.registryPath
  }).projectCohort, "unassigned");
});

test("HOOK-COHORT-03: bozuk, fazla büyük ve hard-link registry fail-closed olur", (context) => {
  const fixture = createRegistryFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const invalidPath = path.join(fixture.root, "invalid.json");
  fs.writeFileSync(invalidPath, JSON.stringify({ schemaVersion: 2, projects: [] }), "utf8");
  assert.equal(readMemoryHookCohortRegistry({ registryPath: invalidPath }), null);
  assert.equal(resolveMemoryHookProjectCohort({ projectRoots: [fixture.project_alpha], registryPath: invalidPath }).status, "invalid_registry");
  assert.equal(resolveMemoryHookProjectCohort({ projectRoots: [fixture.project_alpha], registryPath: path.join(fixture.root, "missing.json") }).status, "registry_unavailable");
  fs.writeFileSync(invalidPath, "x".repeat(memoryHookCohortRegistryMaxBytes + 1), "utf8");
  assert.equal(readMemoryHookCohortRegistry({ registryPath: invalidPath }), null);
  assert.equal(memoryHookCohortRegistryPath({ registryPath: "relative.json" }), null);
  assert.equal(resolveMemoryHookProjectCohort({ projectRoots: [fixture.project_alpha], registryPath: "relative.json" }).status, "invalid_registry");
  const hardLinkPath = path.join(fixture.root, "hard-link.json");
  fs.linkSync(fixture.registryPath, hardLinkPath);
  assert.equal(readMemoryHookCohortRegistry({ registryPath: hardLinkPath }), null);
});

test("HOOK-COHORT-04: global and project hook cohort semantics are distinct", (context) => {
  const fixture = createRegistryFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  assert.equal(resolveOpenCodeProjectCohort({ directory: fixture.project_alpha, worktree: fixture.project_alpha, registryPath: fixture.registryPath }).projectCohort, "project_alpha");
  assert.deepEqual(resolveOpenCodeProjectCohort({ directory: fixture.project_alpha, worktree: fixture.project_alpha, requestedCohort: "project_alpha", registryPath: fixture.registryPath }), {
    projectCohort: "project_alpha",
    status: "matched"
  });
  assert.deepEqual(resolveOpenCodeProjectCohort({ directory: fixture.project_alpha, worktree: fixture.project_alpha, requestedCohort: "unassigned", registryPath: fixture.registryPath }), {
    projectCohort: "unassigned",
    status: "unassigned"
  });
});
