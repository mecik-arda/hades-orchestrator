import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const memoryHookNamedCohorts = Object.freeze(["project_alpha", "project_beta"]);
export const memoryHookProjectCohorts = Object.freeze([...memoryHookNamedCohorts, "unassigned"]);
export const memoryHookReportCohorts = Object.freeze([...memoryHookNamedCohorts, "unassigned", "legacy_unattributed", "attribution_conflict"]);
export const memoryHookCohortRegistrySchemaVersion = 1;
export const memoryHookCohortRegistryMaxBytes = 262144;
export const memoryHookCohortRegistryMaxProjects = 100;
export const memoryHookCohortRegistryMaxRootsPerProject = 32;

const projectHookTargets = Object.freeze({
  opencode: path.join(".opencode", "plugins", "second-brain-memory.js"),
  codex: path.join(".codex", "hooks.json"),
  claude: path.join(".claude", "settings.local.json")
});

function canonicalPathKey(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function canonicalDirectory(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  try {
    const resolved = fs.realpathSync.native(path.resolve(value));
    if (!fs.statSync(resolved).isDirectory()) return null;
    return resolved;
  } catch {
    return null;
  }
}

function sanitizeRegistryPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || !path.isAbsolute(value)) return null;
  return path.resolve(value);
}

export function memoryHookCohortRegistryPath(options = {}) {
  const override = options.registryPath ?? process.env.SUBAGENT_MEMORY_HOOK_COHORT_REGISTRY;
  if (override !== undefined && override !== null) return sanitizeRegistryPath(override);
  return path.join(options.homeDirectory || os.homedir(), ".config", "subagent-bridge", "memory-hook-cohorts.json");
}

export function parseMemoryHookCohortRegistry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !["schemaVersion", "projects"].includes(key))) return null;
  if (value.schemaVersion !== memoryHookCohortRegistrySchemaVersion || !Array.isArray(value.projects) || value.projects.length > memoryHookCohortRegistryMaxProjects) return null;
  const rootsByPath = new Map();
  const projects = [];
  for (const project of value.projects) {
    if (!project || typeof project !== "object" || Array.isArray(project)) return null;
    if (Object.keys(project).some((key) => !["cohort", "roots"].includes(key))) return null;
    if (!memoryHookNamedCohorts.includes(project.cohort) || !Array.isArray(project.roots) || project.roots.length === 0 || project.roots.length > memoryHookCohortRegistryMaxRootsPerProject) return null;
    const roots = [];
    for (const root of project.roots) {
      const canonicalRoot = canonicalDirectory(root);
      if (!canonicalRoot) return null;
      const key = canonicalPathKey(canonicalRoot);
      if (rootsByPath.has(key)) return null;
      rootsByPath.set(key, project.cohort);
      roots.push(canonicalRoot);
    }
    projects.push({ cohort: project.cohort, roots });
  }
  return { schemaVersion: memoryHookCohortRegistrySchemaVersion, projects, rootsByPath };
}

export function readMemoryHookCohortRegistry(options = {}) {
  const registryPath = memoryHookCohortRegistryPath(options);
  if (!registryPath) return null;
  let descriptor;
  try {
    const pathStatus = fs.lstatSync(registryPath);
    if (!pathStatus.isFile() || pathStatus.isSymbolicLink() || pathStatus.nlink !== 1 || pathStatus.size > memoryHookCohortRegistryMaxBytes) return null;
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    descriptor = fs.openSync(registryPath, fs.constants.O_RDONLY | noFollow);
    const status = fs.fstatSync(descriptor);
    if (!status.isFile() || status.nlink !== 1 || status.size > memoryHookCohortRegistryMaxBytes) return null;
    if (pathStatus.dev !== status.dev || pathStatus.ino !== status.ino) return null;
    const raw = fs.readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(raw, "utf8") > memoryHookCohortRegistryMaxBytes) return null;
    return parseMemoryHookCohortRegistry(JSON.parse(raw));
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
      }
    }
  }
}

