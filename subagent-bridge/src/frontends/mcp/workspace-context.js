import { canonicalizeTrustedWorkspace } from "../../runtime/bridge-runtime.js";
import { validateWorkspace } from "../../config.js";

function collectDeniedRoots(configuration) {
  const roots = new Set();
  for (const value of Object.values(configuration)) {
    if (Array.isArray(value?.deniedRootPaths)) {
      for (const root of value.deniedRootPaths) roots.add(root);
    }
    if (Array.isArray(value?.deniedRoots)) {
      for (const root of value.deniedRoots) roots.add(root);
    }
  }
  if (configuration.memory?.vaultRootPath) roots.add(configuration.memory.vaultRootPath);
  return [...roots];
}

export function resolveTrustedWorkspace(configuration, environment = process.env) {
  const trustedWorkspace = environment.SUBAGENT_BRIDGE_TRUSTED_WORKSPACE;
  if (!trustedWorkspace) {
    throw new Error("SUBAGENT_BRIDGE_TRUSTED_WORKSPACE is required");
  }
  if (!Array.isArray(configuration.allowedRoots) || configuration.allowedRoots.length === 0) {
    throw new Error("trusted workspace policy requires at least one allowed root");
  }
  return canonicalizeTrustedWorkspace(validateWorkspace(trustedWorkspace, configuration.allowedRoots, collectDeniedRoots(configuration)));
}
