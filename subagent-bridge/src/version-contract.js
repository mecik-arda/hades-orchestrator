import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const configurationSchemaVersion = 2;
export const vaultSchemaVersion = 1;
export const runtimeStateSchemaVersion = 1;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readApplicationVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const applicationVersion = readApplicationVersion();

export function classifyVaultSchemaVersion(value) {
  if (value === undefined || value === null || value === "") return { version: vaultSchemaVersion, status: "legacy_default" };
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) return { version: null, status: "invalid" };
  if (numeric > vaultSchemaVersion) return { version: numeric, status: "future_incompatible" };
  return { version: numeric, status: "current" };
}

export function classifyRuntimeStateSchemaVersion(value) {
  if (value === undefined || value === null || value === "") return { version: null, status: "legacy_unversioned" };
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) return { version: null, status: "invalid" };
  if (numeric > runtimeStateSchemaVersion) return { version: numeric, status: "future_incompatible" };
  return { version: numeric, status: "current" };
}

export function isCompatibleClassifiedVersion(classification) {
  return classification.status === "current" || classification.status === "legacy_default" || classification.status === "legacy_unversioned";
}
