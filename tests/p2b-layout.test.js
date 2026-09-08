import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { getPersonalBridgeLayout } from "../subagent-bridge/src/personal-layout.js";

test("P2B-LAYOUT: personal config and runtime state roots remain separate", () => {
  const layout = getPersonalBridgeLayout({
    homeDirectory: "C:\\Users\\personal",
    localAppData: "C:\\Users\\personal\\AppData\\Local"
  });
  assert.equal(layout.configRoot, path.join("C:\\Users\\personal", ".config", "subagent-bridge"));
  assert.equal(layout.configPath, path.join("C:\\Users\\personal", ".config", "subagent-bridge", "config.json"));
  assert.equal(layout.agentsPath, path.join("C:\\Users\\personal", ".config", "subagent-bridge", "agents.json"));
  assert.equal(layout.logs, path.join("C:\\Users\\personal\\AppData\\Local", "subagent-bridge", "logs"));
  assert.equal(layout.state, path.join("C:\\Users\\personal\\AppData\\Local", "subagent-bridge", "state"));
  assert.equal(layout.cache, path.join("C:\\Users\\personal\\AppData\\Local", "subagent-bridge", "cache"));
});
