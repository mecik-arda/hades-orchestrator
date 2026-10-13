const structuredRateLimitCodes = new Set(["rate_limited", "too_many_requests", "resource_exhausted"]);

function isStructuredRateLimitOutput(value) {
  for (const rawLine of String(value || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object" || Array.isArray(event) || event.type !== "error") continue;
    const error = event.error && typeof event.error === "object" ? event.error : event;
    const code = typeof error.code === "string" ? error.code.toLocaleLowerCase("en-US") : "";
    if (structuredRateLimitCodes.has(code)) return true;
  }
  return false;
}

export function classifyProcessFailure(processResult) {
  const output = `${processResult.stderr || ""}\n${processResult.stdout || ""}`.toLocaleLowerCase("en-US");
  if (processResult.error) {
    if (processResult.error.failureClass === "prompt_transport_limit" || ["E2BIG", "ENAMETOOLONG"].includes(processResult.error.code)) {
      return "prompt_transport_limit";
    }
    if (processResult.error.code === "ENOENT") return "executable_missing";
    if (["EACCES", "EPERM"].includes(processResult.error.code)) return "permission_denied";
    const message = String(processResult.error.message || processResult.error).toLocaleLowerCase("en-US");
    if (/timed out|timeout|zaman aşımı/.test(message)) {
      return "timeout";
    }
    if (/econn|enotfound|eai_again|socket|network|fetch failed|connection/.test(message)) {
      return "network";
    }
    return "process_error";
  }
  if (isStructuredRateLimitOutput(output)) {
    return "rate_limited";
  }
  if (/\b5\d\d\b|internal server error|service unavailable|bad gateway|gateway timeout/.test(output)) {
    return "server";
  }
  if (/econn|enotfound|eai_again|socket|network|fetch failed|connection reset/.test(output)) {
    return "network";
  }
  if (processResult.code !== 0) {
    return "process_exit";
  }
  return null;
}

export function isRetryableFailure(errorClass) {
  return ["rate_limited", "server", "network", "timeout", "provider_temporary_error"].includes(errorClass);
}

export function calculateRetryDelayMs(attemptNumber, baseDelayMs, maxDelayMs, randomValue = Math.random(), failureClass = null) {
  const exponent = failureClass === "rate_limited" ? Math.max(1, attemptNumber) : Math.max(0, attemptNumber - 1);
  const multiplier = failureClass === "rate_limited" ? 4 : 2;
  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * (multiplier ** exponent));
  const jitter = Math.min(Math.max(randomValue, 0), 1);
  return Math.round(exponentialDelay * jitter);
}
