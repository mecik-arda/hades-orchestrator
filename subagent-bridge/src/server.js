import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureRuntimeDirectories, loadRuntimeConfiguration } from "./config.js";
import { createSubagentMcpServer } from "./frontends/mcp/server.js";
import { resolveTrustedWorkspace } from "./frontends/mcp/workspace-context.js";
import { createBridgeRuntime } from "./runtime/bridge-runtime.js";

const configuration = loadRuntimeConfiguration();
ensureRuntimeDirectories(configuration);
const trustedWorkspace = resolveTrustedWorkspace(configuration);
const runtime = createBridgeRuntime({ configuration });
const server = createSubagentMcpServer({ runtime, configuration, trustedWorkspace });
const transport = new StdioServerTransport();
await server.connect(transport);
