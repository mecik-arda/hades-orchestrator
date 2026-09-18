import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatMemoryHookClientOutput,
  parsePromptFromHookInput,
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

test("CLIENT-01: hook girdisinden istem promptu güvenle çıkarılır", () => {
  assert.equal(parsePromptFromHookInput(JSON.stringify({ prompt: "  ikinci   beyin  " })), "ikinci beyin");
  assert.equal(parsePromptFromHookInput(JSON.stringify({ prompt: "x".repeat(600) })).length, 512);
  assert.equal(parsePromptFromHookInput("{bozuk"), "");
  assert.equal(parsePromptFromHookInput(JSON.stringify({ session_id: "s1" })), "");
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
  const output = fakeOutput();
  const delivered = await runMemoryHookClient({
    client: "claude",
    input: fakeInput(JSON.stringify({ prompt: "  ikinci   beyin  " })),
    output,
    hook: async ({ query }) => {
      queries.push(query);
      return "BAĞLAM";
    }
  });
  assert.equal(delivered.delivered, true);
  assert.deepEqual(queries, ["ikinci beyin"]);
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
