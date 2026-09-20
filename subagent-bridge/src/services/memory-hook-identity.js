export const memoryHookSessionIdMaxChars = 512;

export function normalizeMemoryHookSessionId(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= memoryHookSessionIdMaxChars ? normalized : "";
}
