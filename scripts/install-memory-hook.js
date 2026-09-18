import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const bridgeHookPath = path.join(projectRoot, "subagent-bridge", "src", "services", "memory-hook-plugin.js");
const bridgeProviderPath = path.join(projectRoot, "subagent-bridge", "src", "services", "memory-hook.js");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const force = args.includes("--force");
const globalTarget = args.includes("--global");
const targetArgument = args.find((argument) => argument.startsWith("--target="));
const targetPath = targetArgument
  ? path.resolve(targetArgument.slice("--target=".length))
  : globalTarget
    ? path.join(os.homedir(), ".config", "opencode", "plugins", "second-brain-memory.js")
    : path.join(projectRoot, ".opencode", "plugins", "second-brain-memory.js");

function pluginSource(providerUrl, pluginUrl) {
  return [
    `import { createMemoryHook } from ${JSON.stringify(providerUrl)};`,
    `import { createSecondBrainMemoryPlugin } from ${JSON.stringify(pluginUrl)};`,
    "",
    "export const SecondBrainMemoryPlugin = async () => {",
    '  if (process.env.SUBAGENT_SECOND_BRAIN_HOOK !== "1") return {};',
    "  return createSecondBrainMemoryPlugin({ runHook: createMemoryHook() });",
    "};",
    ""
  ].join("\n");
}

const source = pluginSource(pathToFileURL(bridgeProviderPath).href, pathToFileURL(bridgeHookPath).href);
const result = {
  mode: apply ? "apply" : "dry_run",
  targetPath,
  enabledByDefault: false,
  optInEnvironmentVariable: "SUBAGENT_SECOND_BRAIN_HOOK",
  readOnlySearchOnly: true,
  written: false
};

if (apply) {
  if (fs.existsSync(targetPath) && !force) {
    result.reason = "target_exists";
    result.hint = "use --force to overwrite";
    process.exitCode = 1;
  } else {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, source, { encoding: "utf8", flag: "w" });
    result.written = true;
  }
}

console.log(JSON.stringify(result, null, 2));
if (!apply) {
  console.log("");
  console.log(source);
}
