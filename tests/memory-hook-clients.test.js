import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  formatMemoryHookClientOutput,
  parsePromptFromHookInput,
  parseSessionIdFromHookInput,
  parseWorkingDirectoryFromHookInput,
  runMemoryHookClient
} from "../subagent-bridge/src/services/memory-hook-client.js";

function fakeInput(rawText) {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(rawText, "utf8");
    }
  };
}

function fakeOutput() {
  const chunks = [];
  return {
    chunks,
    write(chunk) {
      chunks.push(String(chunk));
    }
  };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function runChild(command, args, env) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(command, args, { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function createCohortFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cohort-install-"));
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot);
  const registryPath = path.join(root, "memory-hook-cohorts.json");
  fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, projects: [{ cohort: "project_beta", roots: [projectRoot] }] }), "utf8");
  return { root, projectRoot, registryPath };
}

test("CLIENT-01: hook girdisinden istem promptu güvenle çıkarılır", () => {
  assert.equal(parsePromptFromHookInput(JSON.stringify({ prompt: "  ikinci   beyin  " })), "ikinci beyin");
  assert.equal(parsePromptFromHookInput(JSON.stringify({ prompt: "x".repeat(600) })).length, 512);
  assert.equal(parsePromptFromHookInput("{bozuk"), "");
  assert.equal(parsePromptFromHookInput(JSON.stringify({ session_id: "s1" })), "");
  assert.equal(parseSessionIdFromHookInput(JSON.stringify({ session_id: "s1" })), "s1");
  assert.equal(parseSessionIdFromHookInput(JSON.stringify({ sessionID: "s2" })), "s2");
  assert.equal(parseSessionIdFromHookInput(JSON.stringify({ session_id: " s3 " })), "s3");
  assert.equal(parseSessionIdFromHookInput(JSON.stringify({ session_id: "x".repeat(513) })), "");
  assert.equal(parseWorkingDirectoryFromHookInput(JSON.stringify({ cwd: "C:\\project" })), "C:\\project");
  assert.equal(parseWorkingDirectoryFromHookInput(JSON.stringify({ cwd: "x".repeat(4097) })), "");
  assert.equal(parsePromptFromHookInput(""), "");
});

test("CLIENT-02: istemci çıktısı belgelenen sözleşmeye uyar", () => {
  const claude = JSON.parse(formatMemoryHookClientOutput("claude", "BAĞLAM"));
  assert.deepEqual(claude, { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "BAĞLAM" } });
  const codex = JSON.parse(formatMemoryHookClientOutput("codex", "BAĞLAM"));
  assert.deepEqual(codex, { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "BAĞLAM" } });
  assert.equal(formatMemoryHookClientOutput("generic", "BAĞLAM"), "BAĞLAM");
  assert.equal(formatMemoryHookClientOutput("claude", ""), "");
  assert.equal(formatMemoryHookClientOutput("codex", null), "");
});

