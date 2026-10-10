function parseJson(value) {
  if (typeof value !== "string") return value;
  if (value.length > 65536) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function batchSummary(output) {
  const queue = [output?.output ?? output, output?.metadata, output];
  const visited = new Set();
  for (let count = 0; queue.length > 0 && count < 12; count += 1) {
    let value = parseJson(queue.shift());
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (value.summary?.progress && value.summary?.batchId) return value.summary;
    if (value.progress && value.batchId) return value;
    for (const nested of [value.structuredContent, value.result, value.output]) {
      if (nested !== undefined) queue.push(nested);
    }
    if (Array.isArray(value.content)) {
      for (const item of value.content) {
        if (item?.type === "text") queue.push(item.text);
      }
    }
  }
  return null;
}

function progressToast(summary) {
  const progress = summary.progress;
  const counts = [
    `${progress.percentage}%`,
    `${progress.resolvedCount}/${progress.totalCount} çözümlendi`,
    `${progress.runningCount} çalışıyor`,
    `${progress.queuedCount} kuyrukta`
  ];
  if (progress.blockedCount > 0) counts.push(`${progress.blockedCount} bloklu`);
  if (summary.failedCount > 0) counts.push(`${summary.failedCount} hata`);
  if (summary.unknownCount > 0) counts.push(`${summary.unknownCount} unknown`);
  return `${summary.status.toLocaleUpperCase("en-US")} · ${summary.batchId.slice(0, 8)} · ${counts.join(" · ")}`;
}

export const ParallelBatchProgress = async ({ client }) => {
  const lastProgressByBatch = new Map();
  async function diagnostic(level, message, extra = {}) {
    try {
      await client.app.log({
        body: {
          service: "parallel-batch-progress",
          level,
          message,
          extra
        }
      });
    } catch {
    }
  }

  await diagnostic("info", "plugin_loaded", { version: 1 });

  async function notifyProgress(sessionID, toolName, output, source) {
    const progressTools = ["_start_parallel_batch", "_get_parallel_batch", "_cancel_parallel_batch", "_approve_parallel_integration"];
    if (!progressTools.some((suffix) => toolName.endsWith(suffix))) return;
    const summary = batchSummary({ output });
    if (!summary?.batchId || !summary.progress) {
      const rawResult = output?.output ?? output;
      await diagnostic("warn", "batch_progress_parse_failed", {
        source,
        resultType: Array.isArray(rawResult) ? "array" : typeof rawResult,
        hasStructuredContent: Boolean(rawResult?.structuredContent),
        hasContentArray: Array.isArray(rawResult?.content)
      });
      try {
        const displayed = await client.tui.showToast({
          body: {
            title: "Orkestrasyon V2",
            message: "Batch sonucu geldi; ilerleme özeti okunamadı",
            variant: "warning",
            duration: 8000
          }
        });
        await diagnostic(displayed === true ? "info" : "warn", displayed === true ? "batch_progress_fallback_toast_displayed" : "batch_progress_fallback_toast_not_displayed", { source });
      } catch {
        await diagnostic("warn", "batch_progress_fallback_toast_failed", { source });
      }
      return;
    }
    const signature = [
      summary.status,
      summary.progress.percentage,
      summary.progress.resolvedCount,
      summary.progress.runningCount,
      summary.progress.queuedCount,
      (summary.tasks || []).map((task) => `${task.taskId}:${task.status}`).join(","),
      summary.failedCount,
      summary.unknownCount
    ].join(":");
    const key = `${sessionID}:${summary.batchId}`;
    if (lastProgressByBatch.get(key) === signature) return;
    lastProgressByBatch.set(key, signature);
    if (lastProgressByBatch.size > 100) lastProgressByBatch.delete(lastProgressByBatch.keys().next().value);
    const variant = ["failed", "unknown", "blocked"].includes(summary.status)
      ? "warning"
      : ["result_ready", "integrated", "cancelled"].includes(summary.status)
        ? "success"
        : "info";
    try {
      const displayed = await client.tui.showToast({
        body: {
          title: `Orkestrasyon V2 · ${summary.batchId.slice(0, 8)}`,
          message: progressToast(summary),
          variant,
          duration: 8000
        }
      });
      await diagnostic(displayed === true ? "info" : "warn", displayed === true ? "batch_progress_toast_displayed" : "batch_progress_toast_not_displayed", {
        source,
        status: summary.status,
        percentage: summary.progress.percentage
      });
    } catch (error) {
      await diagnostic("warn", "batch_progress_toast_failed", { source, errorClass: error instanceof Error ? error.name : typeof error });
    }
  }
  return {
    "tool.execute.before": async (input) => {
      const progressTools = ["_start_parallel_batch", "_get_parallel_batch", "_cancel_parallel_batch", "_approve_parallel_integration"];
      const matchedTool = progressTools.some((suffix) => input.tool.endsWith(suffix));
      if (matchedTool) await diagnostic("debug", "batch_tool_hook_entered", { tool: input.tool.split("_").slice(-3).join("_") });
    },
    event: async ({ event }) => {
      if (event.type !== "message.part.updated") return;
      const part = event.properties?.part;
      if (part?.type !== "tool" || part.state?.status !== "completed") return;
      await notifyProgress(part.sessionID, part.tool, part.state.output, "event");
    },
    "tool.execute.after": async (input, output) => {
      await notifyProgress(input.sessionID, input.tool, output, "tool.execute.after");
    }
  };
};
