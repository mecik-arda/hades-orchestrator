import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "subagent-bridge", "src", "server.js")],
  env: {
    ...process.env,
    SUBAGENT_BRIDGE_TRUSTED_WORKSPACE: projectRoot
  }
});
const client = new Client({ name: "hades-orchestrator-smoke-test", version: "2.1.0" });

await client.connect(transport);
const tools = await client.listTools();
const health = await client.callTool({ name: "check_deepseek_subagent", arguments: {} });
const glmHealth = await client.callTool({ name: "check_glm_subagent", arguments: {} });
const kimiHealth = await client.callTool({ name: "check_kimi_subagent", arguments: {} });
const qwenHealth = await client.callTool({ name: "check_qwen_subagent", arguments: {} });
const antigravityHealth = await client.callTool({ name: "check_antigravity_subagent", arguments: {} });
const bridgeHealth = await client.callTool({ name: "check_subagent_bridge", arguments: {} });
const workspaceLockHealth = await client.callTool({ name: "check_workspace_lock", arguments: {} });
const memoryHealth = await client.callTool({ name: "check_persistent_memory", arguments: {} });
const memoryReview = await client.callTool({ name: "review_persistent_memory", arguments: {} });
const memorySearch = await client.callTool({
  name: "search_persistent_memory",
  arguments: { query: "Orkestrasyon Hafıza İndeksi", limit: 5 }
});
const selectedMemoryPath = memorySearch.structuredContent?.matches?.[0]?.relativePath;
const memoryRead = selectedMemoryPath
  ? await client.callTool({ name: "read_persistent_memory", arguments: { relativePath: selectedMemoryPath } })
  : null;
await client.close();

console.log(JSON.stringify({
  tools: tools.tools.map((tool) => tool.name),
  health: health.structuredContent,
  glmHealth: glmHealth.structuredContent,
  kimiHealth: kimiHealth.structuredContent,
  qwenHealth: qwenHealth.structuredContent,
  antigravityHealth: antigravityHealth.structuredContent,
  bridgeHealth: bridgeHealth.structuredContent,
  workspaceLockHealth: workspaceLockHealth.structuredContent,
  memoryHealth: memoryHealth.structuredContent,
  memoryReview: memoryReview.structuredContent?.counts,
  memoryProbe: {
    matchedNotes: memorySearch.structuredContent?.matches?.length || 0,
    selectedMemoryPath,
    bytes: memoryRead?.structuredContent?.bytes || 0,
    sha256: memoryRead?.structuredContent?.sha256 || null
  }
}, null, 2));

const toolNames = new Set(tools.tools.map((tool) => tool.name));
const expectedToolNames = [
  "check_deepseek_subagent",
  "check_glm_subagent",
  "check_subagent_bridge",
  "check_workspace_lock",
  "run_deepseek_subagent",
  "run_deepseek_edit_pilot",
  "run_glm_subagent",
  "run_glm_edit_pilot",
  "check_kimi_subagent",
  "run_kimi_subagent",
  "check_qwen_subagent",
  "run_qwen_subagent",
  "check_persistent_memory",
  "search_persistent_memory",
  "read_persistent_memory",
  "review_persistent_memory",
  "analyze_memory_write",
  "store_persistent_memory",
  "promote_memory"
];
const expectedToolsAvailable = expectedToolNames.every((toolName) => toolNames.has(toolName));
const memoryProbeValid = Boolean(selectedMemoryPath && memoryRead?.structuredContent?.sha256 && memoryReview.structuredContent?.counts);
const bridgeAdapters = Object.values(bridgeHealth.structuredContent?.adapters || {});
const bridgeHealthValid = Boolean(bridgeHealth.structuredContent?.services?.coreSchemas && bridgeAdapters.length > 0 && bridgeHealth.structuredContent?.circuits && bridgeHealth.structuredContent?.costBudget && bridgeAdapters.every((adapter) => adapter.modePolicy?.defaultMode && Array.isArray(adapter.modePolicy?.allowedModes) && Array.isArray(adapter.configuredModels)));
const antigravityHealthValid = Boolean(antigravityHealth.structuredContent?.modePolicy?.defaultMode && Array.isArray(antigravityHealth.structuredContent?.configuredModels));
const workspaceLockHealthValid = Number.isInteger(workspaceLockHealth.structuredContent?.localActive) && Array.isArray(workspaceLockHealth.structuredContent?.externalDiskLocks);
if (!expectedToolsAvailable || !health.structuredContent?.available || !glmHealth.structuredContent?.available || !antigravityHealthValid || !bridgeHealthValid || !workspaceLockHealthValid || !memoryHealth.structuredContent?.readable || !memoryHealth.structuredContent?.writable || !memoryProbeValid) {
  process.exitCode = 1;
}