test("CLIENT-03: CLI köprüsü enjeksiyonu yapar, hatada sessiz kalır", async () => {
  const queries = [];
  const injections = [];
  const output = fakeOutput();
  let clock = 0;
  const delivered = await runMemoryHookClient({
    client: "claude",
    now: () => clock,
    input: fakeInput(JSON.stringify({ prompt: "  ikinci   beyin  ", session_id: "s1" })),
    output,
    hook: async ({ query }) => {
      queries.push(query);
      clock += 35;
      return "BAĞLAM";
    },
    onContextInjected: (value) => injections.push(value)
  });
  assert.equal(delivered.delivered, true);
  assert.equal(injections.length, 0);
  await nextTurn();
  assert.deepEqual(queries, ["ikinci beyin"]);
  assert.equal(injections.length, 1);
  assert.equal(injections[0].sessionId, "s1");
  assert.equal(injections[0].durationMs, 35);
  assert.deepEqual(JSON.parse(output.chunks.join("")), {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "BAĞLAM" }
  });
  const failingOutput = fakeOutput();
  const failed = await runMemoryHookClient({
    client: "codex",
    input: fakeInput(JSON.stringify({ prompt: "soru" })),
    output: failingOutput,
    hook: async () => {
      throw new Error("memory unavailable");
    }
  });
  assert.equal(failed.delivered, false);
  assert.equal(failingOutput.chunks.length, 0);
  const emptyOutput = fakeOutput();
  const empty = await runMemoryHookClient({
    client: "claude",
    input: fakeInput("{bozuk"),
    output: emptyOutput,
    hook: async () => "BAĞLAM"
  });
  assert.equal(empty.delivered, false);
  assert.equal(emptyOutput.chunks.length, 0);
  let callbackAfterWriteFailure = false;
  const failedWrite = await runMemoryHookClient({
    client: "codex",
    input: fakeInput(JSON.stringify({ prompt: "soru", session_id: "write-failure" })),
    output: { write() { throw new Error("output unavailable"); } },
    hook: async () => "BAĞLAM",
    onContextInjected: () => { callbackAfterWriteFailure = true; }
  });
  assert.equal(failedWrite.delivered, false);
  assert.equal(callbackAfterWriteFailure, false);
  let asyncCallbackAfterWriteFailure = false;
  const asynchronousFailedOutput = new Writable({
    write(chunk, encoding, callback) {
      setImmediate(() => callback(new Error("async output unavailable")));
    }
  });
  const asynchronousFailure = await runMemoryHookClient({
    client: "codex",
    input: fakeInput(JSON.stringify({ prompt: "soru", session_id: "async-failure" })),
    output: asynchronousFailedOutput,
    hook: async () => "BAĞLAM",
    onContextInjected: () => { asyncCallbackAfterWriteFailure = true; }
  });
  assert.equal(asynchronousFailure.delivered, false);
  assert.equal(asyncCallbackAfterWriteFailure, false);
  asynchronousFailedOutput.destroy();
  const order = [];
  const successfulAsyncOutput = new Writable({
    write(chunk, encoding, callback) {
      order.push(String(chunk));
      setImmediate(() => {
        order.push("written");
        callback();
      });
    }
  });
  const asyncDelivered = await runMemoryHookClient({
    client: "codex",
    input: fakeInput(JSON.stringify({ prompt: "soru", session_id: "async-success" })),
    output: successfulAsyncOutput,
    hook: async () => "BAĞLAM",
    onContextInjected: () => { order.push("session"); }
  });
  await nextTurn();
  assert.equal(asyncDelivered.delivered, true);
  assert.deepEqual(order, ["{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"BAĞLAM\"}}", "written", "session"]);
  successfulAsyncOutput.destroy();
  const promiseOrder = [];
  const promiseOutput = {
    write() {
      promiseOrder.push("writing");
      return new Promise((resolve) => setImmediate(() => {
        promiseOrder.push("written");
        resolve();
      }));
    }
  };
  const promiseDelivered = await runMemoryHookClient({
    client: "codex",
    input: fakeInput(JSON.stringify({ prompt: "soru", session_id: "promise-success" })),
    output: promiseOutput,
    hook: async () => "BAĞLAM",
    onContextInjected: () => { promiseOrder.push("session"); }
  });
  await nextTurn();
  assert.equal(promiseDelivered.delivered, true);
  assert.deepEqual(promiseOrder, ["writing", "written", "session"]);
});

test("CLIENT-04: bozuk girdide CLI süreci sıfır kodla ve çıktısız biter", () => {
  const scriptPath = path.resolve("scripts/memory-hook-client.js");
  const run = childProcess.spawnSync(process.execPath, [scriptPath, "--client=claude"], {
    input: "{bozuk",
    encoding: "utf8"
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "");
});

test("CLIENT-05: claude kurulumu yalnız birleştirilecek snippet üretir", () => {
  const installerPath = path.resolve("scripts/install-memory-hook.js");
  const run = childProcess.spawnSync(process.execPath, [installerPath, "--client=claude"], { encoding: "utf8" });
  assert.equal(run.status, 0);
  const result = JSON.parse(run.stdout.slice(run.stdout.indexOf("{"), run.stdout.lastIndexOf("}") + 1));
  assert.equal(result.mode, "snippet");
  assert.equal(result.manualMergeRequired, true);
  assert.equal(result.written, false);
  assert.equal(result.client, "claude");
  const message = result.snippet.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(message.type, "command");
  assert.equal(message.command, process.execPath);
  assert.deepEqual(message.args, [path.resolve("scripts/memory-hook-client.js"), "--client=claude"]);
  assert.equal("additionalContextLimit" in message, false);
  assert.equal(JSON.stringify(result).includes("store_persistent_memory"), false);
});

test("CLIENT-06: global Codex hook'u yazılır ve yinelenen kurulum idempotent kalır", (context) => {
  const targetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-codex-hook-"));
  context.after(() => fs.rmSync(targetDirectory, { recursive: true, force: true }));
  const target = path.join(targetDirectory, ".codex", "hooks.json");
  const installerPath = path.resolve("scripts/install-memory-hook.js");
  const env = { ...process.env, HOME: targetDirectory, USERPROFILE: targetDirectory };
  const applied = childProcess.spawnSync(process.execPath, [installerPath, "--client=codex", "--apply"], { encoding: "utf8", env });
  assert.equal(applied.status, 0);
  const written = JSON.parse(fs.readFileSync(target, "utf8"));
  const handler = written.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(handler.type, "command");
  assert.match(handler.command, /memory-hook-client\.js/);
  assert.match(handler.command, /--client=codex/);
  assert.match(handler.commandWindows, /memory-hook-client\.js/);
  assert.match(handler.commandWindows, /--client=codex/);
  assert.equal(handler.command.includes(process.execPath), true);
  assert.equal(handler.additionalContextLimit, 1200);
  assert.equal(fs.readFileSync(target, "utf8").includes("store_persistent_memory"), false);
  const repeated = childProcess.spawnSync(process.execPath, [installerPath, "--client=codex", "--apply"], { encoding: "utf8", env });
  assert.equal(repeated.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), written);
});

