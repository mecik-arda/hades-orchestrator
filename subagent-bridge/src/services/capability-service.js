import { validateCapability } from "../schemas/core-schemas.js";

export function checkCapability(adapter, requestedMode) {
  const capabilityValidation = validateCapability(adapter.capabilities);
  if (!capabilityValidation.success) {
    return {
      allowed: false,
      error: `invalid capability definition: ${capabilityValidation.error.issues.map((i) => i.message).join(", ")}`
    };
  }

  const capabilities = capabilityValidation.data;

  if (requestedMode === "edit" && !capabilities.canWrite) {
    return {
      allowed: false,
      error: "unsupported capability: adapter does not support write operations"
    };
  }

  if (requestedMode === "read_only" && !capabilities.canRead) {
    return {
      allowed: false,
      error: "unsupported capability: adapter does not support read operations"
    };
  }

  return { allowed: true };
}
