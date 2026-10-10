import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const templatePath = path.join(projectRoot, "templates", "opencode", "subagent-bridge.js");

export function getGlobalOpenCodeToolsPath(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, ".config", "opencode", "tools", "subagent-bridge.js");
}

export function renderGlobalOpenCodeTools(bridgeRoot = projectRoot) {
  const normalizedRoot = path.resolve(bridgeRoot);
  const template = fs.readFileSync(templatePath, "utf8");
  return template.replaceAll("__BRIDGE_ROOT__", pathToFileURL(normalizedRoot).href);
}
