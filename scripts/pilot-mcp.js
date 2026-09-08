import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = process.env.ORCHESTRATOR_PROJECT_ROOT || process.cwd();
const workspace = path.join(projectRoot, "pilot-workspace");
const modelIndex = process.argv.indexOf("--model");
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : "deepseek_pro";
if (!["deepseek_pro", "deepseek_flash"].includes(model)) {
  throw new Error("--model deepseek_pro veya deepseek_flash olmalı");
}
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "subagent-bridge", "src", "server.js")],
  env: {
    ...process.env,
    SUBAGENT_BRIDGE_TRUSTED_WORKSPACE: workspace
  }
});
const client = new Client({ name: "hades-orchestrator-pilot", version: "2.0.0" });

await client.connect(transport);
const result = await client.callTool({
  name: "run_deepseek_subagent",
  arguments: {
    taskId: "pilot-synthetic-structured-output",
    role: "researcher",
    model,
    objective: "Return only valid JSON. Use double-quoted keys. Set status to completed, summarize that the synthetic MCP connection test completed, use empty findings, proposed_steps, risks, and questions arrays, and set requires_human_approval to false.",
    workspace,
    files: [],
    contextFiles: [],
    skills: [],
    acceptanceCriteria: [
      "Yerel dosya içeriği okunmamalı",
      "Web aracı kullanılmamalı",
      "Sonuç yapılandırılmış olmalı"
    ]
  }
});
await client.close();

const pilotResult = result.structuredContent;
console.log(JSON.stringify(pilotResult || result.content, null, 2));

if (!pilotResult || pilotResult.exitCode !== 0 || pilotResult.result?.status !== "completed") {
  process.exitCode = 1;
}
