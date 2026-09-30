import { createProviderEnvironment, runProcess } from "./services/execution-service.js";

export const SPACE_BUNNY_MODEL_ID = "opencode/space-bunny-free";
export const SPACE_BUNNY_MODEL_MAP = Object.freeze({ space_bunny_free: SPACE_BUNNY_MODEL_ID });

const ansiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function extractJsonObjects(value) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (depth === 0) {
      if (character === "{") {
        depth = 1;
        start = index;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          objects.push(JSON.parse(value.slice(start, index + 1)));
        } catch {
          return [];
        }
      }
    }
  }

  return depth === 0 ? objects : [];
}

export function parseSpaceBunnyCatalogOutput(stdout) {
  const objects = extractJsonObjects(String(stdout || "").replace(ansiPattern, ""));
  const metadata = objects.find((entry) => entry?.id === "space-bunny-free" && entry?.providerID === "opencode");
  if (!metadata) return { available: false, reason: "exact model metadata missing" };
  const cost = metadata.cost;
  const cache = cost?.cache;
  const validPrices = [cost?.input, cost?.output, cache?.read, cache?.write].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const zeroPrice = validPrices && [cost.input, cost.output, cache.read, cache.write].every((value) => value === 0);
  const available = metadata.status === "active" && zeroPrice && metadata.capabilities?.toolcall === true;
  return {
    available,
    reason: available ? null : metadata.status !== "active" ? "model is not active" : !validPrices ? "model price metadata is incomplete" : !zeroPrice ? "model price is nonzero" : "model tool-call capability is unavailable",
    resolvedModel: SPACE_BUNNY_MODEL_ID,
    status: metadata.status,
    cost: validPrices ? { input: cost.input, output: cost.output, cacheRead: cache.read, cacheWrite: cache.write } : null,
    toolCall: metadata.capabilities?.toolcall === true,
    refreshed: true
  };
}

export async function checkSpaceBunnyCatalog(configuration) {
  const executable = configuration.opencode?.executable || "opencode";
  const execArgs = configuration.opencode?.execArgs || [];
  try {
    const result = await runProcess(executable, [...execArgs, "models", "--pure", "opencode", "--verbose", "--refresh"], {
      timeoutMs: 60000,
      maxOutputBytes: 4194304,
      env: createProviderEnvironment("opencode")
    });
    if (result.code !== 0) return { available: false, authValid: null, installed: true, refreshed: false, resolvedModel: SPACE_BUNNY_MODEL_ID, reason: "OpenCode model catalog refresh failed" };
    const catalog = parseSpaceBunnyCatalogOutput(result.stdout);
    return { ...catalog, authValid: null, installed: true };
  } catch {
    return { available: false, authValid: null, installed: false, refreshed: false, resolvedModel: SPACE_BUNNY_MODEL_ID, reason: "OpenCode model catalog refresh failed" };
  }
}
