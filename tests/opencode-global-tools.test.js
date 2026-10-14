import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderGlobalOpenCodeTools } from "../scripts/opencode-global-tools.js";

test("OPENCODE-TOOLS: rendered global wrapper is reproducible from the tracked template", () => {
  const source = renderGlobalOpenCodeTools(process.cwd());
  assert.equal(source.includes("__BRIDGE_ROOT__"), false);
  assert.match(source, /export const codex = createCodexModelReadOnlyTool\("gpt-6\.1-sol"/);
  assert.match(source, /export const codexSol6 = createCodexModelReadOnlyTool\("gpt-6-sol"/);
  assert.match(source, /export const codexSol61 = createCodexModelReadOnlyTool\("gpt-6\.1-sol"/);
  assert.equal(source.includes("export const geminiPro"), false);
  assert.equal(source.includes("export const geminiFlash37"), false);
  assert.match(source, /export const geminiFlash38 = createReadOnlyTool\("gemini_flash_3_8"\)/);
  assert.equal(source.includes("SUBAGENT_BRIDGE_TRUSTED_WORKSPACE"), false);
  assert.equal(fs.existsSync(path.join(process.cwd(), "templates", "opencode", "subagent-bridge.js")), true);
});
