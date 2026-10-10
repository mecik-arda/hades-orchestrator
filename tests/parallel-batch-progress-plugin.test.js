import test from "node:test";
import assert from "node:assert/strict";
import { ParallelBatchProgress } from "../templates/opencode/parallel-batch-progress.js";

function batchResult({ status, percentage, resolvedCount, runningCount, queuedCount, failedCount = 0, unknownCount = 0 }) {
  const summary = {
    batchId: "a".repeat(32),
    status,
    completedCount: resolvedCount,
    failedCount,
    unknownCount,
    progress: { percentage, resolvedCount, totalCount: 2, runningCount, queuedCount }
  };
  return {
    output: JSON.stringify({
      isError: false,
      structuredContent: { ok: true, batchId: summary.batchId, summary },
      content: [{ type: "text", text: JSON.stringify({ ok: true, batchId: summary.batchId, summary }) }]
    }),
    metadata: {}
  };
}

test("V2-PLUGIN: start and poll show toast only when batch state changes", async () => {
  const toasts = [];
  const logs = [];
  const plugin = await ParallelBatchProgress({ client: {
    tui: { async showToast(value) { toasts.push(value); return true; } },
    app: { async log({ body }) { logs.push(body); } }
  } });
  const onEvent = plugin.event;
  const afterTool = plugin["tool.execute.after"];
  const emitToolResult = (tool, result) => onEvent({
    event: {
      id: "event-one",
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "session-one",
          tool,
          state: { status: "completed", output: result.output }
        }
      }
    }
  });

  await emitToolResult("subagent-bridge_start_parallel_batch", batchResult({ status: "running", percentage: 0, resolvedCount: 0, runningCount: 2, queuedCount: 0 }));
  await emitToolResult("subagent-bridge_get_parallel_batch", batchResult({ status: "running", percentage: 0, resolvedCount: 0, runningCount: 2, queuedCount: 0 }));
  await afterTool({ tool: "subagent-bridge_get_parallel_batch", sessionID: "session-one" }, batchResult({ status: "running", percentage: 0, resolvedCount: 0, runningCount: 2, queuedCount: 0 }));
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].body.title, /^Orkestrasyon V2/);
  assert.equal(toasts[0].body.duration, 8000);
  assert.match(toasts[0].body.message, /0% · 0\/2 çözümlendi · 2 çalışıyor/);
  assert.equal(toasts[0].body.variant, "info");

  await emitToolResult("subagent-bridge_get_parallel_batch", batchResult({ status: "result_ready", percentage: 100, resolvedCount: 2, runningCount: 0, queuedCount: 0 }));
  assert.equal(toasts.length, 2);
  assert.match(toasts[1].body.message, /100% · 2\/2 çözümlendi/);
  assert.equal(toasts[1].body.variant, "success");

  const directResult = JSON.parse(batchResult({ status: "running", percentage: 50, resolvedCount: 1, runningCount: 1, queuedCount: 0 }).output);
  await afterTool({ tool: "subagent-bridge_get_parallel_batch", sessionID: "session-two" }, directResult);
  assert.equal(toasts.length, 3);
  assert.match(toasts[2].body.message, /50% · 1\/2 çözümlendi/);
  assert.equal(logs.some((entry) => entry.message === "plugin_loaded"), true);
  assert.equal(logs.filter((entry) => entry.message === "batch_progress_toast_displayed").length, 3);
  assert.equal(JSON.stringify(logs).includes("a".repeat(32)), false);
  assert.equal(JSON.stringify(logs).includes("task-one"), false);
});

test("V2-PLUGIN: ignores non-batch tools and safely ignores malformed output", async () => {
  const toasts = [];
  const logs = [];
  const plugin = await ParallelBatchProgress({ client: {
    tui: { async showToast(value) { toasts.push(value); } },
    app: { async log({ body }) { logs.push(body); } }
  } });
  await plugin.event({ event: { id: "event", type: "message.part.updated", properties: { part: { type: "tool", sessionID: "s", tool: "subagent-bridge_get_parallel_task_detail", state: { status: "completed", output: "{}" } } } } });
  await plugin.event({ event: { id: "event", type: "message.part.updated", properties: { part: { type: "tool", sessionID: "s", tool: "subagent-bridge_get_parallel_batch", state: { status: "completed", output: "not json" } } } } });
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].body.message, /özeti okunamadı/);
  assert.equal(toasts[0].body.variant, "warning");
  assert.equal(logs.some((entry) => entry.message === "batch_progress_parse_failed"), true);
  assert.equal(logs.find((entry) => entry.message === "batch_progress_parse_failed").level, "warn");
  assert.equal(JSON.stringify(logs).includes("not json"), false);
});

test("V2-PLUGIN: records a redacted before-hook observation for batch tools", async () => {
  const logs = [];
  const plugin = await ParallelBatchProgress({ client: {
    tui: { async showToast() {} },
    app: { async log({ body }) { logs.push(body); } }
  } });
  await plugin["tool.execute.before"]({ tool: "subagent-bridge_get_parallel_batch", sessionID: "s", callID: "call-private" });
  assert.equal(logs.some((entry) => entry.message === "batch_tool_hook_entered"), true);
  assert.equal(JSON.stringify(logs).includes("call-private"), false);
});

test("V2-PLUGIN: plugin tolerates a TUI toast failure", async () => {
  const logs = [];
  const plugin = await ParallelBatchProgress({ client: {
    tui: { async showToast() { throw new Error("TUI unavailable"); } },
    app: { async log({ body }) { logs.push(body); } }
  } });
  await assert.doesNotReject(() => plugin.event({
    event: {
      id: "event",
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "s",
          tool: "subagent-bridge_get_parallel_batch",
          state: { status: "completed", output: batchResult({ status: "running", percentage: 50, resolvedCount: 1, runningCount: 1, queuedCount: 0 }).output }
        }
      }
    }
  }));
  assert.equal(logs.some((entry) => entry.message === "batch_progress_toast_failed"), true);
  assert.equal(JSON.stringify(logs).includes("TUI unavailable"), false);
});

test("V2-PLUGIN: records when the TUI declines to display a toast", async () => {
  const logs = [];
  const plugin = await ParallelBatchProgress({ client: {
    tui: { async showToast() { return false; } },
    app: { async log({ body }) { logs.push(body); } }
  } });
  await plugin["tool.execute.after"](
    { tool: "subagent-bridge_get_parallel_batch", sessionID: "s" },
    batchResult({ status: "running", percentage: 50, resolvedCount: 1, runningCount: 1, queuedCount: 0 })
  );
  assert.equal(logs.some((entry) => entry.message === "batch_progress_toast_not_displayed"), true);
  assert.equal(logs.find((entry) => entry.message === "batch_progress_toast_not_displayed").level, "warn");
});
