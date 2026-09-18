export const memoryConsumptionProfileNames = Object.freeze(["normal", "economic", "manual"]);

export const memoryProfileCeilings = Object.freeze({
  maxResults: 5,
  maxContextChars: 1200
});

export const builtinMemoryConsumptionProfiles = Object.freeze({
  normal: Object.freeze({ autoRetrieval: true, maxResults: 5, maxContextChars: 1200, healthCheckIntervalMinutes: 60 }),
  economic: Object.freeze({ autoRetrieval: true, maxResults: 2, maxContextChars: 600, healthCheckIntervalMinutes: 240 }),
  manual: Object.freeze({ autoRetrieval: false, maxResults: 5, maxContextChars: 1200, healthCheckIntervalMinutes: 1440 })
});

const immutableSecurityFields = ["allowedWriteFolders", "vaultRoot", "ignoredDirectories", "maxWriteBytes"];

export function resolveMemoryConsumptionProfile({ configuration, userPreference, clientDefault } = {}) {
  const configuredProfiles = configuration?.memory?.consumptionProfiles || {};
  const policyName = configuration?.memory?.activeProfile;
  const environmentName = process.env.SUBAGENT_MEMORY_PROFILE;
  const requestedName = policyName || userPreference || environmentName || clientDefault || "normal";
  if (!memoryConsumptionProfileNames.includes(requestedName)) {
    throw new Error(`Unknown memory consumption profile: ${requestedName}`);
  }
  const overrides = configuredProfiles[requestedName] || {};
  for (const field of immutableSecurityFields) {
    if (field in overrides) {
      throw new Error(`Memory consumption profile cannot override security field: ${field}`);
    }
  }
  const base = builtinMemoryConsumptionProfiles[requestedName];
  const merged = { ...base, ...overrides };
  if (requestedName === "manual") merged.autoRetrieval = false;
  return Object.freeze({
    name: requestedName,
    source: policyName ? "policy" : userPreference ? "user" : environmentName ? "environment" : clientDefault ? "client" : "default",
    autoRetrieval: merged.autoRetrieval,
    maxResults: Math.min(merged.maxResults, memoryProfileCeilings.maxResults),
    maxContextChars: Math.min(merged.maxContextChars, memoryProfileCeilings.maxContextChars),
    healthCheckIntervalMinutes: merged.healthCheckIntervalMinutes
  });
}
