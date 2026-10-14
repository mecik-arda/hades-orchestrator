import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getGlobalOpenCodeToolsPath, renderGlobalOpenCodeTools } from "./opencode-global-tools.js";

const [action, requestedRoot] = process.argv.slice(2);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
if (!new Set(["--write", "--check"]).has(action)) {
  throw new Error("Use --write to install generated global tools or --check to verify the installed copy.");
}

const bridgeRoot = requestedRoot ? path.resolve(requestedRoot) : path.resolve(scriptDirectory, "..");
const sourcePath = path.join(bridgeRoot, "subagent-bridge", "src", "server.js");
if (!fs.existsSync(sourcePath)) throw new Error("The selected bridge root does not contain the bridge server.");
const destinationPath = getGlobalOpenCodeToolsPath();
const rendered = renderGlobalOpenCodeTools(bridgeRoot);

if (action === "--check") {
  const matches = fs.existsSync(destinationPath) && fs.readFileSync(destinationPath, "utf8") === rendered;
  console.log(JSON.stringify({ ok: matches, action, globalWrapperReady: matches }));
  if (!matches) process.exitCode = 1;
} else {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, rendered, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporaryPath, destinationPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
  console.log(JSON.stringify({ ok: true, action, globalWrapperReady: true }));
}
