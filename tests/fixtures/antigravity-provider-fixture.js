import fs from "node:fs";
import path from "node:path";

const scenario = process.argv[2] || "success";
const invocation = process.argv.slice(3);
const addDirIndex = invocation.indexOf("--add-dir");
const workspace = addDirIndex >= 0 ? invocation[addDirIndex + 1] : null;

if (invocation.includes("mcp")) {
  process.stdout.write("No MCP servers configured.\n");
  process.exitCode = 0;
} else if (scenario === "success") {
  process.stdout.write(`${JSON.stringify({ response: "fixture-ok" })}\n`);
  process.exitCode = 0;
} else if (scenario === "empty") {
  process.exitCode = 0;
} else if (scenario === "process_exit") {
  process.stderr.write("unclassified provider failure\n");
  process.exitCode = 1;
} else if (scenario === "rate_limited") {
  process.stderr.write("RESOURCE_EXHAUSTED\n");
  process.exitCode = 1;
} else if (scenario === "server") {
  process.stderr.write("HTTP 503 service unavailable\n");
  process.exitCode = 1;
} else if (scenario === "auth") {
  process.stderr.write("UNAUTHENTICATED\n");
  process.exitCode = 1;
} else if (scenario === "network") {
  process.stderr.write("ECONNRESET\n");
  process.exitCode = 1;
} else if (scenario === "unicode") {
  process.stderr.write("é".repeat(600));
  process.exitCode = 1;
} else if (scenario === "probe-ready") {
  process.stdout.write(`${JSON.stringify({ response: "READY" })}\n`);
  process.exitCode = 0;
} else if (scenario === "probe-workspace") {
  const marker = fs.readFileSync(path.join(workspace || ".", "probe.txt"), "utf8");
  process.stdout.write(`${JSON.stringify({ response: marker })}\n`);
  process.exitCode = 0;
} else if (scenario === "probe-workspace-wrong") {
  process.stdout.write(`${JSON.stringify({ response: "NOT_THE_MARKER" })}\n`);
  process.exitCode = 0;
} else if (scenario === "probe-web") {
  process.stdout.write(`${JSON.stringify({ response: "Example Domain" })}\n`);
  process.exitCode = 0;
} else if (scenario === "probe-web-denied") {
  process.stderr.write("tool required the 'read_url' permission, auto-denied\n");
  process.exitCode = 1;
} else if (scenario === "probe-auth") {
  process.stderr.write("UNAUTHENTICATED\n");
  process.exitCode = 1;
} else if (scenario === "hang") {
  setInterval(() => {}, 1000);
} else {
  process.exitCode = 0;
}
