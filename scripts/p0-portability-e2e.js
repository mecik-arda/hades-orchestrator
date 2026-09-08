import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureRuntimeDirectories, loadRuntimeConfiguration } from "../subagent-bridge/src/config.js";
import { createBridgeRuntime } from "../subagent-bridge/src/runtime/bridge-runtime.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, "..");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-p0-e2e-"));
const repoA = path.join(temporaryRoot, "repo-A");
const repoB = path.join(temporaryRoot, "repo-B");
const runtimeData = path.join(temporaryRoot, "runtime-data");
const ignoredPackageEntries = new Set([".git", "node_modules", "logs", "state", "cache", "memory"]);

function initializeRepository(directory, marker) {
  fs.mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init"], { cwd: directory, stdio: "ignore" });
  fs.writeFileSync(path.join(directory, "TEST_MARKER.txt"), marker, "utf8");
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function snapshot(directory, ignoredEntries = new Set()) {
  const files = new Map();
  function visit(current, relative = "") {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (relative === "" && ignoredEntries.has(entry.name)) continue;
      const entryRelative = relative ? path.join(relative, entry.name) : entry.name;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath, entryRelative);
      else if (entry.isFile()) files.set(entryRelative.replace(/\\/g, "/"), hashFile(entryPath));
    }
  }
  visit(directory);
  return files;
}

function compareSnapshots(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((filePath) => before.get(filePath) !== after.get(filePath)).sort();
}

function summarizeResult(result) {
  return {
    ok: result.ok,
    backend: result.backend,
    model: result.model,
    nonEmpty: typeof result.result === "string" && result.result.trim().length > 0,
    timedOut: result.timedOut,
    retryable: result.retryable,
    reason: result.reason || null,
    retries: result.metrics?.retries ?? null
  };
}

initializeRepository(repoA, "P0-MARKER-A");
initializeRepository(repoB, "P0-MARKER-B");

const configuration = loadRuntimeConfiguration({
  statePaths: {
    logs: path.join(runtimeData, "logs"),
    state: path.join(runtimeData, "state"),
    cache: path.join(runtimeData, "cache")
  }
});
ensureRuntimeDirectories(configuration);
const runtime = createBridgeRuntime({ configuration });

const packageBefore = snapshot(packageRoot, ignoredPackageEntries);
const repoABefore = snapshot(repoA);
const repoBBefore = snapshot(repoB);

try {
  const gemini = await runtime.run({
    target: "gemini_pro",
    prompt: "Read TEST_MARKER.txt in the trusted workspace and return only its exact marker.",
    mode: "read_only",
    trustedWorkspace: repoA,
    caller: "p0_acceptance",
    delegationDepth: 0
  });
  const codex = await runtime.run({
    target: "codex",
    prompt: "Read TEST_MARKER.txt in the trusted workspace and return only its exact marker.",
    mode: "read_only",
    trustedWorkspace: repoB,
    caller: "p0_acceptance",
    delegationDepth: 0
  });

  const packageMutation = compareSnapshots(packageBefore, snapshot(packageRoot, ignoredPackageEntries));
  const repoAMutation = compareSnapshots(repoABefore, snapshot(repoA));
  const repoBMutation = compareSnapshots(repoBBefore, snapshot(repoB));
  const report = {
    packageRoot,
    repoA,
    repoB,
    gemini: summarizeResult(gemini),
    codex: summarizeResult(codex),
    markerAObserved: gemini.result?.includes("P0-MARKER-A") || false,
    markerBObserved: codex.result?.includes("P0-MARKER-B") || false,
    mutations: {
      package: packageMutation,
      repoA: repoAMutation,
      repoB: repoBMutation
    }
  };
  console.log(JSON.stringify(report, null, 2));
  if (!gemini.ok || !codex.ok || !report.markerAObserved || !report.markerBObserved || packageMutation.length > 0 || repoAMutation.length > 0 || repoBMutation.length > 0) {
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
