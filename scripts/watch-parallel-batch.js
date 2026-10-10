import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfiguration } from "../subagent-bridge/src/config.js";

const batchIdPattern = /^[a-f0-9]{16,64}$/;
const resolvedTaskStatuses = new Set(["completed", "failed", "blocked", "cancelled"]);
const terminalBatchStatuses = new Set(["result_ready", "ready_for_approval", "integrated", "blocked", "failed", "cancelled", "unknown"]);

function sanitize(value, maxLength = 100) {
  return String(value ?? "")
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cost(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "unknown";
}

export function readBatchManifest(stateDirectory, batchId) {
  if (!batchIdPattern.test(batchId)) throw new Error("batchId must be a hexadecimal ID");
  const manifestPath = path.join(stateDirectory, "parallel-batches", "batches", `${batchId}.json`);
  const status = fs.lstatSync(manifestPath);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) throw new Error("batch manifest is not a regular file");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.batchId !== batchId || !Array.isArray(manifest.taskOrder) || !manifest.tasks) {
    throw new Error("batch manifest schema is invalid");
  }
  return manifest;
}

export function renderParallelBatchScreen(manifest, now = Date.now()) {
  const taskIds = manifest.taskOrder;
  const tasks = taskIds.map((taskId) => manifest.tasks[taskId]).filter(Boolean);
  const resolvedCount = tasks.filter((task) => resolvedTaskStatuses.has(task.status)).length;
  const totalCount = tasks.length;
  const percentage = totalCount > 0 ? Math.floor((resolvedCount / totalCount) * 100) : 0;
  const width = 20;
  const filled = Math.round((percentage / 100) * width);
  const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
  const runningCount = tasks.filter((task) => task.status === "running").length;
  const queuedCount = tasks.filter((task) => task.status === "queued").length;
  const blockedCount = tasks.filter((task) => task.status === "blocked").length;
  const failedCount = tasks.filter((task) => task.status === "failed").length;
  const unknownCount = tasks.filter((task) => task.status === "unknown").length;
  const lines = [
    "ORKESTRASYON V2 BATCH WATCH",
    `Batch: ${sanitize(manifest.batchId, 8)}  ${sanitize(manifest.status, 16).toUpperCase()}`,
    `Progress: ${percentage}% (${resolvedCount}/${totalCount})`,
    `[${bar}]`,
    `Tasks: ${runningCount} running · ${queuedCount} queued`,
    `Blocked: ${blockedCount} · Failed: ${failedCount}`,
    `Unknown: ${unknownCount} · Cancelled: ${tasks.filter((task) => task.status === "cancelled").length}`,
    `Admission: $${cost(manifest.budget?.spentKnownUsd + manifest.budget?.unknownReservedUsd)} / $${cost(manifest.budget?.capUsd)}`,
    `Remaining: $${cost(manifest.budget?.remainingUsd)}`,
    "Estimate only; not a provider invoice",
    "",
    "TASKS"
  ];
  for (const task of tasks) {
    const durationMs = Number.isFinite(task.durationMs) && task.durationMs > 0
      ? task.durationMs
      : task.status === "running" && typeof task.startedAt === "string"
        ? Math.max(0, now - Date.parse(task.startedAt))
        : 0;
    const duration = durationMs > 0 ? ` · ${(durationMs / 1000).toFixed(1)}s` : "";
    lines.push(`  ${sanitize(task.status, 10).toUpperCase().padEnd(10)} ${sanitize(task.taskId, 24)}`);
    if (duration) lines.push(`    Elapsed: ${duration.slice(3)}`);
    if (task.failureClass) lines.push(`    reason: ${sanitize(task.failureClass, 30)}`);
  }
  const footer = manifest.status === "ready_for_approval"
    ? "Integration awaits approval · Ctrl+C closes"
    : terminalBatchStatuses.has(manifest.status)
      ? "Workers stopped · Ctrl+C closes"
      : "Refresh: 1s · Ctrl+C closes";
  lines.push("", footer);
  return lines.join("\n");
}

function writeScreen(output, screen) {
  if (output.isTTY && typeof output.cursorTo === "function" && typeof output.clearScreenDown === "function") {
    output.cursorTo(0, 0);
    output.clearScreenDown();
  } else if (output.isTTY) {
    output.write("\x1b[2J\x1b[H");
  }
  output.write(`${screen}\n`);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function watchParallelBatch(batchId, { intervalMs = 1000, loadConfigurationFn = loadConfiguration, output = process.stdout, stateDirectory } = {}) {
  const resolvedStateDirectory = stateDirectory ? path.resolve(stateDirectory) : loadConfigurationFn().statePaths.state;
  let previousScreen = "";
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  output.write("\x1b[?25l");
  try {
    while (!stopped) {
      let manifest;
      try {
          manifest = readBatchManifest(resolvedStateDirectory, batchId);
      } catch (error) {
        if (error.code === "ENOENT") throw new Error("batch not found; verify the ID and personal bridge state path");
        throw error;
      }
      const screen = renderParallelBatchScreen(manifest);
      if (screen !== previousScreen) {
        writeScreen(output, screen);
        previousScreen = screen;
      }
      if (terminalBatchStatuses.has(manifest.status)) return manifest;
      await wait(intervalMs);
    }
    return null;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    output.write("\x1b[?25h");
  }
}

async function main() {
  const batchId = process.argv[2];
  if (!batchId || !batchIdPattern.test(batchId)) {
    process.stderr.write("Usage: npm run parallel:watch -- <batchId> [--state-directory <path>]\n");
    process.exitCode = 2;
    return;
  }
  const stateDirectoryIndex = process.argv.indexOf("--state-directory");
  const stateDirectory = stateDirectoryIndex >= 0 ? process.argv[stateDirectoryIndex + 1] : undefined;
  if (stateDirectoryIndex >= 0 && (!stateDirectory || !path.isAbsolute(stateDirectory))) {
    process.stderr.write("--state-directory must be an absolute path\n");
    process.exitCode = 2;
    return;
  }
  try {
    await watchParallelBatch(batchId, { stateDirectory });
  } catch (error) {
    process.stderr.write(`${sanitize(error.message, 200)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
