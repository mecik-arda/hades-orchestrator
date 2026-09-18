import test from "node:test";
import assert from "node:assert/strict";
import { publicToolSchemas } from "../subagent-bridge/src/frontends/mcp/tools.js";

const wrongTypePayloads = {
  runAntigravity: { prompt: 42, model: "gemini_pro", mode: "read_only" },
  runClaudeCode: { prompt: 42, mode: "read_only" },
  runOpenCode: { prompt: "soru", model: 42, mode: "read_only" },
  runCodex: { prompt: false, mode: "read_only" },
  runProfile: { prompt: "soru", profile: 42 },
  runDeepSeek: { taskId: 1, role: "analyst", mode: "read_only", objective: "hedef", workspace: "ws", acceptanceCriteria: ["kriter"] },
  runDeepSeekEditPilot: { taskId: "t1", objective: "hedef", files: "dosya", acceptanceCriteria: ["kriter"] },
  runGlm: { taskId: 1, role: "analyst", mode: "read_only", objective: "hedef", acceptanceCriteria: ["kriter"] },
  runGlmEditPilot: { taskId: "t1", objective: "hedef", files: ["dosya"], acceptanceCriteria: "kriter" },
  runCatalogProvider: { taskId: "t1", role: "analyst", model: 42, mode: "read_only", objective: "hedef", acceptanceCriteria: ["kriter"] },
  approvePreparedEdit: { approvalRequestId: 123 },
  checkProviderCapability: { provider: 42 }
};

test("MCP-NEG-01: her public MCP şeması bilinmeyen alanı reddeder", () => {
  const names = Object.keys(publicToolSchemas);
  assert.ok(names.length >= 12, `beklenen araç sayısı, bulunan: ${names.length}`);
  for (const name of names) {
    const result = publicToolSchemas[name].safeParse({ unexpected_field_for_test: true });
    assert.equal(result.success, false, `${name} bilinmeyen alanı kabul etti`);
  }
});

test("MCP-NEG-02: her public MCP şeması boş girdiyi reddeder", () => {
  for (const [name, schema] of Object.entries(publicToolSchemas)) {
    const result = schema.safeParse({});
    assert.equal(result.success, false, `${name} boş girdiyi kabul etti`);
  }
});

test("MCP-NEG-03: her public MCP şeması yanlış tipte alanı reddeder", () => {
  for (const [name, schema] of Object.entries(publicToolSchemas)) {
    const payload = wrongTypePayloads[name];
    assert.ok(payload, `${name} için yanlış tip fixture eksik`);
    const result = schema.safeParse(payload);
    assert.equal(result.success, false, `${name} yanlış tipi kabul etti`);
  }
});
