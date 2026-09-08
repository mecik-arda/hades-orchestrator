import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExecutionHandle, createExecutionId, runProcess, killProcessTree } from "../subagent-bridge/src/services/execution-service.js";

test("PROCESS-TREE: platform termination strategy invoked, child handles verified", async () => {
  console.log("  Platform:", process.platform);
  console.log(`  killProcessTree: ${killProcessTree.toString().includes("taskkill") ? "Windows taskkill /T" : "POSIX process group SIGKILL"}`);

  const handle = createExecutionHandle(createExecutionId());
  let processOutput = "";

  const promise = runProcess("node", [
    "-e",
    `
      const { spawn } = require('child_process');
      console.log("PARENT:" + process.pid);
      const child = spawn(process.execPath, ['-e', 'console.log("CHILD:" + process.pid); setInterval(() => {}, 30000)'], {
        stdio: 'pipe'
      });
      child.stdout.on('data', (d) => process.stdout.write(d));
      setInterval(() => {}, 30000);
    `
  ], {
    timeoutMs: 30000,
    abortController: handle.abortController,
    onSpawn: (child) => handle.attachChild(child),
    onStdout: (chunk) => {
      processOutput += chunk.toString("utf8");
    }
  });

  const timeout = setTimeout(() => handle.cancel(), 1500);

  let parentKilled = false;
  let timedOut = false;

  try {
    const result = await promise;
    parentKilled = result.signal !== null || result.code !== 0;
  } catch (e) {
    parentKilled = true;
    assert.match(e.message, /abort/i);
  }

  clearTimeout(timeout);

  assert.ok(parentKilled, "parent process should be terminated");
  const childPid = Number(processOutput.match(/CHILD:(\d+)/)?.[1]);
  assert.ok(Number.isInteger(childPid), "child PID should be observed before cancellation");
  await new Promise((resolve) => setTimeout(resolve, 300));
  let childAlive = true;
  try {
    process.kill(childPid, 0);
  } catch {
    childAlive = false;
  }
  if (childAlive) killProcessTree(childPid);
  assert.equal(childAlive, false, "descendant process should be terminated");
  console.log("  Parent killed: confirmed");
});

test("PROCESS-TREE: killProcessTree function smoke test", () => {
  if (process.platform === "win32") {
    const funcStr = killProcessTree.toString();
    assert.match(funcStr, /taskkill/);
    assert.match(funcStr, /\/T/);
    console.log("  Windows: taskkill /T /F /PID strategy confirmed");
  } else {
    const funcStr = killProcessTree.toString();
    assert.match(funcStr, /SIGKILL/);
    console.log("  POSIX: process group SIGKILL strategy confirmed");
  }
});

test("PROCESS-TREE: timeout destekleyen süreçte önce stdin ile graceful shutdown dener", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-graceful-shutdown-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const markerPath = path.join(root, "closed.txt");
  await assert.rejects(runProcess(process.execPath, [
    "--input-type=module",
    "--eval",
    `import fs from "node:fs"; process.stdin.resume(); process.stdin.on("end", () => { fs.writeFileSync(${JSON.stringify(markerPath)}, "closed", "utf8"); process.exit(0); });`
  ], {
    timeoutMs: 100,
    gracefulShutdownMs: 1000,
    keepStdinOpen: true
  }), /timed out/i);
  assert.equal(fs.readFileSync(markerPath, "utf8"), "closed");
});
