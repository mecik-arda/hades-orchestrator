import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendRedactedRunMetric } from "../subagent-bridge/src/metrics.js";
import { clearProjectMirror, disableProjectMirror, enableProjectMirror, getProjectMirrorStatus, readProjectMirror } from "../subagent-bridge/src/project-runs.js";
import { parseRecentRunsArguments, readRecentRuns } from "../subagent-bridge/src/recent-runs.js";

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function configuration(root, workspace) {
  return {
    allowedRoots: [root],
    deepseek: { deniedRootPaths: [] },
    statePaths: {
      logs: path.join(root, "machine-logs"),
      state: path.join(root, "machine-state"),
      cache: path.join(root, "machine-cache")
    },
    observability: { maxMetricFileBytes: 16 * 1024 * 1024 },
    orchestration: {
      taskProfiles: {
        review: { target: "codex", model: "gpt-test", mode: "read_only", priority: 1, cacheable: false }
      }
    },
    workspace
  };
}

function executionRecord(overrides = {}) {
  return {
    recordedAt: "2026-08-11T12:00:00.000Z",
    backend: "codex",
    modelHash: hash("gpt-test"),
    executionIdHash: hash("execution"),
    workspaceHash: hash("workspace"),
    mode: "read_only",
    profile: "review",
    outcomeStatus: "completed",
    failureClass: null,
    usage: { durationMs: 1200, totalCostUsd: 0.01 },
    attempts: [{ number: 1, failureClass: null, exitCode: 0, durationMs: 1200, totalCostUsd: 0.01, retryDelayMs: null }],
    retries: 0,
    queueWaitMs: 0,
    cacheHit: false,
    ...overrides
  };
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((record) => typeof record === "string" ? record : JSON.stringify(record)).join("\n")}\n`, "utf8");
}

test("RUNS-01: recent runs argümanları strict doğrulanır", () => {
  assert.deepEqual(parseRecentRunsArguments(["--days=14", "--limit=50"]), { days: 14, limit: 50 });
  assert.throws(() => parseRecentRunsArguments(["--days=1", "--days=2"]), /supported arguments/);
  assert.throws(() => parseRecentRunsArguments(["--unknown=1"]), /supported arguments/);
});

test("RUNS-02: global reader yalnız yapısal run ve feedback alanlarını gösterir", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recent-runs-reader-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const metricsDirectory = path.join(config.statePaths.logs, "metrics");
  const run = executionRecord();
  writeJsonl(path.join(metricsDirectory, "codex-runs.jsonl"), [
    run,
    { recordType: "health_snapshot", recordedAt: run.recordedAt, backend: "bridge", secret: "must-not-appear" },
    "{broken-json"
  ]);
  writeJsonl(path.join(metricsDirectory, "routing-evaluation-runs.jsonl"), [{
    recordType: "routing_feedback",
    recordedAt: "2026-08-11T12:01:00.000Z",
    backend: "routing-evaluation",
    executionIdHash: run.executionIdHash,
    outcome: "useful"
  }]);
  writeJsonl(path.join(metricsDirectory, "direct-edit-baseline-runs.jsonl"), [{
    recordType: "direct_edit_feedback",
    recordedAt: "2026-08-11T12:01:00.000Z",
    backend: "direct-edit-baseline",
    executionIdHash: run.executionIdHash,
    outcome: "accepted"
  }]);
  const result = readRecentRuns(config, { now: new Date("2026-08-11T13:00:00.000Z") });
  assert.equal(result.runCount, 1);
  assert.equal(result.runs[0].modelDisplay, "gpt-test");
  assert.deepEqual(result.runs[0].feedback, { routing: "useful", directEdit: "accepted" });
  assert.equal(JSON.stringify(result).includes("must-not-appear"), false);
  assert.equal(JSON.stringify(result).includes(metricsDirectory), false);
  assert.equal(result.invalidRecordCount > 0, true);
});

test("RUNS-03: legacy kayıtlar ayrılır ve çelişkili execution gösterilmez", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recent-runs-conflict-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const metricsDirectory = path.join(config.statePaths.logs, "metrics");
  const conflict = executionRecord();
  const legacy = {
    recordedAt: "2026-08-11T11:00:00.000Z",
    backend: "deepseek",
    runIdHash: hash("legacy-run"),
    taskIdHash: hash("legacy-task"),
    agent: "deepseek",
    role: "reviewer",
    modelHash: hash("legacy-model"),
    outcomeStatus: "completed",
    failureClass: null,
    usage: { durationMs: 500, totalCostUsd: 0.001 },
    attempts: [{ number: 1, failureClass: null, exitCode: 0, durationMs: 500, apiDurationMs: null, turns: null, totalCostUsd: 0.001, retryDelayMs: null }]
  };
  writeJsonl(path.join(metricsDirectory, "deepseek-runs.jsonl"), [legacy, legacy]);
  writeJsonl(path.join(metricsDirectory, "codex-runs.jsonl"), [conflict, { ...conflict, outcomeStatus: "failed", failureClass: "process_exit" }]);
  const result = readRecentRuns(config, { now: new Date("2026-08-11T13:00:00.000Z") });
  assert.equal(result.runCount, 1);
  assert.equal(result.conflictCount, 1);
  assert.equal(result.runs[0].role, "reviewer");
  assert.equal(result.runs[0].mode, "not_applicable");
  assert.deepEqual(result.runs[0].feedback, { routing: "not_applicable", directEdit: "not_applicable" });
});

test("RUNS-04: global reader boş dizinde yazma yapmaz ve kaynak sınırını bildirir", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recent-runs-bounds-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const metricsDirectory = path.join(config.statePaths.logs, "metrics");
  assert.equal(readRecentRuns(config).runCount, 0);
  assert.equal(fs.existsSync(metricsDirectory), false);
  writeJsonl(path.join(metricsDirectory, "codex-runs.jsonl"), [executionRecord()]);
  const result = readRecentRuns(config, { now: new Date("2026-08-11T13:00:00.000Z"), maxBytes: 1 });
  assert.equal(result.truncated, true);
  assert.equal(result.runCount, 0);
});

test("RUNS-05: hard-link metrics dosyası okunmaz", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recent-runs-hardlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root);
  const sourcePath = path.join(root, "outside.jsonl");
  const metricsDirectory = path.join(config.statePaths.logs, "metrics");
  fs.mkdirSync(metricsDirectory, { recursive: true });
  fs.writeFileSync(sourcePath, `${JSON.stringify(executionRecord())}\n`, "utf8");
  fs.linkSync(sourcePath, path.join(metricsDirectory, "codex-runs.jsonl"));
  assert.equal(readRecentRuns(config, { now: new Date("2026-08-11T13:00:00.000Z") }).runCount, 0);
});

test("RUNS-06: mirror enable açık onay, Git ignore ve machine binding uygular", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-runs-enable-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".gitignore"), "node_modules/\n", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root, workspace);
  await assert.rejects(() => enableProjectMirror(config, workspace), /approval/);
  assert.equal(fs.existsSync(path.join(workspace, ".hades")), false);
  await enableProjectMirror(config, workspace, { gitIgnore: true });
  await enableProjectMirror(config, workspace, { gitIgnore: true });
  assert.equal(fs.readFileSync(path.join(workspace, ".gitignore"), "utf8").match(/\.hades\//g).length, 1);
  assert.deepEqual(getProjectMirrorStatus(config, workspace), {
    enabled: true,
    activeBytes: 0,
    rotatedCount: 0,
    lastErrorClass: null,
    lastErrorAt: null
  });
  const state = fs.readFileSync(path.join(config.statePaths.state, "project-run-mirrors.json"), "utf8");
  assert.equal(state.includes(workspace), false);
});

test("RUNS-07: canonical metric sonrası mirror yazılır, görüntülenir ve disable edilir", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-runs-write-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root, workspace);
  await enableProjectMirror(config, workspace, { nonGitWrite: true });
  const metric = executionRecord();
  const first = await appendRedactedRunMetric(config, metric, { workspace });
  assert.equal(first.written, true);
  assert.equal(first.mirror.written, true);
  const view = readProjectMirror(config, workspace);
  assert.equal(view.runCount, 1);
  assert.equal(view.runs[0].opaqueRunHash, metric.executionIdHash);
  assert.equal(JSON.stringify(view).includes("workspace"), false);
  await disableProjectMirror(config, workspace);
  const second = await appendRedactedRunMetric(config, executionRecord({ executionIdHash: hash("second") }), { workspace });
  assert.deepEqual(second.mirror, { written: false, reason: "disabled" });
  assert.equal(readProjectMirror(config, workspace).runCount, 1);
});

test("RUNS-08: mirror hard-link hedefini reddeder ve canonical metric korunur", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-runs-hardlink-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root, workspace);
  await enableProjectMirror(config, workspace, { nonGitWrite: true });
  const outside = path.join(root, "outside.jsonl");
  fs.writeFileSync(outside, "", "utf8");
  fs.linkSync(outside, path.join(workspace, ".hades", "runs.jsonl"));
  const result = await appendRedactedRunMetric(config, executionRecord(), { workspace });
  assert.equal(result.written, true);
  assert.deepEqual(result.mirror, { written: false, reason: "unsafe_path" });
  assert.equal(fs.readFileSync(outside, "utf8"), "");
  assert.equal(fs.existsSync(path.join(config.statePaths.logs, "metrics", "codex-runs.jsonl")), true);
});

test("RUNS-09: mirror 5 MiB sınırında rotate olur ve clear onay ister", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-runs-rotate-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root, workspace);
  await enableProjectMirror(config, workspace, { nonGitWrite: true });
  const activePath = path.join(workspace, ".hades", "runs.jsonl");
  const mirrorLine = `${JSON.stringify({
    recordedAt: "2026-08-11T12:00:00.000Z",
    opaqueRunHash: hash("seed"),
    profile: "review",
    role: null,
    backend: "codex",
    mode: "read_only",
    outcomeStatus: "completed",
    failureClass: null,
    durationMs: 1,
    reportedCostUsd: 0,
    cacheHit: false,
    retries: 0,
    integrity: "untrusted_project_mirror"
  })}\n`;
  const repetitions = Math.ceil((5 * 1024 * 1024 - 16) / Buffer.byteLength(mirrorLine));
  fs.writeFileSync(activePath, mirrorLine.repeat(repetitions), "utf8");
  for (let index = 0; index < 5; index += 1) {
    const rotatedPath = path.join(workspace, ".hades", `runs-2026-08-0${index + 1}T00-00-00-000Z-${crypto.randomUUID()}.jsonl`);
    fs.writeFileSync(rotatedPath, mirrorLine, "utf8");
    fs.utimesSync(rotatedPath, new Date(2026, 7, index + 1), new Date(2026, 7, index + 1));
  }
  const result = await appendRedactedRunMetric(config, executionRecord(), { workspace });
  assert.equal(result.mirror.written, true);
  assert.equal(getProjectMirrorStatus(config, workspace).rotatedCount, 5);
  await assert.rejects(() => clearProjectMirror(config, workspace), /--confirm/);
  const cleared = await clearProjectMirror(config, workspace, true);
  assert.equal(cleared.cleared, 6);
  assert.equal(getProjectMirrorStatus(config, workspace).enabled, true);
});

test("RUNS-10: eşzamanlı süreçler mirror satırı kaybetmez", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-runs-concurrent-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = configuration(root, workspace);
  await enableProjectMirror(config, workspace, { nonGitWrite: true });
  const metricsModule = new URL("../subagent-bridge/src/metrics.js", import.meta.url).href;
  const write = (index) => new Promise((resolve, reject) => {
    const metric = executionRecord({ executionIdHash: hash(`concurrent-${index}`) });
    const source = `import { appendRedactedRunMetric } from ${JSON.stringify(metricsModule)}; const result = await appendRedactedRunMetric(${JSON.stringify(config)}, ${JSON.stringify(metric)}, { workspace: ${JSON.stringify(workspace)} }); process.stdout.write(JSON.stringify(result.mirror));`;
    const child = childProcess.spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`mirror writer exited with ${code}: ${stderr.trim()}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`mirror writer returned invalid output: ${stdout}`));
      }
    });
  });
  const writes = await Promise.all(Array.from({ length: 8 }, (_, index) => write(index)));
  assert.deepEqual(writes.map((result) => result.written), Array(8).fill(true));
  assert.equal(readProjectMirror(config, workspace, { limit: 20 }).runCount, 8);
});
