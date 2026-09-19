import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const bridgeHookPath = path.join(projectRoot, "subagent-bridge", "src", "services", "memory-hook-plugin.js");
const bridgeProviderPath = path.join(projectRoot, "subagent-bridge", "src", "services", "memory-hook.js");
const clientScriptPath = path.join(projectRoot, "scripts", "memory-hook-client.js");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const force = args.includes("--force");
const globalTarget = args.includes("--global");
const clientArgument = args.find((argument) => argument.startsWith("--client="));
const client = clientArgument ? clientArgument.slice("--client=".length) : "opencode";
const targetArgument = args.find((argument) => argument.startsWith("--target="));

function defaultTarget() {
  if (targetArgument) return path.resolve(targetArgument.slice("--target=".length));
  if (client === "codex") return path.join(os.homedir(), ".codex", "hooks.json");
  if (globalTarget) return path.join(os.homedir(), ".config", "opencode", "plugins", "second-brain-memory.js");
  return path.join(projectRoot, ".opencode", "plugins", "second-brain-memory.js");
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function quoteWindows(value) {
  const text = String(value);
  if (/[%\r\n"]/.test(text)) throw new Error("unsafe command path");
  return `"${text}"`;
}

function openCodePluginSource() {
  return [
    `import { createMemoryHook } from ${JSON.stringify(pathToFileURL(bridgeProviderPath).href)};`,
    `import { createSecondBrainMemoryPlugin } from ${JSON.stringify(pathToFileURL(bridgeHookPath).href)};`,
    "",
    "export const SecondBrainMemoryPlugin = async () => {",
    '  if (process.env.SUBAGENT_SECOND_BRAIN_HOOK !== "1") return {};',
    "  return createSecondBrainMemoryPlugin({ runHook: createMemoryHook() });",
    "};",
    ""
  ].join("\n");
}

function codexCommand() {
  if (process.platform === "win32") {
    return `${quoteWindows(process.execPath)} ${quoteWindows(clientScriptPath)} --client=codex`;
  }
  return `${quotePosix(process.execPath)} ${quotePosix(clientScriptPath)} --client=codex`;
}

function codexHookConfiguration() {
  return {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: codexCommand(),
              commandWindows: `${quoteWindows(process.execPath)} ${quoteWindows(clientScriptPath)} --client=codex`,
              additionalContextLimit: 1200,
              statusMessage: "Second brain memory (read-only)"
            }
          ]
        }
      ]
    }
  };
}

function claudeHookSnippet() {
  return {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: process.execPath,
              args: [clientScriptPath, "--client=claude"]
            }
          ]
        }
      ]
    }
  };
}

const targetPath = defaultTarget();
const result = {
  mode: apply ? "apply" : "dry_run",
  client,
  targetPath,
  enabledByDefault: false,
  optInEnvironmentVariable: "SUBAGENT_SECOND_BRAIN_HOOK",
  readOnlySearchOnly: true,
  failClosedOnExistingTarget: true,
  payloadRewritten: false,
  written: false
};

function writeTarget(source) {
  if (fs.existsSync(targetPath) && !force) {
    result.reason = "target_exists";
    result.hint = "use --force to overwrite";
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, source, { encoding: "utf8", flag: "w" });
  result.written = true;
  result.payloadRewritten = true;
}

if (client === "claude") {
  result.mode = "snippet";
  result.manualMergeRequired = true;
  result.snippet = claudeHookSnippet();
  console.log(JSON.stringify(result, null, 2));
} else if (client === "codex") {
  result.trustReviewRequired = true;
  let source;
  try {
    source = `${JSON.stringify(codexHookConfiguration(), null, 2)}\n`;
  } catch {
    result.reason = "unsafe_command_path";
    process.exitCode = 1;
  }
  if (source) {
    if (apply) writeTarget(source);
    console.log(JSON.stringify(result, null, 2));
    if (!apply) {
      console.log("");
      console.log(source);
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
} else if (client === "opencode") {
  const source = openCodePluginSource();
  if (apply) writeTarget(source);
  console.log(JSON.stringify(result, null, 2));
  if (!apply) {
    console.log("");
    console.log(source);
  }
} else {
  result.reason = "unsupported_client";
  process.exitCode = 1;
  console.log(JSON.stringify(result, null, 2));
}
