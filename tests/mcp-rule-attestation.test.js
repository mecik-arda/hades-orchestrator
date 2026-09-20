import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  calculateRuleManifestSha256,
  createRuleAttestation,
  RULE_ATTESTATION_MIME_TYPE,
  RULE_ATTESTATION_NAME,
  RULE_ATTESTATION_URI,
  ruleAttestationSchema
} from "../subagent-bridge/src/frontends/mcp/rule-attestation.js";

function createWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-rule-attestation-"));
  fs.mkdirSync(path.join(workspace, "config"));
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "agent rule alpha\n", "utf8");
  fs.writeFileSync(path.join(workspace, "CLAUDE.md"), "claude rule beta\n", "utf8");
  fs.writeFileSync(path.join(workspace, "config", "agent-rules.md"), "shared rule gamma\n", "utf8");
  return workspace;
}

function createCoreFromAttestation(attestation) {
  return {
    contractVersion: attestation.contractVersion,
    hashAlgorithm: attestation.hashAlgorithm,
    byteContract: attestation.byteContract,
    entries: attestation.entries
  };
}

async function createClient(workspace) {
  const serverModule = pathToFileURL(path.resolve("subagent-bridge/src/frontends/mcp/server.js")).href;
  const childSource = [
    `import { createSubagentMcpServer } from ${JSON.stringify(serverModule)};`,
    'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
    "const runtime = { health: async () => ({ services: {}, circuits: {}, costBudget: {}, adapters: {} }), workspaceLockSnapshot: () => ({}) };",
    `const server = createSubagentMcpServer({ runtime, configuration: {}, trustedWorkspace: ${JSON.stringify(workspace)} });`,
    "await server.connect(new StdioServerTransport());"
  ].join("\n");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "--eval", childSource],
    env: { ...process.env }
  });
  const client = new Client({ name: "rule-attestation-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test("MCP-ATTEST-01: yalnız sabit resource listelenir ve redacted manifest okunur", { timeout: 60000 }, async (context) => {
  const workspace = createWorkspace();
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const client = await createClient(workspace);
  try {
    const resources = await client.listResources();
    assert.deepEqual(resources.resources.map((resource) => ({
      name: resource.name,
      uri: resource.uri,
      mimeType: resource.mimeType
    })), [{ name: RULE_ATTESTATION_NAME, uri: RULE_ATTESTATION_URI, mimeType: RULE_ATTESTATION_MIME_TYPE }]);
    const read = await client.readResource({ uri: RULE_ATTESTATION_URI });
    const content = read.contents[0];
    const attestation = ruleAttestationSchema.parse(JSON.parse(content.text));
    assert.equal(content.uri, RULE_ATTESTATION_URI);
    assert.equal(attestation.comparison, "match");
    assert.equal(attestation.evidence.startup_context.status, "unavailable");
    assert.equal(attestation.evidence.mcp_resource.manifestSha256, attestation.manifestSha256);
    assert.equal(attestation.manifestSha256, calculateRuleManifestSha256(createCoreFromAttestation(attestation)));
    assert.equal(JSON.stringify(attestation).includes(workspace), false);
    assert.equal(JSON.stringify(attestation).includes("agent rule alpha"), false);
  } finally {
    await client.close().catch(() => {});
  }
});

test("MCP-ATTEST-02: sabit URI dışındaki resource reddedilir", { timeout: 60000 }, async (context) => {
  const workspace = createWorkspace();
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const client = await createClient(workspace);
  try {
    await assert.rejects(() => client.readResource({ uri: "hades://rules/attestation/other" }));
  } finally {
    await client.close().catch(() => {});
  }
});

test("MCP-ATTEST-03: ham byte değişikliği manifest hashini değiştirir", () => {
  const workspace = createWorkspace();
  try {
    const before = createRuleAttestation(workspace);
    fs.appendFileSync(path.join(workspace, "AGENTS.md"), "x", "utf8");
    const after = createRuleAttestation(workspace);
    assert.notEqual(after.manifestSha256, before.manifestSha256);
    assert.notEqual(after.entries[0].sha256, before.entries[0].sha256);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("MCP-ATTEST-04: secret içerik kapalı hata ile reddedilir", () => {
  const workspace = createWorkspace();
  try {
    const sentinel = "abcdefghijklmnop";
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), `token = "${sentinel}"\n`, "utf8");
    assert.throws(() => createRuleAttestation(workspace), (error) => {
      assert.equal(error.code, "unsafe_rule_content");
      assert.equal(error.message.includes(sentinel), false);
      assert.equal(error.message.includes(workspace), false);
      return true;
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("MCP-ATTEST-05: invalid UTF-8 ve hard link fail-closed kalır", (context) => {
  const workspace = createWorkspace();
  try {
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), Buffer.from([0xc3, 0x28]));
    assert.throws(() => createRuleAttestation(workspace), (error) => error.code === "rule_attestation_invalid_encoding");
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), "agent rule alpha\n", "utf8");
    const outside = path.join(workspace, "outside.md");
    fs.writeFileSync(outside, "hard link source\n", "utf8");
    fs.unlinkSync(path.join(workspace, "AGENTS.md"));
    try {
      fs.linkSync(outside, path.join(workspace, "AGENTS.md"));
    } catch {
      context.skip("hard link test is unavailable on this filesystem");
      return;
    }
    assert.throws(() => createRuleAttestation(workspace), (error) => error.code === "rule_attestation_unsafe_file");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
