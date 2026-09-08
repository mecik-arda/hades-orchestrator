import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-p2a-e2e-"));
const model = process.env.P2A_OPENCODE_MODEL || "openai/gpt-5.6-terra";
const opencodeExecutable = process.platform === "win32"
  ? execFileSync("where.exe", ["opencode.cmd"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]
  : "opencode";

function initializeWorkspace(directory, marker, gitRepository) {
  fs.mkdirSync(directory, { recursive: true });
  if (gitRepository) execFileSync("git", ["init"], { cwd: directory, stdio: "ignore" });
  fs.writeFileSync(path.join(directory, "TEST_MARKER.txt"), marker, "utf8");
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function workspaceFingerprint(workspace) {
  return crypto.createHash("sha256").update(fs.realpathSync(workspace)).digest("hex");
}

function snapshot(directory) {
  const files = new Map();
  function visit(current, relative = "") {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
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

function runOpenCode(workspace, fixture) {
  const prompt = fixture.probe
    ? `Call only the ${fixture.tool} tool exactly once. Do not use read, glob, grep, bash, task, or any other tool. After the tool completes, return only the tool result.`
    : [
      `Call only the ${fixture.tool} tool exactly once.`,
      "Do not use read, glob, grep, bash, task, or any other tool.",
      "Pass this exact tool prompt: Read TEST_MARKER.txt and return only its exact contents.",
      "After the tool completes, return only the tool result."
    ].join(" ");
  const invocation = process.platform === "win32"
    ? {
      executable: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", opencodeExecutable.replace(/\.cmd$/i, ".ps1"), "run", "--dir", workspace, "--format", "json", "--model", model, prompt]
    }
    : { executable: opencodeExecutable, args: ["run", "--dir", workspace, "--format", "json", "--model", model, prompt] };
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: workspace,
    encoding: "utf8",
    timeout: 1200000,
    windowsHide: true,
    env: { ...process.env }
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const events = output.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const toolEvents = events.filter((event) => event.type === "tool_use" && event.part?.type === "tool");
  const targetToolEvents = toolEvents.filter((event) => event.part.tool === fixture.tool && event.part.state?.status === "completed");
  const targetResults = targetToolEvents.flatMap((event) => {
    try {
      return [JSON.parse(event.part.state.output)];
    } catch {
      return [];
    }
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message || null,
    markerObserved: fixture.probe
      ? targetResults.some((toolResult) => toolResult.source === fixture.expectedSource
        && toolResult.workspaceFingerprint === workspaceFingerprint(workspace)
        && toolResult.directoryFingerprint === workspaceFingerprint(workspace))
      : targetResults.some((toolResult) => toolResult.ok && toolResult.result?.includes(fixture.marker)),
    targetToolObserved: targetToolEvents.length === 1,
    forbiddenToolObserved: toolEvents.some((event) => event.part.tool !== fixture.tool),
    targetResults,
    output
  };
}

const workspaces = [
  { name: "repo-A", marker: "P2A-GIT-GEMINI", gitRepository: true, tool: "subagent-bridge_geminiPro" },
  { name: "repo-B", marker: "P2A-GIT-CODEX", gitRepository: true, tool: "subagent-bridge_codex" },
  { name: "non-git", marker: "P2A-NONGIT", gitRepository: false, tool: "subagent-bridge_workspaceContext", probe: true, expectedSource: "directory" }
];

try {
  const reports = [];
  for (const fixture of workspaces) {
    const workspace = path.join(temporaryRoot, fixture.name);
    initializeWorkspace(workspace, fixture.marker, fixture.gitRepository);
    const before = snapshot(workspace);
    const execution = runOpenCode(workspace, fixture);
    const mutations = changedFiles(before, snapshot(workspace));
    reports.push({
      ...fixture,
      workspace,
      expectedWorkspaceFingerprint: fixture.probe ? workspaceFingerprint(workspace) : null,
      status: execution.status,
      signal: execution.signal,
      error: execution.error,
      markerObserved: execution.markerObserved,
      targetToolObserved: execution.targetToolObserved,
      forbiddenToolObserved: execution.forbiddenToolObserved,
      targetResults: execution.targetResults,
      mutations
    });
  }
  console.log(JSON.stringify({ model, reports }, null, 2));
  if (reports.some((report) => report.status !== 0 || !report.markerObserved || !report.targetToolObserved || report.forbiddenToolObserved || report.mutations.length > 0)) {
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
