import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const acceptanceRoot = path.join(projectRoot, "pilot-workspace");
const workspace = fs.mkdtempSync(path.join(acceptanceRoot, ".glm-edit-acceptance-"));
const sourcePath = path.join(workspace, "value.js");
fs.writeFileSync(sourcePath, "export function sum(left, right) {\n  return left + right;\n}\n", { encoding: "utf8", flag: "wx" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "subagent-bridge", "src", "server.js")],
  env: { ...process.env, SUBAGENT_BRIDGE_TRUSTED_WORKSPACE: workspace }
});
const client = new Client({ name: "glm-edit-acceptance", version: "2.1.0" });

try {
  await client.connect(transport);
  const response = await client.callTool({
    name: "run_glm_subagent",
    arguments: {
      taskId: "glm-production-edit-acceptance",
      role: "implementer",
      model: "glm_5_2",
      mode: "edit",
      objective: "Add an exported subtract(left, right) function without changing the existing sum function.",
      files: ["value.js"],
      contextFiles: [],
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
  const error = response.isError ? response.content?.map((entry) => entry.text).filter(Boolean).join("\n") || "GLM edit acceptance failed" : null;
  console.log(JSON.stringify({ ...(result || {}), accepted, error }, null, 2));
  if (!accepted) process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  fs.rmSync(workspace, { recursive: true, force: true });
}
