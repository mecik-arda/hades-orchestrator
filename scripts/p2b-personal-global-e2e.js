import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getPersonalBridgeLayout } from "../subagent-bridge/src/personal-layout.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const bridgeRoot = path.resolve(scriptDirectory, "..");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-p2b-e2e-"));
const model = process.env.P2B_OPENCODE_MODEL || "openai/gpt-5.6-terra";
const layout = getPersonalBridgeLayout();
const globalToolPath = path.join(os.homedir(), ".config", "opencode", "tools", "subagent-bridge.js");
const opencodeExecutable = process.platform === "win32"
  ? execFileSync("where.exe", ["opencode.cmd"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]
  : "opencode";
const ignoredBridgeEntries = new Set([".git", "node_modules", "logs", "state", "cache", "memory"]);

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function workspaceFingerprint(workspace) {
  return crypto.createHash("sha256").update(fs.realpathSync(workspace)).digest("hex");
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

function changedFiles(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((filePath) => before.get(filePath) !== after.get(filePath)).sort();
}

function initializeWorkspace(directory, marker, gitRepository) {
  fs.mkdirSync(directory, { recursive: true });
  if (gitRepository) execFileSync("git", ["init"], { cwd: directory, stdio: "ignore" });
  fs.writeFileSync(path.join(directory, "TEST_MARKER.txt"), marker, "utf8");
}

function integrationFiles(directory) {
  return [".opencode", "opencode.json", "opencode.jsonc", "subagent-bridge", ".subagent-bridge.json"].filter((name) => fs.existsSync(path.join(directory, name)));
}

function invokeOpenCode(workspace, fixture) {
  const prompt = fixture.diagnostic
    ? `Call only the ${fixture.tool} tool exactly once. Do not use any other tool. Return only the tool result.`
    : `Call only the ${fixture.tool} tool exactly once. Do not use read, glob, grep, bash, task, or any other tool. Pass this exact tool prompt: Read TEST_MARKER.txt and return only its exact contents. Return only the tool result.`;
  const invocation = process.platform === "win32"
    ? {
      executable: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", opencodeExecutable.replace(/\.cmd$/i, ".ps1"), "run", "--dir", workspace, "--format", "json", "--model", model, prompt]
    }
    : { executable: opencodeExecutable, args: ["run", "--dir", workspace, "--format", "json", "--model", model, prompt] };
  const processResult = spawnSync(invocation.executable, invocation.args, {
    cwd: workspace,
    encoding: "utf8",
    timeout: 1200000,
    windowsHide: true,
    env: { ...process.env }
  });
  const output = `${processResult.stdout || ""}\n${processResult.stderr || ""}`;
  const events = output.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const toolEvents = events.filter((event) => event.type === "tool_use" && event.part?.type === "tool");
  const targetEvents = toolEvents.filter((event) => event.part.tool === fixture.tool && event.part.state?.status === "completed");
  const targetResults = targetEvents.flatMap((event) => {
    try {
      return [JSON.parse(event.part.state.output)];
    } catch {
      return [];
    }
  });
  return {
    status: processResult.status,
    error: processResult.error?.message || null,
    targetToolObserved: targetEvents.length === 1,
    extraToolObserved: toolEvents.some((event) => event.part.tool !== fixture.tool),
    publicArgsValid: targetEvents.every((event) => Object.keys(event.part.state.input || {}).length === (fixture.diagnostic ? 0 : 1) && (!fixture.diagnostic ? typeof event.part.state.input.prompt === "string" : true)),
    targetResults
  };
}

function verifyFixture(fixture, execution, workspace, otherMarker) {
  if (fixture.diagnostic) {
    return execution.targetResults.some((result) => result.source === "directory"
      && result.workspaceFingerprint === workspaceFingerprint(workspace)
      && result.directoryFingerprint === workspaceFingerprint(workspace)
      && result.worktreeFingerprint !== workspaceFingerprint(workspace));
  }
  return execution.targetResults.some((result) => result.ok
    && result.result === fixture.marker
    && !result.result.includes(otherMarker));
}

const fixtures = [
  { name: "RepoA", marker: "REPO_A_MARKER_9D47", gitRepository: true, tool: "subagent-bridge_geminiPro" },
  { name: "RepoB", marker: "REPO_B_MARKER_71CE", gitRepository: true, tool: "subagent-bridge_codex" },
  { name: "RepoE", marker: "REPO_E_MARKER_64FA", gitRepository: true, tool: "subagent-bridge_geminiFlash" },
  { name: "RepoD", marker: "REPO_D_MARKER_5B2E", gitRepository: true, tool: "subagent-bridge_geminiFlash38" },
  { name: "FolderC", marker: "FOLDER_C_MARKER_24AB", gitRepository: false, tool: "subagent-bridge_workspaceContext", diagnostic: true }
];

const globalToolSource = fs.readFileSync(globalToolPath, "utf8");
const preconditions = {
  globalConfigExists: fs.existsSync(layout.configPath) && fs.existsSync(layout.agentsPath),
  globalToolExists: fs.existsSync(globalToolPath),
  fixedWorkspaceEnvironmentUsed: globalToolSource.includes("SUBAGENT_BRIDGE_TRUSTED_WORKSPACE"),
  usesMachineConfig: globalToolSource.includes("configurationPath: layout.configPath") && globalToolSource.includes("agentsPath: layout.agentsPath"),
  usesGlobalStatePaths: globalToolSource.includes("logs: layout.logs") && globalToolSource.includes("state: layout.state") && globalToolSource.includes("cache: layout.cache"),
  controlledEditToolsReady: globalToolSource.includes("codexLunaEdit") && globalToolSource.includes("codexTerraEdit") && globalToolSource.includes("codexSolEdit") && globalToolSource.includes("runProfileEdit"),
  codexAstraToolsReady: globalToolSource.includes("codexAstra") && globalToolSource.includes("codexAstraEdit"),
  glmEditToolsReady: globalToolSource.includes("glm52Edit") && globalToolSource.includes("glm53Edit") && globalToolSource.includes("glm53FlashEdit"),
  geminiFlashReady: globalToolSource.includes("geminiFlash"),
  geminiFlash38Ready: globalToolSource.includes("geminiFlash38")
};
const bridgeBefore = snapshot(bridgeRoot, ignoredBridgeEntries);

try {
  const reports = [];
  for (const fixture of fixtures) {
    const workspace = path.join(temporaryRoot, fixture.name);
    initializeWorkspace(workspace, fixture.marker, fixture.gitRepository);
    const before = snapshot(workspace);
    const execution = invokeOpenCode(workspace, fixture);
    reports.push({
      ...fixture,
      workspace,
      integrationFiles: integrationFiles(workspace),
      status: execution.status,
      error: execution.error,
      targetToolObserved: execution.targetToolObserved,
      extraToolObserved: execution.extraToolObserved,
      publicArgsValid: execution.publicArgsValid,
      accepted: verifyFixture(fixture, execution, workspace, fixture.name === "RepoA" ? fixtures[1].marker : fixtures[0].marker),
      targetResults: execution.targetResults,
      mutations: changedFiles(before, snapshot(workspace))
    });
  }
  const bridgeMutation = changedFiles(bridgeBefore, snapshot(bridgeRoot, ignoredBridgeEntries));
  const statePathsReady = [layout.logs, layout.state, layout.cache].every((directory) => fs.existsSync(directory));
  console.log(JSON.stringify({
    bridgeRoot,
    layout,
    preconditions,
    statePathsReady,
    bridgeMutation,
    reports
  }, null, 2));
  if (!preconditions.globalConfigExists || !preconditions.globalToolExists || preconditions.fixedWorkspaceEnvironmentUsed || !preconditions.usesMachineConfig || !preconditions.usesGlobalStatePaths || !preconditions.controlledEditToolsReady || !preconditions.codexAstraToolsReady || !preconditions.glmEditToolsReady || !preconditions.geminiFlashReady || !preconditions.geminiFlash38Ready || !statePathsReady || bridgeMutation.length > 0 || reports.some((report) => report.status !== 0 || report.error || !report.targetToolObserved || report.extraToolObserved || !report.publicArgsValid || !report.accepted || report.integrationFiles.length > 0 || report.mutations.length > 0)) {
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
