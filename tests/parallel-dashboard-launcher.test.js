import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createParallelDashboardLauncher } from "../subagent-bridge/src/services/parallel-dashboard-launcher.js";

function createScripts(t) {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-launcher-"));
  t.after(() => fs.rmSync(packageRoot, { recursive: true, force: true }));
  const scripts = path.join(packageRoot, "scripts");
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, "watch-parallel-batch.js"), "", "utf8");
  fs.writeFileSync(path.join(scripts, "watch-parallel-batch.ps1"), "", "utf8");
  return { packageRoot, stateDirectory: path.join(packageRoot, "private-state") };
}

function createSpawnFake(calls, onCall = () => {}) {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.unref = () => { child.unreferenced = true; };
    onCall(child, calls.length);
    return child;
  };
}

test("V2-LAUNCHER: opens a small Windows Terminal window at the screen edge with a fixed watcher command", async (t) => {
  const { packageRoot, stateDirectory } = createScripts(t);
  const calls = [];
  const launcher = createParallelDashboardLauncher({
    enabled: true,
    platform: "win32",
    packageRoot,
    stateDirectory,
    nodeExecutable: "C:\\node\\node.exe",
    powershellExecutable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    terminalPathResolver: () => "C:\\WindowsApps\\wt.exe",
    screenBoundsResolver: () => ({ left: 0, top: 0, right: 2000, bottom: 1200 }),
    spawnProcess: createSpawnFake(calls, (child) => queueMicrotask(() => child.emit("spawn"))),
    environment: { PATH: "C:\\node", SystemRoot: "C:\\Windows", OPENAI_API_KEY: "excluded" }
  });
  const result = await launcher.open("a".repeat(32));
  assert.deepEqual(result, { opened: true, mode: "windows_terminal_window" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "C:\\WindowsApps\\wt.exe");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].args.includes("-w"), true);
  assert.equal(calls[0].args[calls[0].args.indexOf("-w") + 1], "new");
  assert.equal(calls[0].args.includes("--pos"), true);
  assert.equal(calls[0].args[calls[0].args.indexOf("--pos") + 1], "1540,64");
  assert.equal(calls[0].args.includes("--size"), true);
  assert.equal(calls[0].args[calls[0].args.indexOf("--size") + 1], "46,26");
  assert.equal(calls[0].args.includes("new-tab"), true);
  assert.equal(calls[0].args.includes("split-pane"), false);
  assert.equal(calls[0].args.includes("C:\\node\\node.exe"), true);
  assert.equal(calls[0].args.includes(path.join(packageRoot, "scripts", "watch-parallel-batch.js")), true);
  assert.equal(calls[0].args.includes("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), false);
  assert.equal(calls[0].args.includes(stateDirectory), true);
  assert.equal(calls[0].args.includes("a".repeat(32)), true);
  assert.equal(Object.hasOwn(calls[0].options.env, "OPENAI_API_KEY"), false);
});

test("V2-LAUNCHER: falls back to a detached PowerShell window when Windows Terminal is absent", async (t) => {
  const { packageRoot, stateDirectory } = createScripts(t);
  const calls = [];
  const launcher = createParallelDashboardLauncher({
    enabled: true,
    platform: "win32",
    packageRoot,
    stateDirectory,
    nodeExecutable: "C:\\node\\node.exe",
    powershellExecutable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    terminalPathResolver: () => null,
    spawnProcess: createSpawnFake(calls, (child) => queueMicrotask(() => child.emit("spawn"))),
    environment: { PATH: "C:\\node", SystemRoot: "C:\\Windows" }
  });
  const result = await launcher.open("b".repeat(32));
  assert.deepEqual(result, { opened: true, mode: "powershell_window" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(calls[0].args.includes("-NoExit"), true);
  assert.equal(calls[0].args.includes("--state-directory"), false);
  assert.equal(calls[0].args.includes(stateDirectory), true);
});

test("V2-LAUNCHER: stays inert unless explicitly enabled and rejects invalid IDs", async (t) => {
  const { packageRoot, stateDirectory } = createScripts(t);
  const calls = [];
  const base = { platform: "win32", packageRoot, stateDirectory, spawnProcess: createSpawnFake(calls) };
  assert.deepEqual(await createParallelDashboardLauncher({ ...base, enabled: false }).open("c".repeat(32)), { opened: false, reason: "disabled" });
  assert.deepEqual(await createParallelDashboardLauncher({ ...base, enabled: true }).open("../bad"), { opened: false, reason: "invalid_batch_id" });
  assert.equal(calls.length, 0);
});
