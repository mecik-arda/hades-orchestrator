import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const acceptanceRoot = path.join(projectRoot, "pilot-workspace");
const workspace = fs.mkdtempSync(path.join(acceptanceRoot, ".deepseek-edit-acceptance-"));
const sourcePath = path.join(workspace, "value.js");
fs.writeFileSync(sourcePath, "export function sum(left, right) {\n  return left + right;\n}\n", { encoding: "utf8", flag: "wx" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "subagent-bridge", "src", "server.js")],
  env: {
    ...process.env,
    SUBAGENT_BRIDGE_TRUSTED_WORKSPACE: workspace
  }
});
const client = new Client({ name: "deepseek-edit-acceptance", version: "1.0.0" });

try {
  await client.connect(transport);
  const response = await client.callTool({
    name: "run_deepseek_subagent",
    arguments: {
      taskId: "deepseek-production-edit-acceptance",
      role: "implementer",
      model: "deepseek_pro",
      mode: "edit",
      objective: "Add an exported subtract(left, right) function without changing the existing sum function.",
      workspace,
      files: ["value.js"],
      contextFiles: [],
      skills: [],
      acceptanceCriteria: [
        "Keep the existing sum function unchanged.",
        "Add an exported subtract function that returns left minus right.",
        "Do not use shell commands, delegation, network, or external directories."
      ]
    }
  });
  const result = response.structuredContent;
  const source = fs.readFileSync(sourcePath, "utf8");
  const accepted = result?.status === "completed" && result.applied === true && result.cleanupCompleted === true && /export function subtract\(left, right\)/.test(source) && /return left - right;/.test(source);
  const error = response.isError ? response.content?.map((entry) => entry.text).filter(Boolean).join("\n") || "MCP edit acceptance failed" : null;
  console.log(JSON.stringify({ ...(result || {}), accepted, error }, null, 2));
  if (!accepted) process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  fs.rmSync(workspace, { recursive: true, force: true });
}
