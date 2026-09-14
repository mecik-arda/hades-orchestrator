import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSubagentMcpServer, isOrchestratorApprovalEnabled } from "../subagent-bridge/src/frontends/mcp/server.js";
import { createProviderEnvironment } from "../subagent-bridge/src/services/execution-service.js";
import { provisionDisposableWorkspace } from "../subagent-bridge/src/services/disposable-workspace.js";

async function listToolNames(enableOrchestratorApproval) {
  const runtime = { approvePreparedEdit: async () => ({ status: "failed", failureClass: "approval_invalid" }) };
  const server = createSubagentMcpServer({
    runtime,
    configuration: {},
    trustedWorkspace: os.tmpdir(),
    enableOrchestratorApproval
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "wp5b-approval-channel-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const tools = await client.listTools();
  await client.close();
  return tools.tools.map((tool) => tool.name);
}

test("WP5B-CHANNEL-01: orkestratör onay bayrağı yalnız tam değerle etkinleşir", () => {
  assert.equal(isOrchestratorApprovalEnabled({ SUBAGENT_BRIDGE_ORCHESTRATOR_APPROVAL: "1" }), true);
  assert.equal(isOrchestratorApprovalEnabled({ SUBAGENT_BRIDGE_ORCHESTRATOR_APPROVAL: "01" }), false);
  assert.equal(isOrchestratorApprovalEnabled({ SUBAGENT_BRIDGE_ORCHESTRATOR_APPROVAL: "true" }), false);
  assert.equal(isOrchestratorApprovalEnabled({ SUBAGENT_BRIDGE_ORCHESTRATOR_APPROVAL: "" }), false);
  assert.equal(isOrchestratorApprovalEnabled({}), false);
  assert.equal(isOrchestratorApprovalEnabled(), typeof process.env.SUBAGENT_BRIDGE_ORCHESTRATOR_APPROVAL === "string");
});

test("WP5B-CHANNEL-02: approve_prepared_edit aracı yalnız bayrak açıkken kaydedilir", async () => {
  const disabledTools = await listToolNames(false);
  assert.equal(disabledTools.includes("approve_prepared_edit"), false);
  const enabledTools = await listToolNames(true);
  assert.equal(enabledTools.includes("approve_prepared_edit"), true);
  assert.equal(enabledTools.includes("run_deepseek_subagent"), true);
});

test("WP5B-CHANNEL-03: sağlayıcı ortamı approval bayrağını ve config override değişkenlerini taşımaz", () => {
  const environment = createProviderEnvironment("opencode", {
    PATH: "C:\\bin",
    DEEPSEEK_API_KEY: "test-key",
    SUBAGENT_BRIDGE_ORCHESTRATOR_APPROVAL: "1",
    SUBAGENT_BRIDGE_TRUSTED_WORKSPACE: "C:\\workspace",
    OPENCODE_CONFIG: "C:\\opencode.json",
    OPENCODE_CONFIG_CONTENT: "{}",
    ORCHESTRATOR_CONFIG: "C:\\config.json"
  });
  assert.equal(environment.PATH, "C:\\bin");
  assert.equal(environment.DEEPSEEK_API_KEY, "test-key");
  assert.equal(environment.SUBAGENT_BRIDGE_ORCHESTRATOR_APPROVAL, undefined);
  assert.equal(environment.SUBAGENT_BRIDGE_TRUSTED_WORKSPACE, undefined);
  assert.equal(environment.OPENCODE_CONFIG, undefined);
  assert.equal(environment.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(environment.ORCHESTRATOR_CONFIG, undefined);
});

test("WP5B-CHANNEL-04: disposable OpenCode yapılandırması bridge MCP girdisini kapatır", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp5b-disposable-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "value.txt"), "before\n", "utf8");
  const disposable = provisionDisposableWorkspace({ statePaths: { cache: path.join(root, "cache") } }, root, ["value.txt"], ["value.txt"]);
  const localConfiguration = JSON.parse(fs.readFileSync(path.join(disposable.workspace, "opencode.json"), "utf8"));
  assert.deepEqual(localConfiguration.mcp["subagent-bridge"], { enabled: false });
  const permissions = localConfiguration.agent["deepseek-edit"].permission;
  assert.equal(permissions.bash, "deny");
  assert.equal(permissions.task, "deny");
  assert.equal(permissions.question, "deny");
  assert.equal(permissions.external_directory, "deny");
  disposable.cleanup();
});
