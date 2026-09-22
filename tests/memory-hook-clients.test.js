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

test("CLIENT-01: hook girdisinden istem promptu güvenle çıkarılır", () => {
  assert.equal(parsePromptFromHookInput(JSON.stringify({ prompt: "  ikinci   beyin  " })), "ikinci beyin");
  assert.equal(parsePromptFromHookInput(JSON.stringify({ prompt: "x".repeat(600) })).length, 512);
  assert.equal(parsePromptFromHookInput("{bozuk"), "");
  assert.equal(parsePromptFromHookInput(JSON.stringify({ session_id: "s1" })), "");
  assert.equal(parseSessionIdFromHookInput(JSON.stringify({ session_id: "s1" })), "s1");
  assert.equal(parseSessionIdFromHookInput(JSON.stringify({ sessionID: "s2" })), "s2");
  assert.equal(parseSessionIdFromHookInput(JSON.stringify({ session_id: " s3 " })), "s3");
  assert.equal(parseSessionIdFromHookInput(JSON.stringify({ session_id: "x".repeat(513) })), "");
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

test("CLIENT-06: codex kurulumu hooks.json yazar ve mevcut hedefte fail-closed olur", (context) => {
  const targetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-codex-hook-"));
  context.after(() => fs.rmSync(targetDirectory, { recursive: true, force: true }));
  const target = path.join(targetDirectory, "hooks.json");
  const installerPath = path.resolve("scripts/install-memory-hook.js");
  const applied = childProcess.spawnSync(process.execPath, [installerPath, "--client=codex", "--apply", `--target=${target}`], { encoding: "utf8" });
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
  const refused = childProcess.spawnSync(process.execPath, [installerPath, "--client=codex", "--apply", `--target=${target}`], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), written);
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
