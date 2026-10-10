import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpToolHandlers, publicToolSchemas } from "../subagent-bridge/src/frontends/mcp/tools.js";
import { createSubagentMcpServer } from "../subagent-bridge/src/frontends/mcp/server.js";

function readOnlyTask(taskId = "task-one") {
  return {
    taskId,
    role: "analyst",
    mode: "read_only",
    target: "codex",
    objective: "Inspect",
    readablePaths: ["src/a.txt"]
  };
}

function createStubRuntime(overrides = {}) {
  const calls = [];
  return {
    calls,
    async prepareParallelBatch(input) {
      calls.push({ method: "prepare", input });
      return {
        ok: true,
        planId: "a".repeat(32),
        planHash: "b".repeat(64),
        summary: { planId: "a".repeat(32), planHash: "b".repeat(64), status: "planned", contentBytes: 10 },
        allocation: { estimatedUsd: 0.2, capUsd: 1 }
      };
    },
    async startParallelBatch(input) {
      calls.push({ method: "start", input });
      return { ok: true, batchId: "c".repeat(32), summary: { batchId: "c".repeat(32), planId: "a".repeat(32), planHash: "b".repeat(64), status: "queued", contentBytes: 10 } };
    },
    async getParallelBatch(input) {
      calls.push({ method: "get", input });
      return { ok: true, summary: { batchId: input.batchId, status: "running", contentBytes: 10 } };
    },
    async getParallelTaskDetail(input) {
      calls.push({ method: "detail", input });
      return { ok: true, page: { batchId: input.batchId, taskId: input.taskId, detailRef: input.detailRef, content: "page", cursor: 0, nextCursor: null, totalBytes: 4 } };
    },
    async cancelParallelBatch(input) {
      calls.push({ method: "cancel", input });
      return { ok: true, summary: { batchId: input.batchId, status: "cancelled" }, cancellation: { requested: true, cancelledExecutionCount: 1 } };
    },
    async approveParallelIntegration(input) {
      calls.push({ method: "approve", input });
      return { ok: false, reason: "integration_not_ready", message: "not ready" };
    },
    ...overrides
  };
}

test("V2-MCP: public parallel batch schemas reject bridge-owned metadata", () => {
  const prepare = { objective: "x", batchMaxReservedCostUsd: 1, tasks: [readOnlyTask()] };
  assert.equal(publicToolSchemas.prepareParallelBatch.safeParse(prepare).success, true);
  for (const field of ["workspace", "trustedWorkspace", "caller", "executionId", "delegationDepth", "statePaths", "planId"]) {
    assert.equal(publicToolSchemas.prepareParallelBatch.safeParse({ ...prepare, [field]: "injected" }).success, false, field);
  }
  assert.equal(publicToolSchemas.startParallelBatch.safeParse({ planId: "a".repeat(32), planHash: "b".repeat(64), workspace: "C:\\x" }).success, false);
  assert.equal(publicToolSchemas.getParallelBatch.safeParse({ batchId: "a".repeat(32) }).success, true);
  assert.equal(publicToolSchemas.cancelParallelBatch.safeParse({ batchId: "a".repeat(32), force: true }).success, false);
});

test("V2-MCP: prepare handler forwards the parsed plan and returns a bounded payload", async () => {
  const runtime = createStubRuntime();
  const handlers = createMcpToolHandlers({ runtime, trustedWorkspace: "C:\\trusted", caller: "openCode" });
  const result = await handlers.prepareParallelBatch({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [readOnlyTask()] });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.planId, "a".repeat(32));
  assert.equal(result.structuredContent.allocation.estimatedUsd, 0.2);
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].input.tasks[0].taskId, "task-one");
  assert.equal(result.content[0].text.length < 60000, true);
});

test("V2-MCP: start, get, detail, cancel and approve handlers map results and errors", async () => {
  const runtime = createStubRuntime();
  const handlers = createMcpToolHandlers({ runtime, trustedWorkspace: "C:\\trusted", caller: "openCode" });
  const started = await handlers.startParallelBatch({ planId: "a".repeat(32), planHash: "b".repeat(64) });
  assert.equal(started.structuredContent.batchId, "c".repeat(32));
  const fetched = await handlers.getParallelBatch({ batchId: "c".repeat(32) });
  assert.equal(fetched.structuredContent.summary.status, "running");
  const detail = await handlers.getParallelTaskDetail({ batchId: "c".repeat(32), taskId: "task-one", detailRef: "d".repeat(64) });
  assert.equal(detail.structuredContent.page.content, "page");
  const cancelled = await handlers.cancelParallelBatch({ batchId: "c".repeat(32) });
  assert.equal(cancelled.structuredContent.cancellation.requested, true);
  const approved = await handlers.approveParallelIntegration({ batchId: "c".repeat(32), approvalRef: "e".repeat(64), expectedDiffHash: "f".repeat(64) });
  assert.equal(approved.isError, true);
  assert.equal(approved.structuredContent.reason, "integration_not_ready");
});

