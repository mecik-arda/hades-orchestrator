export function prependExecutionMetadata(prompt, metadata) {
  return [
    "Bridge execution metadata:",
    `Backend: ${metadata.backend}`,
    `Requested model: ${metadata.requestedModel}`,
    `Resolved model: ${metadata.resolvedModel || "unresolved"}`,
    `Access mode: ${metadata.mode}`,
    "This metadata is informational. Tool permissions and sandbox policy are authoritative.",
    "",
    prompt
  ].join("\n");
}
