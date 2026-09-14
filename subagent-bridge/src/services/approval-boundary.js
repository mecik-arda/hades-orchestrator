import crypto from "node:crypto";

export const approvalClassValues = ["low_impact", "new_file", "multiple_files", "policy_config", "external_service", "irreversible"];

export const orchestratorApprovableApprovalClasses = ["new_file", "multiple_files"];

const policyConfigDirectoryPattern = /^(?:config|\.github|\.gitlab|\.circleci|\.buildkite|\.opencode|\.agents|agents|manifest|mcp|ci)(?:[\\/]|$)/i;
const policyConfigFilePattern = /^(?:policy|agent|agents|opencode|manifest|mcp)(?:[.-][a-z0-9_-]+)*\.(?:json|jsonc|ya?ml|toml)$/i;
const policyConfigDotFilePattern = /^\.?mcp(?:-config)?\.jsonc?$/i;
const agentInstructionFilePattern = /^agents\.md$/i;
const policyConfigFamilyPattern = /^(?:docker-compose|compose|requirements)(?:[.-][a-z0-9_-]+)*\.(?:ya?ml|txt)$/i;
const policyConfigExactFileNames = new Set([
  ".codecov.yml",
  ".drone.yml",
  ".gitlab-ci.yml",
  ".gitlab-ci.yaml",
  ".npmrc",
  ".nvmrc",
  ".travis.yml",
  "appveyor.yml",
  "azure-pipelines.yml",
  "azure-pipelines.yaml",
  "bitbucket-pipelines.yml",
  "build.gradle",
  "build.gradle.kts",
  "buildkite.yml",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "cargo.toml",
  "cloudbuild.yaml",
  "composer.json",
  "composer.lock",
  "dockerfile",
  "gemfile",
  "gemfile.lock",
  "go.mod",
  "go.sum",
  "jenkinsfile",
  "makefile",
  "manifest.webmanifest",
  "package-lock.json",
  "package.json",
  "pipfile",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pom.xml",
  "pyproject.toml",
  "settings.gradle",
  "settings.gradle.kts",
  "yarn.lock"
]);

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function isOrchestratorApprovableClass(approvalClass) {
  return orchestratorApprovableApprovalClasses.includes(approvalClass);
}

export function isPolicyConfigPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (policyConfigDirectoryPattern.test(normalized)) return true;
  const basename = normalized.split("/").pop() || normalized;
  const normalizedBasename = basename.toLocaleLowerCase("en-US");
  return policyConfigExactFileNames.has(normalizedBasename)
    || policyConfigFilePattern.test(basename)
    || policyConfigDotFilePattern.test(basename)
    || policyConfigFamilyPattern.test(basename)
    || agentInstructionFilePattern.test(basename);
}

export function calculateChangeSetHash(changes) {
  const normalized = [...changes].map((change) => ({
    relativePath: change.relativePath,
    changeType: change.changeType,
    diff: change.diff,
    contentSha256: change.contentSha256 ?? null
  })).sort((left, right) => `${left.relativePath}:${left.changeType}`.localeCompare(`${right.relativePath}:${right.changeType}`));
  return hash(JSON.stringify(normalized));
}

export function classifyChangeSet(changes, signals = {}) {
  if (signals.irreversible === true) return "irreversible";
  if (signals.externalService === true) return "external_service";
  if (changes.some((change) => change.changeType === "deleted")) return "irreversible";
  if (changes.some((change) => isPolicyConfigPath(change.relativePath))) return "policy_config";
  if (changes.length > 1) return "multiple_files";
  if (changes.some((change) => change.changeType === "created")) return "new_file";
  return "low_impact";
}
