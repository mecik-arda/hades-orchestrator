import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function createConfiguration(vaultRootPath) {
  return {
    statePaths: {
      logs: path.join(vaultRootPath, ".runtime", "logs"),
      state: path.join(vaultRootPath, ".runtime", "state")
    },
    configurationVersion: { source: 2, active: 2, migrated: false },
    orchestration: { taskProfiles: {} },
    memory: {
      enabled: true,
      vaultRootPath,
      allowedWriteFolders: ["00_Inbox", "03_Resources"],
      ignoredDirectories: [],
      maxIndexedFiles: 100,
      maxSearchResults: 10,
      maxSearchFileBytes: 131072,
      maxExcerptCharacters: 300,
      maxReadBytes: 262144,
      maxWriteBytes: 65536,
      auditMaxBytes: 1048576,
      reviewDefaults: { sourceStalenessDays: 365, maxDuplicateGroups: 20, maxReadBytesPerFile: 32768 }
    }
  };
}

function writeNote(vaultRootPath, relativeDirectory, fileName, lines) {
  const directory = path.join(vaultRootPath, relativeDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, fileName);
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  return filePath;
}

test("M0-MCP: yayınlanmış not gerçek stdio MCP istemcisinde okunur, taslak gizli kalır", { timeout: 60000 }, async (context) => {
  const vaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-mcp-readback-"));
  context.after(() => fs.rmSync(vaultRootPath, { recursive: true, force: true }));
  const configuration = createConfiguration(vaultRootPath);
  writeNote(vaultRootPath, "03_Resources", "M0.md", [
    "---", "title: \"M0 Notu\"", "created: \"2026-08-11T00:00:00.000Z\"", "updated: \"2026-08-11T00:00:00.000Z\"", "confidence: \"high\"", "verification: \"verified\"", "stage: \"published\"", "---", "", "# M0 Notu", "", "mcpreadback benzersiz geri okuma gövdesi."
  ]);
  writeNote(vaultRootPath, "00_Inbox", "Taslak.md", [
    "---", "title: \"Taslak Notu\"", "created: \"2026-08-11T00:00:00.000Z\"", "updated: \"2026-08-11T00:00:00.000Z\"", "confidence: \"high\"", "verification: \"verified\"", "stage: \"draft\"", "---", "", "# Taslak Notu", "", "mcpreadback taslak gizli gövdesi."
  ]);
  const serverModule = pathToFileURL(path.resolve("subagent-bridge/src/frontends/mcp/server.js")).href;
  const childSource = [
    `import { createSubagentMcpServer } from ${JSON.stringify(serverModule)};`,
    'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
    `const configuration = ${JSON.stringify(configuration)};`,
    'const runtime = { health: async () => ({ services: {}, circuits: {}, costBudget: {}, adapters: {} }), workspaceLockSnapshot: () => ({}) };',
    `const server = createSubagentMcpServer({ runtime, configuration, trustedWorkspace: ${JSON.stringify(vaultRootPath)} });`,
    "await server.connect(new StdioServerTransport());"
  ].join("\n");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "--eval", childSource],
    env: { ...process.env }
  });
  const client = new Client({ name: "m0-readback", version: "1.0.0" });
  try {
    await client.connect(transport);
    const search = await client.callTool({ name: "search_persistent_memory", arguments: { query: "mcpreadback benzersiz", limit: 5 } });
    const searchResult = search.structuredContent;
    assert.equal(searchResult.matches.some((match) => match.relativePath === "03_Resources/M0.md"), true);
    assert.equal(searchResult.matches.some((match) => match.relativePath === "00_Inbox/Taslak.md"), false);
    const read = await client.callTool({ name: "read_persistent_memory", arguments: { relativePath: "03_Resources/M0.md" } });
    assert.match(read.structuredContent.content, /benzersiz geri okuma/);
    const expectedSha = crypto.createHash("sha256").update(fs.readFileSync(path.join(vaultRootPath, "03_Resources", "M0.md"))).digest("hex");
    assert.equal(read.structuredContent.sha256, expectedSha);
    const miss = await client.callTool({ name: "search_persistent_memory", arguments: { query: "zzzzqqqq yokboyle", limit: 5 } });
    assert.equal(miss.structuredContent.matches.length, 0);
  } finally {
    await client.close().catch(() => {});
  }
});
