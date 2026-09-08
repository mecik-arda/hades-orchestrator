export function resolveAllowedModes(agentConfiguration, capabilities) {
  if (Array.isArray(agentConfiguration?.allowedModes) && agentConfiguration.allowedModes.length > 0) {
    return [...new Set(agentConfiguration.allowedModes)];
  }
  if (agentConfiguration?.mode === "read_only") return ["read_only"];
  if (agentConfiguration?.mode === "edit") return ["read_only", "edit"];
  return capabilities?.canWrite === true ? ["read_only", "edit"] : ["read_only"];
}

export function checkModePolicy(agentConfiguration, capabilities, requestedMode) {
  const allowedModes = resolveAllowedModes(agentConfiguration, capabilities);
  return allowedModes.includes(requestedMode)
    ? { allowed: true, allowedModes }
    : { allowed: false, allowedModes, error: `mode not allowed by provider policy: ${requestedMode}` };
}