function matchingCohorts(registry, projectRoots) {
  const cohorts = new Set();
  const candidates = projectRoots.filter((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
  if (candidates.length === 0) return { cohorts, unmatched: true };
  for (const candidate of candidates) {
    if (typeof candidate !== "string") return { cohorts, unmatched: true };
    const root = canonicalDirectory(candidate);
    if (!root) return { cohorts, unmatched: true };
    const cohort = registry.rootsByPath.get(canonicalPathKey(root));
    if (!cohort) return { cohorts, unmatched: true };
    cohorts.add(cohort);
  }
  return { cohorts, unmatched: false };
}

export function resolveMemoryHookProjectCohort({ projectRoots = [], requestedCohort, registryPath } = {}) {
  if (requestedCohort === "unassigned") return { projectCohort: "unassigned", status: "unassigned" };
  if (requestedCohort !== undefined && requestedCohort !== null && !memoryHookNamedCohorts.includes(requestedCohort)) {
    return { projectCohort: "unassigned", status: "invalid_request" };
  }
  const registry = readMemoryHookCohortRegistry({ registryPath });
  if (!registry) {
    const configuredPath = registryPath ?? process.env.SUBAGENT_MEMORY_HOOK_COHORT_REGISTRY;
    const sourcePath = memoryHookCohortRegistryPath({ registryPath });
    const invalidConfiguration = configuredPath !== undefined && configuredPath !== null;
    const invalidFile = Boolean(sourcePath && fs.existsSync(sourcePath));
    return { projectCohort: "unassigned", status: invalidConfiguration && !sourcePath || invalidFile ? "invalid_registry" : "registry_unavailable" };
  }
  const matching = matchingCohorts(registry, Array.isArray(projectRoots) ? projectRoots : []);
  if (matching.unmatched) return { projectCohort: "unassigned", status: "root_unmatched" };
  const cohorts = matching.cohorts;
  if (cohorts.size > 1) return { projectCohort: "unassigned", status: "root_ambiguous" };
  if (cohorts.size === 0) return { projectCohort: "unassigned", status: "root_unmatched" };
  const [cohort] = cohorts;
  if (requestedCohort && requestedCohort !== cohort) return { projectCohort: "unassigned", status: "cohort_mismatch" };
  return { projectCohort: cohort, status: "matched" };
}

export function expectedMemoryHookProjectTarget(projectRoot, client) {
  const canonicalRoot = canonicalDirectory(projectRoot);
  const relativeTarget = projectHookTargets[client];
  return canonicalRoot && relativeTarget ? path.join(canonicalRoot, relativeTarget) : null;
}

export function validateMemoryHookProjectInstallation({ projectRoot, cohort, client, targetPath, registryPath } = {}) {
  if (!memoryHookNamedCohorts.includes(cohort)) return { valid: false, status: "invalid_cohort" };
  const expectedTargetPath = expectedMemoryHookProjectTarget(projectRoot, client);
  if (!expectedTargetPath || typeof targetPath !== "string" || !path.isAbsolute(targetPath)) {
    return { valid: false, status: "target_scope_invalid" };
  }
  if (canonicalPathKey(path.resolve(targetPath)) !== canonicalPathKey(expectedTargetPath)) {
    return { valid: false, status: "target_scope_invalid" };
  }
  const result = resolveMemoryHookProjectCohort({ projectRoots: [projectRoot], requestedCohort: cohort, registryPath });
  return { valid: result.projectCohort === cohort, status: result.status, expectedTargetPath };
}

export function resolveOpenCodeProjectCohort({ directory, worktree, requestedCohort, registryPath } = {}) {
  const candidates = [directory, worktree].filter((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
  if (candidates.some((candidate) => typeof candidate !== "string")) return { projectCohort: "unassigned", status: "root_unmatched" };
  const projectRoots = candidates;
  return resolveMemoryHookProjectCohort({ projectRoots, requestedCohort, registryPath });
}
