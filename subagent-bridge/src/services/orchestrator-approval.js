export function isOrchestratorApprovalEnabled(environment = process.env) {
  return Boolean(environment) && environment.SUBAGENT_BRIDGE_ORCHESTRATOR_APPROVAL === "1";
}
