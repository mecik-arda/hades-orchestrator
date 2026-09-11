import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getPersonalBridgeLayout } from "./personal-layout.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(moduleDirectory, "..", "..");
const currentConfigurationVersion = 2;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function hashCheckpointId(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizeForComparison(value) {
  return path.resolve(value).replace(/[\\/]+$/, "").toLocaleLowerCase("en-US");
}

function resolveForComparison(value) {
  const resolvedPath = path.resolve(value);
  return fs.existsSync(resolvedPath) ? fs.realpathSync(resolvedPath) : resolvedPath;
}

function resolvePackagePath(value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(packageRoot, value);
}

export function createDefaultStatePaths(root) {
  if (!root) {
    const layout = getPersonalBridgeLayout();
    return {
      logs: layout.logs,
      state: layout.state,
      cache: layout.cache
    };
  }
  return {
    logs: path.join(root, "logs"),
    state: path.join(root, "state"),
    cache: path.join(root, "cache")
  };
}

function migrateConfiguration(rawConfiguration) {
  const sourceVersion = rawConfiguration.configVersion ?? 1;
  if (!Number.isInteger(sourceVersion) || sourceVersion < 1 || sourceVersion > currentConfigurationVersion) {
    throw new Error(`Unsupported configuration version: ${sourceVersion}`);
  }
  let configuration = rawConfiguration;
  if (sourceVersion === 1) {
    configuration = {
      ...configuration,
      configVersion: 2,
      observability: {
        ...configuration.observability,
        maxMetricRetentionDays: configuration.observability?.maxMetricRetentionDays ?? 30
      },
      orchestration: {
        ...configuration.orchestration,
        scheduler: {
          ...configuration.orchestration?.scheduler,
          leaseHeartbeatMs: configuration.orchestration?.scheduler?.leaseHeartbeatMs ?? 300000
        }
      }
    };
  }
  return { configuration, sourceVersion, migrated: sourceVersion !== currentConfigurationVersion };
}

const configurationSchema = z.object({
  configVersion: z.literal(currentConfigurationVersion),
  allowedRoots: z.array(z.string().min(1)).min(1),
  agentRules: z.string().min(1),
  skills: z.object({ root: z.string().min(1), allowed: z.array(z.string().min(1)).min(1) }).strict(),
  deepseek: z.object({
    openCodeModel: z.string().min(1),
    openCodeFlashModel: z.string().min(1),
    subagentRules: z.string().min(1),
    workspaceTools: z.array(z.string().min(1)),
    researchTools: z.array(z.string().min(1)),
    timeoutMs: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
    requireGitRepository: z.boolean(),
    deniedRoots: z.array(z.string().min(1))
  }).strict(),
  glm: z.object({
    openCodeModel: z.string().min(1),
    openCodeHighSpeedModel: z.string().min(1),
    openCode53Model: z.string().min(1).optional(),
    openCode53FlashModel: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive(),
    deniedRoots: z.array(z.string().min(1))
  }).strict().optional(),
  kimi: z.object({
    models: z.record(z.string().min(1), z.string().min(1)),
    timeoutMs: z.number().int().positive(),
    deniedRoots: z.array(z.string().min(1))
  }).strict().optional(),
  qwen: z.object({
    models: z.record(z.string().min(1), z.string().min(1)),
    timeoutMs: z.number().int().positive(),
    deniedRoots: z.array(z.string().min(1))
  }).strict().optional(),
  workspacePolicy: z.object({
    antigravityDeniedRoots: z.array(z.string().min(1))
  }).strict().optional(),
  memory: z.object({
    enabled: z.boolean(),
    vaultRoot: z.string().min(1),
    allowedWriteFolders: z.array(z.string().min(1)),
    ignoredDirectories: z.array(z.string().min(1)),
    maxIndexedFiles: z.number().int().positive(),
    maxSearchResults: z.number().int().positive(),
    maxSearchFileBytes: z.number().int().positive(),
    maxExcerptCharacters: z.number().int().positive(),
    maxReadBytes: z.number().int().positive(),
    maxWriteBytes: z.number().int().positive(),
    auditMaxBytes: z.number().int().positive().optional(),
    reviewDefaults: z.object({
      sourceStalenessDays: z.number().int().positive(),
      maxDuplicateGroups: z.number().int().positive(),
      maxReadBytesPerFile: z.number().int().positive().optional()
    }).strict().optional()
  }).strict(),
  reliability: z.object({
    maxAttempts: z.number().int().positive(),
    maxSchemaRepairAttempts: z.number().int().min(0),
    baseRetryDelayMs: z.number().int().nonnegative(),
    maxRetryDelayMs: z.number().int().positive(),
    maxTotalDurationMs: z.number().int().positive(),
    maxRetryCostUsd: z.number().nonnegative(),
    maxRetryCostReserveUsd: z.number().nonnegative(),
    maxUnknownAttemptCostUsd: z.number().nonnegative(),
    dailyCostLimitUsd: z.number().positive().optional(),
    monthlyCostLimitUsd: z.number().positive().optional(),
    warningThresholdPercent: z.number().positive().max(100).optional()
  }).strict(),
  observability: z.object({
    maxMetricFileBytes: z.number().int().positive(),
    maxMetricRetentionDays: z.number().int().positive()
  }).strict(),
  orchestration: z.object({
    taskProfiles: z.record(z.string().min(1), z.object({
      target: z.string().min(1),
      model: z.string().min(1).optional(),
      mode: z.enum(["read_only", "edit"]),
      priority: z.number().int(),
      cacheable: z.boolean(),
      fallbackTargets: z.array(z.object({
        target: z.string().min(1),
        model: z.string().min(1).optional()
      }).strict()).max(5).optional()
    }).strict()),
    circuitBreaker: z.object({
      failureThreshold: z.number().int().positive(),
      windowMs: z.number().int().positive(),
      openMs: z.number().int().positive()
    }).strict().optional(),
    scheduler: z.object({
      maxQueuedPerWorkspace: z.number().int().positive(),
      staleLockMs: z.number().int().positive(),
      leaseHeartbeatMs: z.number().int().positive()
    }).strict(),
    readOnlyCache: z.object({
      enabled: z.boolean(),
      ttlMs: z.number().int().positive(),
      maxEntryBytes: z.number().int().positive(),
      maxEntries: z.number().int().positive().optional()
    }).strict()
  }).strict()
}).strict();

export function validateConfiguration(rawConfiguration) {
  return configurationSchema.safeParse(rawConfiguration);
}

export function loadConfiguration(options = {}) {
  const configuredPath = process.env.ORCHESTRATOR_CONFIG;
  const configurationPath = options.configurationPath || configuredPath || getPersonalBridgeLayout().configPath;
  const migration = migrateConfiguration(readJson(configurationPath));
  const validation = validateConfiguration(migration.configuration);
  if (!validation.success) {
    const issues = validation.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const configuration = validation.data;
  const vaultRootPath = resolvePackagePath(configuration.memory.vaultRoot);
  const resolveDeniedRootPaths = (deniedRoots) => [...new Map(
    [...deniedRoots.map(resolvePackagePath), vaultRootPath]
      .map((rootPath) => [normalizeForComparison(resolveForComparison(rootPath)), rootPath])
  ).values()];
  const deepseekDeniedRootPaths = resolveDeniedRootPaths(configuration.deepseek.deniedRoots);
  const glmDeniedRootPaths = configuration.glm
    ? resolveDeniedRootPaths(configuration.glm.deniedRoots)
    : [];
  const antigravityDeniedRootPaths = resolveDeniedRootPaths(configuration.workspacePolicy?.antigravityDeniedRoots || []);
  return {
    ...configuration,
    packageRoot,
    configurationPath,
    configurationVersion: {
      source: migration.sourceVersion,
      active: currentConfigurationVersion,
      migrated: migration.migrated
    },
    statePaths: options.statePaths || createDefaultStatePaths(),
    deepseek: {
      ...configuration.deepseek,
      deniedRootPaths: deepseekDeniedRootPaths
    },
    glm: configuration.glm
      ? {
          ...configuration.glm,
          deniedRootPaths: glmDeniedRootPaths
        }
      : configuration.glm,
    workspacePolicy: {
      ...(configuration.workspacePolicy || {}),
      antigravityDeniedRootPaths
    },
    memory: {
      ...configuration.memory,
      vaultRootPath,
      auditMaxBytes: configuration.memory.auditMaxBytes ?? 5242880,
      reviewDefaults: {
        sourceStalenessDays: configuration.memory.reviewDefaults?.sourceStalenessDays ?? 365,
        maxDuplicateGroups: configuration.memory.reviewDefaults?.maxDuplicateGroups ?? 20,
        maxReadBytesPerFile: configuration.memory.reviewDefaults?.maxReadBytesPerFile ?? 32768
      }
    },
    reliability: configuration.reliability,
    observability: configuration.observability,
    orchestration: configuration.orchestration || {},
    agentRulesPath: path.resolve(packageRoot, configuration.agentRules),
    subagentRulesPath: path.resolve(packageRoot, configuration.deepseek.subagentRules),
    skills: {
      ...configuration.skills,
      rootPath: path.resolve(packageRoot, configuration.skills.root)
    }
  };
}

export function loadTextFile(filePath) {
  return fs.readFileSync(filePath, "utf8").trim();
}

export function loadSkills(configuration, requestedSkillNames = []) {
  const allowedSkillNames = new Set(configuration.skills.allowed);
  return requestedSkillNames.map((skillName) => {
    if (!allowedSkillNames.has(skillName)) {
      throw new Error(`İzin verilmeyen skill: ${skillName}`);
    }
    const skillPath = path.join(configuration.skills.rootPath, skillName, "SKILL.md");
    if (!fs.existsSync(skillPath)) {
      throw new Error(`Skill bulunamadı: ${skillName}`);
    }
    return {
      name: skillName,
      content: loadTextFile(skillPath)
    };
  });
}

export function validateWorkspace(workspace, allowedRoots, deniedRoots = []) {
  const requestedWorkspace = path.resolve(workspace);
  const resolvedWorkspace = resolveForComparison(requestedWorkspace);
  const normalizedWorkspace = normalizeForComparison(resolvedWorkspace);
  const denied = deniedRoots.some((root) => {
    const normalizedRoot = normalizeForComparison(resolveForComparison(root));
    return normalizedWorkspace === normalizedRoot || normalizedWorkspace.startsWith(`${normalizedRoot}${path.sep}`);
  });
  if (denied) {
    throw new Error(`Workspace korunan kökün içinde: ${resolvedWorkspace}`);
  }
  const allowed = allowedRoots.some((root) => {
    const normalizedRoot = normalizeForComparison(resolveForComparison(root));
    return normalizedWorkspace === normalizedRoot || normalizedWorkspace.startsWith(`${normalizedRoot}${path.sep}`);
  });
  if (!allowed) {
    throw new Error(`Workspace izinli köklerin dışında: ${resolvedWorkspace}`);
  }
  if (!fs.existsSync(resolvedWorkspace) || !fs.statSync(resolvedWorkspace).isDirectory()) {
    throw new Error(`Workspace bulunamadı: ${resolvedWorkspace}`);
  }
  return resolvedWorkspace;
}

export function requireGitRepository(workspace) {
  if (!fs.existsSync(path.join(workspace, ".git"))) {
    throw new Error(`Git repository gerekli: ${workspace}`);
  }
}

export function ensureRuntimeDirectories(configuration) {
  const directories = [
    path.join(configuration.statePaths.logs, "runs"),
    path.join(configuration.statePaths.logs, "metrics"),
    path.join(configuration.statePaths.logs, "audit"),
    path.join(configuration.statePaths.state, "checkpoints"),
    configuration.statePaths.cache
  ];
  for (const directory of directories) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const checkpointDirectory = path.join(configuration.statePaths.state, "checkpoints");
  for (const entry of fs.readdirSync(checkpointDirectory)) {
    if (!entry.endsWith(".json")) continue;
    const checkpointPath = path.join(checkpointDirectory, entry);
    try {
      const checkpoint = readJson(checkpointPath);
      if (checkpoint.runIdHash && !checkpoint.runId) continue;
      const runIdHash = checkpoint.runIdHash || hashCheckpointId(checkpoint.runId || entry);
      const redacted = {
        runIdHash,
        agent: checkpoint.agent,
        role: checkpoint.role,
        model: checkpoint.model,
        exitCode: checkpoint.exitCode,
        completedAt: checkpoint.completedAt,
        failureClass: checkpoint.failureClass,
        attempts: checkpoint.attempts,
        usage: checkpoint.usage,
        result: {
          status: checkpoint.result?.status || "failed",
          requires_human_approval: checkpoint.result?.requires_human_approval === true
        }
      };
      const redactedPath = path.join(checkpointDirectory, `${runIdHash}.json`);
      fs.writeFileSync(redactedPath, JSON.stringify(redacted, null, 2), "utf8");
      if (redactedPath !== checkpointPath) fs.rmSync(checkpointPath, { force: true });
    } catch {
    }
  }
}

const forbiddenExecutableNames = new Set(["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "sh", "bash"]);

const agentModeSchema = z.enum(["read_only", "edit"]);

const agentConfigSchema = z.object({
  enabled: z.boolean(),
  executable: z.string().min(1).refine((value) => !forbiddenExecutableNames.has(path.basename(value).toLocaleLowerCase("en-US")), "command interpreters are not allowed as executables"),
  execArgs: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  probeTimeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  defaultSandbox: z.boolean().optional(),
  mode: agentModeSchema.optional(),
  defaultMode: agentModeSchema.optional(),
  allowedModes: z.array(agentModeSchema).min(1).max(2).optional(),
  allowNonGitWorkspace: z.boolean().optional(),
  deepSeekReadOnlyAgent: z.string().min(1).max(64).optional(),
  deepSeekEditAgent: z.string().min(1).max(64).optional(),
  glmEditAgent: z.string().min(1).max(64).optional(),
  kimiEditAgent: z.string().min(1).max(64).optional(),
  qwenEditAgent: z.string().min(1).max(64).optional(),
  editAgent: z.string().min(1).max(64).optional(),
  allowedModels: z.array(z.string().min(1).max(160)).min(1).max(50).optional()
}).strict().superRefine((value, context) => {
  if (value.defaultMode && value.allowedModes && !value.allowedModes.includes(value.defaultMode)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["defaultMode"], message: "defaultMode must be included in allowedModes" });
  }
});

const agentsConfigRootSchema = z.object({
  agents: z.record(z.string().min(1).max(64), agentConfigSchema)
}).strict();

export function validateAgentsConfig(rawAgentsConfig) {
  return agentsConfigRootSchema.safeParse(rawAgentsConfig);
}

export function loadAgentsConfig(options = {}) {
  const agentsPath = options.agentsPath || process.env.SUBAGENT_BRIDGE_AGENTS_CONFIG || getPersonalBridgeLayout().agentsPath;
  const raw = readJson(agentsPath);
  const validation = validateAgentsConfig(raw);
  if (!validation.success) {
    const issues = validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid config/agents.json: ${issues}`);
  }
  return validation.data;
}

export function loadRuntimeConfiguration(options = {}) {
  const configuration = loadConfiguration(options);
  const agents = loadAgentsConfig(options);
  const reservedKeys = new Set(Object.keys(configuration));
  const agentKeys = Object.keys(agents.agents);
  const collisions = agentKeys.filter((key) => reservedKeys.has(key));
  if (collisions.length > 0) {
    throw new Error(`agents.json backend name collides with policy key: ${collisions.join(", ")}`);
  }
  return {
    ...configuration,
    ...agents.agents
  };
}
