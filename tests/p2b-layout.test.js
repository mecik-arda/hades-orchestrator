import test from "node:test";
import assert from "node:assert/strict";
import { getPersonalBridgeLayout } from "../subagent-bridge/src/personal-layout.js";

test("P2B-LAYOUT: personal config and runtime state roots remain separate", () => {
  const layout = getPersonalBridgeLayout({
    homeDirectory: "C:\\Users\\personal",
    localAppData: "C:\\Users\\personal\\AppData\\Local"
  });
  assert.equal(layout.configRoot, "C:\\Users\\personal\\.config\\subagent-bridge");
  assert.equal(layout.configPath, "C:\\Users\\personal\\.config\\subagent-bridge\\config.json");
  assert.equal(layout.agentsPath, "C:\\Users\\personal\\.config\\subagent-bridge\\agents.json");
  assert.equal(layout.logs, "C:\\Users\\personal\\AppData\\Local\\subagent-bridge\\logs");
  assert.equal(layout.state, "C:\\Users\\personal\\AppData\\Local\\subagent-bridge\\state");
  assert.equal(layout.cache, "C:\\Users\\personal\\AppData\\Local\\subagent-bridge\\cache");
});
