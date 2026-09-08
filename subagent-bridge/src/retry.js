export function classifyProcessFailure(processResult) {
  const output = `${processResult.stderr || ""}\n${processResult.stdout || ""}`.toLocaleLowerCase("en-US");
  if (processResult.error) {
    const message = String(processResult.error.message || processResult.error).toLocaleLowerCase("en-US");
    if (/timed out|timeout|zaman aşımı/.test(message)) {
      return "timeout";
    }
    if (/econn|enotfound|eai_again|socket|network|fetch failed|connection/.test(message)) {
      return "network";
    }
    return "process_error";
  }
  if (/\b429\b|rate limit|too many requests|quota exceeded/.test(output)) {
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
  return ["rate_limited", "server", "network", "timeout", "output_parse_invalid", "empty_output", "schema_invalid"].includes(errorClass);
}

export function calculateRetryDelayMs(attemptNumber, baseDelayMs, maxDelayMs, randomValue = Math.random(), failureClass = null) {
  const exponent = failureClass === "rate_limited" ? Math.max(1, attemptNumber) : Math.max(0, attemptNumber - 1);
  const multiplier = failureClass === "rate_limited" ? 4 : 2;
  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * (multiplier ** exponent));
  const jitter = failureClass === "rate_limited" ? 0.5 + Math.min(Math.max(randomValue, 0), 1) * 0.5 : Math.min(Math.max(randomValue, 0), 1);
  return Math.round(exponentialDelay * jitter);
}