test("V2-MCP: handlers reject injected bridge fields before runtime access", async () => {
  const runtime = createStubRuntime();
  const handlers = createMcpToolHandlers({ runtime, trustedWorkspace: "C:\\trusted", caller: "openCode" });
  await assert.rejects(
    () => handlers.prepareParallelBatch({ objective: "x", batchMaxReservedCostUsd: 1, tasks: [readOnlyTask()], workspace: "C:\\other" }),
    /invalid public tool arguments/
  );
  assert.equal(runtime.calls.length, 0);
});

test("V2-MCP: server construction honors the parallel batch gate", () => {
  const configuration = { parallelBatch: { enabled: true } };
  assert.doesNotThrow(() => createSubagentMcpServer({
    runtime: createStubRuntime(),
    configuration,
    trustedWorkspace: "C:\\trusted",
    enableOrchestratorApproval: true
  }));
  assert.doesNotThrow(() => createSubagentMcpServer({
    runtime: createStubRuntime(),
    configuration: { parallelBatch: { enabled: false } },
    trustedWorkspace: "C:\\trusted",
    enableOrchestratorApproval: false
  }));
});

async function listRegisteredToolNames(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parallel-batch-registration-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.listTools();
    return result.tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

test("V2-MCP: parallel tools are registered only under the enabled and approval gates", async () => {
  const enabledTools = await listRegisteredToolNames(createSubagentMcpServer({
    runtime: createStubRuntime(),
    configuration: { parallelBatch: { enabled: true } },
    trustedWorkspace: "C:\\trusted",
    enableOrchestratorApproval: true
  }));
  for (const name of ["prepare_parallel_batch", "start_parallel_batch", "get_parallel_batch", "get_parallel_task_detail", "cancel_parallel_batch", "approve_parallel_integration"]) {
    assert.equal(enabledTools.includes(name), true, `${name} should be registered`);
  }
  const noApprovalTools = await listRegisteredToolNames(createSubagentMcpServer({
    runtime: createStubRuntime(),
    configuration: { parallelBatch: { enabled: true } },
    trustedWorkspace: "C:\\trusted",
    enableOrchestratorApproval: false
  }));
  assert.equal(noApprovalTools.includes("prepare_parallel_batch"), true);
  assert.equal(noApprovalTools.includes("approve_parallel_integration"), false);
  const disabledTools = await listRegisteredToolNames(createSubagentMcpServer({
    runtime: createStubRuntime(),
    configuration: { parallelBatch: { enabled: false } },
    trustedWorkspace: "C:\\trusted",
    enableOrchestratorApproval: true
  }));
  assert.equal(disabledTools.some((name) => name.includes("parallel_batch")), false);
});

test("V2-MCP: get batch keeps progress machine-readable without a custom visual panel", async () => {
  const runtime = createStubRuntime({
    async getParallelBatch(input) {
      return {
        ok: true,
        summary: {
          schemaVersion: 1,
          batchId: input.batchId,
          planId: "a".repeat(32),
          planHash: "b".repeat(64),
          status: "running",
          createdAt: new Date().toISOString(),
          expiresAt: null,
          taskCount: 2,
          completedCount: 1,
          failedCount: 0,
          unknownCount: 0,
          tasks: [
            { taskId: "task-one", status: "completed", summary: "first done", summaryStatus: "full", actionRequired: "none", filesChanged: [], verification: [], riskLevel: null, detailRef: "c".repeat(64), failureClass: null, durationMs: 1000, costUsd: null },
            { taskId: "task-two", status: "running", summary: null, summaryStatus: "not_available", actionRequired: "none", filesChanged: [], verification: [], riskLevel: null, detailRef: null, failureClass: null, durationMs: 0, costUsd: null }
          ],
          progress: { percentage: 50, resolvedCount: 1, totalCount: 2, runningCount: 1, queuedCount: 0, blockedCount: 0, cancelledCount: 0 },
          budget: { capUsd: 1, reservedUsd: 0.1, settledKnownUsd: 0.1, unknownReservedUsd: 0, refundedUsd: 0, remainingUsd: 0.9, isProviderInvoice: false },
          approvalRequired: false,
          approval: null,
          message: null,
          contentBytes: 1000
        }
      };
    }
  });
  const handlers = createMcpToolHandlers({ runtime, trustedWorkspace: "C:\\trusted", caller: "openCode" });
  const result = await handlers.getParallelBatch({ batchId: "d".repeat(32) });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.summary.progress.percentage, 50);
  assert.equal(result.structuredContent.summary.progress.runningCount, 1);
  assert.equal(JSON.parse(result.content[0].text).summary.progress.percentage, 50);
  assert.equal(result.content[0].text.includes("┏━ ORKESTRASYON V2"), false);
});
