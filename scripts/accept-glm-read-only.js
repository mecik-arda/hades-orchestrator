import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = fs.mkdtempSync(path.join(path.join(projectRoot, "pilot-workspace"), ".glm-read-only-acceptance-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "subagent-bridge", "src", "server.js")],
  env: { ...process.env, SUBAGENT_BRIDGE_TRUSTED_WORKSPACE: workspace }
});
const client = new Client({ name: "glm-read-only-acceptance", version: "2.1.0" });

try {
  await client.connect(transport);
  const response = await client.callTool({
    name: "run_glm_subagent",
    arguments: {
      taskId: "glm-production-read-only-acceptance",
      role: "analyst",
      model: "glm_5_2",
      mode: "read_only",
      objective: "Inspect the workspace without modifying it. State whether it is empty and return one concise sentence.",
      files: [],
      contextFiles: [],
      acceptanceCriteria: ["Do not modify files.", "Return a concise inspection result."]
    }
  });
  const result = response.structuredContent;
  const accepted = result?.agent === "glm" && result?.result?.status === "completed" && result.accessMode === "read_only" && result.resolvedModel === "zai-coding-plan/glm-5.2";
  const error = response.isError ? response.content?.map((entry) => entry.text).filter(Boolean).join("\n") || "GLM read-only acceptance failed" : null;
  console.log(JSON.stringify({ ...(result || {}), accepted, error }, null, 2));
  if (!accepted) process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  fs.rmSync(workspace, { recursive: true, force: true });
}