test("CLIENT-08: Codex project config mevcut ayarları koruyarak güvenle merge edilir", (context) => {
  const fixture = createCohortFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const target = path.join(fixture.projectRoot, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = {
    description: "preserve this setting",
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "existing-start-hook" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "existing-prompt-hook" }] }]
    }
  };
  fs.writeFileSync(target, JSON.stringify(existing), "utf8");
  const installerPath = path.resolve("scripts/install-memory-hook.js");
  const env = { ...process.env, SUBAGENT_MEMORY_HOOK_COHORT_REGISTRY: fixture.registryPath };
  const applied = childProcess.spawnSync(process.execPath, [installerPath, "--client=codex", "--apply", `--project-root=${fixture.projectRoot}`, "--cohort=project_beta"], { encoding: "utf8", env });
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  const mergedText = fs.readFileSync(target, "utf8");
  const merged = JSON.parse(mergedText);
  assert.equal(merged.description, existing.description);
  assert.deepEqual(merged.hooks.SessionStart, existing.hooks.SessionStart);
  assert.equal(merged.hooks.UserPromptSubmit.length, 2);
  assert.equal(merged.hooks.UserPromptSubmit[0].hooks[0].command, "existing-prompt-hook");
  assert.match(merged.hooks.UserPromptSubmit[1].hooks[0].command, /--cohort=project_beta/);
  const repeated = childProcess.spawnSync(process.execPath, [installerPath, "--client=codex", "--apply", "--force", `--project-root=${fixture.projectRoot}`, "--cohort=project_beta"], { encoding: "utf8", env });
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  assert.equal(fs.readFileSync(target, "utf8"), mergedText);
});

test("CLIENT-09: named global cohort reddedilir, project omission sabit unassigned olur", (context) => {
  const fixture = createCohortFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const installerPath = path.resolve("scripts/install-memory-hook.js");
  const env = { ...process.env, SUBAGENT_MEMORY_HOOK_COHORT_REGISTRY: fixture.registryPath };
  const globalNamed = childProcess.spawnSync(process.execPath, [installerPath, "--client=codex", "--global", "--cohort=project_beta"], { encoding: "utf8", env });
  assert.equal(globalNamed.status, 1);
  assert.equal(JSON.parse(globalNamed.stdout).reason, "global_named_cohort_rejected");
  const projectUnassigned = childProcess.spawnSync(process.execPath, [installerPath, "--client=codex", `--project-root=${fixture.projectRoot}`], { encoding: "utf8", env });
  assert.equal(projectUnassigned.status, 0, projectUnassigned.stderr || projectUnassigned.stdout);
  const generated = JSON.parse(projectUnassigned.stdout.slice(projectUnassigned.stdout.indexOf("{"), projectUnassigned.stdout.indexOf("}") + 1));
  assert.equal(generated.runtimeCohort, "unassigned");
  const handler = JSON.parse(projectUnassigned.stdout.slice(projectUnassigned.stdout.indexOf("{\n  \"hooks\""))).hooks.UserPromptSubmit[0].hooks[0];
  assert.match(handler.command, /--cohort=unassigned/);
});

test("CLIENT-10: Claude project snippet sabit cohort taşır ve global omission dinamik kalır", (context) => {
  const fixture = createCohortFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const installerPath = path.resolve("scripts/install-memory-hook.js");
  const env = { ...process.env, SUBAGENT_MEMORY_HOOK_COHORT_REGISTRY: fixture.registryPath };
  const project = childProcess.spawnSync(process.execPath, [installerPath, "--client=claude", `--project-root=${fixture.projectRoot}`, "--cohort=project_beta"], { encoding: "utf8", env });
  assert.equal(project.status, 0, project.stderr || project.stdout);
  const projectResult = JSON.parse(project.stdout);
  const projectHook = projectResult.snippet.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(projectResult.targetExpected, path.join(fs.realpathSync.native(fixture.projectRoot), ".claude", "settings.local.json"));
  assert.deepEqual(projectHook.args, [path.resolve("scripts/memory-hook-client.js"), "--client=claude", "--cohort=project_beta"]);
  const global = childProcess.spawnSync(process.execPath, [installerPath, "--client=claude", "--global"], { encoding: "utf8", env });
  assert.equal(global.status, 0);
  const globalResult = JSON.parse(global.stdout);
  assert.deepEqual(globalResult.snippet.hooks.UserPromptSubmit[0].hooks[0].args, [path.resolve("scripts/memory-hook-client.js"), "--client=claude"]);
});

