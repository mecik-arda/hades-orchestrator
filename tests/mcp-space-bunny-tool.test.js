import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSubagentMcpServer } from "../subagent-bridge/src/frontends/mcp/server.js";

test("SPACE-BUNNY-MCP-01: MCP read-only tool publishes its schema and dispatches selected model", async () => {
  const runtimeCalls = [];
  const runtime = {
    runSpaceBunny: async (input) => {
      runtimeCalls.push(input);
      return { status: "completed", ok: true, result: "OK" };
    }
  };
  const server = createSubagentMcpServer({ runtime, configuration: {}, trustedWorkspace: os.tmpdir() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "space-bunny-tool-contract-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  try {
    const tools = await client.listTools();
    const tool = tools.tools.find((entry) => entry.name === "run_space_bunny_subagent");
    assert.ok(tool);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), [
      "acceptanceCriteria",
      "contextFiles",
      "files",
      "mode",
      "objective",
      "role",
      "taskId",
      "timeout_seconds",
      "webResearch"
    ]);
    assert.deepEqual([...tool.inputSchema.required].sort(), ["objective", "role", "taskId"]);

    const result = await client.callTool({
      name: "run_space_bunny_subagent",
      arguments: { taskId: "space-bunny-contract", role: "analyst", objective: "Reply OK" }
    });

    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.result, "OK");
    assert.equal(runtimeCalls.length, 1);
    assert.equal(runtimeCalls[0].mode, "read_only");
    assert.equal(runtimeCalls[0].taskId, "space-bunny-contract");
  } finally {
    await client.close();
    await server.close();
  }
});
