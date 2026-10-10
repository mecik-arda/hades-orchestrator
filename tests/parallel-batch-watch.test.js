import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBatchManifest, renderParallelBatchScreen, watchParallelBatch } from "../scripts/watch-parallel-batch.js";

function makeManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    batchId: "a".repeat(32),
    planId: "b".repeat(32),
    planHash: "c".repeat(64),
    status: "running",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    taskOrder: ["task-one", "task-two"],
    tasks: {
      "task-one": { taskId: "task-one", status: "completed", durationMs: 1000, endedAt: new Date(1000).toISOString() },
      "task-two": { taskId: "task-two", status: "running", durationMs: 0, startedAt: new Date(1000).toISOString() }
    },
    budget: { capUsd: 1, spentKnownUsd: 0.1, unknownReservedUsd: 0.1, remainingUsd: 0.8 },
    ...overrides
  };
}

function createState(t, manifest) {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-watch-test-"));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const batchesDirectory = path.join(stateDirectory, "parallel-batches", "batches");
  fs.mkdirSync(batchesDirectory, { recursive: true });
  const manifestPath = path.join(batchesDirectory, `${manifest.batchId}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  return { stateDirectory, manifestPath, batchesDirectory };
}

test("V2-WATCH: terminal snapshot is readable, bounded and counts only resolved tasks", (t) => {
  const manifest = makeManifest();
  const { stateDirectory } = createState(t, manifest);
  const read = readBatchManifest(stateDirectory, manifest.batchId);
  const screen = renderParallelBatchScreen(read, 3000);
  assert.match(screen, /Progress: 50% \(1\/2\)/);
  assert.match(screen, /\[##########----------\]/);
  assert.match(screen, /COMPLETED/);
  assert.match(screen, /RUNNING/);
  assert.match(screen, /not a provider invoice/);
  assert.equal(screen.split("\n").every((line) => line.length <= 46), true);
  assert.doesNotMatch(screen, /first-wave-result/);
});

test("V2-WATCH: unknown task is not reported as resolved", () => {
  const manifest = makeManifest({
    status: "unknown",
    taskOrder: ["task-one"],
    tasks: { "task-one": { taskId: "task-one", status: "unknown", failureClass: "host_restart_unknown" } }
  });
  const screen = renderParallelBatchScreen(manifest);
  assert.match(screen, /Progress: 0% \(0\/1\)/);
  assert.match(screen, /\[--------------------\]/);
  assert.match(screen, /Unknown: 1/);
});

test("V2-WATCH: manifest path is restricted to a hexadecimal batch identifier", (t) => {
  const manifest = makeManifest();
  const { stateDirectory } = createState(t, manifest);
  assert.throws(() => readBatchManifest(stateDirectory, "..\\secrets"), /hexadecimal ID/);
  assert.equal(readBatchManifest(stateDirectory, manifest.batchId).batchId, manifest.batchId);
});

test("V2-WATCH: watcher refreshes until the manifest reaches terminal state", async (t) => {
  const manifest = {
    ...makeManifest(),
    tasks: {
      "task-one": { taskId: "task-one", status: "completed", durationMs: 1000, endedAt: new Date().toISOString() },
      "task-two": { taskId: "task-two", status: "running", durationMs: 0, startedAt: new Date().toISOString() }
    }
  };
  const { stateDirectory, manifestPath } = createState(t, manifest);
  const output = {
    value: "",
    redraws: 0,
    isTTY: true,
    cursorTo(column, row) {
      assert.deepEqual([column, row], [0, 0]);
      this.value = "";
    },
    clearScreenDown() {
      this.redraws += 1;
    },
    write(text) {
      this.value += text;
    }
  };
  const watching = watchParallelBatch(manifest.batchId, {
    intervalMs: 5,
    loadConfigurationFn: () => ({ statePaths: { state: stateDirectory } }),
    output
  });
  setTimeout(() => {
    const complete = {
      ...manifest,
      status: "result_ready",
      updatedAt: new Date().toISOString(),
      tasks: {
        "task-one": { taskId: "task-one", status: "completed", durationMs: 1000 },
        "task-two": { taskId: "task-two", status: "completed", durationMs: 2000 }
      },
      budget: { capUsd: 1, spentKnownUsd: 0.2, unknownReservedUsd: 0, remainingUsd: 0.8 }
    };
    const temporaryPath = `${manifestPath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(complete), "utf8");
    fs.renameSync(temporaryPath, manifestPath);
  }, 20);
  const result = await watching;
  assert.equal(result.status, "result_ready");
  assert.match(output.value, /100%/);
  assert.doesNotMatch(output.value, /50%/);
  assert.equal(output.redraws >= 2, true);
  assert.match(output.value, /Workers stopped/);
});