test("CLIENT-11: Codex global omission cwd ile dynamic çözer ve named mismatch unassigned olur", async (context) => {
  const fixture = createCohortFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const injections = [];
  const dynamic = await runMemoryHookClient({
    client: "codex",
    registryPath: fixture.registryPath,
    input: fakeInput(JSON.stringify({ prompt: "soru", session_id: "global-dynamic", cwd: fixture.projectRoot })),
    output: fakeOutput(),
    hook: async () => "CONTEXT",
    onContextInjected: (value) => injections.push(value)
  });
  await nextTurn();
  assert.equal(dynamic.projectCohort, "project_beta");
  assert.equal(injections[0].projectCohort, "project_beta");
  const mismatch = await runMemoryHookClient({
    client: "claude",
    requestedCohort: "project_alpha",
    registryPath: fixture.registryPath,
    input: fakeInput(JSON.stringify({ prompt: "soru", session_id: "project-mismatch", cwd: fixture.projectRoot })),
    output: fakeOutput(),
    hook: async () => "CONTEXT",
    onContextInjected: (value) => injections.push(value)
  });
  await nextTurn();
  assert.equal(mismatch.projectCohort, "unassigned");
  assert.equal(injections[1].projectCohort, "unassigned");
  assert.equal(JSON.stringify({ dynamic, mismatch, injections }).includes(fixture.projectRoot), false);
});

test("CLIENT-12: üç istemcide statik named global cohort reddedilir", (context) => {
  const fixture = createCohortFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const installerPath = path.resolve("scripts/install-memory-hook.js");
  const env = { ...process.env, SUBAGENT_MEMORY_HOOK_COHORT_REGISTRY: fixture.registryPath };
  for (const client of ["opencode", "codex", "claude"]) {
    const run = childProcess.spawnSync(process.execPath, [installerPath, `--client=${client}`, "--global", "--cohort=project_beta"], { encoding: "utf8", env });
    assert.equal(run.status, 1, `${client}: ${run.stdout} ${run.stderr}`);
    assert.equal(JSON.parse(run.stdout).reason, "global_named_cohort_rejected");
  }
});

test("CLIENT-13: paralel Codex kurulumları aynı handler'ı bir kez merge eder", async (context) => {
  const fixture = createCohortFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const target = path.join(fixture.projectRoot, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "keep-me" }] }] } };
  fs.writeFileSync(target, JSON.stringify(existing), "utf8");
  const installerPath = path.resolve("scripts/install-memory-hook.js");
  const env = { ...process.env, SUBAGENT_MEMORY_HOOK_COHORT_REGISTRY: fixture.registryPath };
  const args = [installerPath, "--client=codex", "--apply", `--project-root=${fixture.projectRoot}`, "--cohort=project_beta"];
  const results = await Promise.all([runChild(process.execPath, args, env), runChild(process.execPath, args, env)]);
  assert.deepEqual(results.map((result) => result.status), [0, 0]);
  const merged = JSON.parse(fs.readFileSync(target, "utf8"));
  const handlers = merged.hooks.UserPromptSubmit.flatMap((group) => group.hooks);
  assert.equal(merged.hooks.SessionStart[0].hooks[0].command, "keep-me");
  assert.equal(handlers.filter((handler) => handler.command.includes("--cohort=project_beta")).length, 1);
  assert.equal(fs.existsSync(`${target}.second-brain-install.lock`), false);
});


test("CLIENT-07: saat gerilemesinde sure sifira kirpilir", async () => {
  const injections = [];
  const output = fakeOutput();
  let clock = 100;
  const delivered = await runMemoryHookClient({
    client: "codex",
    now: () => clock,
    input: fakeInput(JSON.stringify({ prompt: "soru", session_id: "clock-regression" })),
    output,
    hook: async () => {
      clock -= 40;
      return "BAGLAM";
    },
    onContextInjected: (value) => injections.push(value)
  });
  assert.equal(delivered.delivered, true);
  await nextTurn();
  assert.equal(injections.length, 1);
  assert.equal(injections[0].sessionId, "clock-regression");
  assert.equal(injections[0].durationMs, 0);
});
