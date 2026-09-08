import os from "node:os";
import path from "node:path";

export function getPersonalBridgeLayout(options = {}) {
  const homeDirectory = options.homeDirectory || os.homedir();
  const localAppData = options.localAppData || process.env.LOCALAPPDATA || path.join(homeDirectory, "AppData", "Local");
  const configRoot = path.join(homeDirectory, ".config", "subagent-bridge");
  const runtimeRoot = path.join(localAppData, "subagent-bridge");
  return {
    configRoot,
    configPath: path.join(configRoot, "config.json"),
    agentsPath: path.join(configRoot, "agents.json"),
    logs: path.join(runtimeRoot, "logs"),
    state: path.join(runtimeRoot, "state"),
    cache: path.join(runtimeRoot, "cache")
  };
}
