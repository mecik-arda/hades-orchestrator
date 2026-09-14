import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const maximumFileBytes = 1048576;
const maximumTotalBytes = 5242880;
const maximumFiles = 200;
const excludedPilotFiles = new Set(["opencode.json", "opencode.jsonc"]);
const sensitiveFileNames = /^(?:\.env(?:\..*)?|id_[^.]+|.*\.(?:pem|key|p12|pfx))$/i;
const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|token|password|secret|client_secret|private_key)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}(?![A-Za-z0-9._-]*\s*\()/i,
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_=-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/
];
const sourceCodeSecretReferencePattern = /\b(?:api[_-]?key|token|password|secret|client_secret|private_key)\s*[:=]\s*(?:self|this)\.[A-Za-z_][A-Za-z0-9_]*/gi;

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256Hex(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function sourceStateChangedError() {
  const error = new Error("pilot source changed before promotion");
  error.sourceStateChanged = true;
  error.failureClass = "source_state_changed";
  return error;
}

function sourceSecretError() {
  const error = new Error("pilot source secret rejected");
  error.failureClass = "secret_detected";
  return error;
}

function redactSecretLikeValues(value, replacement) {
  let redacted = value;
  for (const pattern of secretPatterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    redacted = redacted.replace(new RegExp(pattern.source, flags), (match) => replacement(match));
  }
  return redacted;
}

function sourceSecretValues(value) {
  const values = [];
  redactSecretLikeValues(value, (match) => {
    values.push(match);
    return "";
  });
  return values;
}

function containsUnapprovedSecretLikeValue(value, permittedValues) {
  let scanned = value;
  for (const permittedValue of new Set(permittedValues)) scanned = scanned.replaceAll(permittedValue, "");
  return containsSecretLikeValue(scanned);
}

function promotionSecretError() {
  const error = new Error("pilot promotion secret rejected");
  error.failureClass = "secret_detected";
  return error;
}

export function detectRecoveryArtifacts(sourceRoot, relativePaths) {
  const artifacts = new Set();
  let scanFailed = false;
  for (const relativePath of relativePaths) {
    try {
      const normalizedPath = normalizeRelativePath(relativePath);
       const basename = path.basename(normalizedPath);
       const parentPath = path.dirname(path.join(sourceRoot, ...normalizedPath.split("/")));
       if (!fs.existsSync(parentPath) || !fs.lstatSync(parentPath).isDirectory()) continue;
       const escapedBasename = basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
       const artifactPattern = new RegExp(`^\\.${escapedBasename}\\.\\d+\\.\\d+\\.[a-f0-9]+\\.tmp(?:\\.backup)?$`);
       for (const entry of fs.readdirSync(parentPath)) {
         if (artifactPattern.test(entry)) artifacts.add(normalizedPath);
      }
    } catch {
      scanFailed = true;
    }
  }
  return { affectedPaths: [...artifacts].sort(), scanFailed };
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) throw new Error("pilot file path must be relative");
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw new Error("pilot file path traversal rejected");
  if (excludedPilotFiles.has(normalized.toLocaleLowerCase("en-US")) || sensitiveFileNames.test(path.basename(normalized))) throw new Error("pilot sensitive file rejected");
  return normalized;
}

function requireSafeSourceFile(sourceRoot, relativePath) {
  let current = sourceRoot;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const status = fs.lstatSync(current);
    if (status.isSymbolicLink()) throw new Error("pilot source link rejected");
  }
  const status = fs.lstatSync(current);
  if (!status.isFile() || status.nlink !== 1 || status.size > maximumFileBytes) throw new Error("pilot source file rejected");
  const realPath = fs.realpathSync(current);
  if (!isInside(realPath, sourceRoot)) throw new Error("pilot source file escapes workspace");
  const content = fs.readFileSync(realPath);
  if (content.includes(0)) throw new Error("pilot binary file rejected");
  if (!Buffer.from(content.toString("utf8"), "utf8").equals(content)) throw new Error("pilot source encoding rejected");
  return content;
}

function readOptionalSourceFile(sourceRoot, relativePath, allowMissing) {
  const absolutePath = path.join(sourceRoot, ...relativePath.split("/"));
  if (fs.existsSync(absolutePath)) return requireSafeSourceFile(sourceRoot, relativePath);
  if (!allowMissing) throw new Error("pilot source file not found");
  const parentPath = path.dirname(absolutePath);
  if (!fs.existsSync(parentPath)) throw new Error("pilot target parent not found");
  const parentStatus = fs.lstatSync(parentPath);
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) throw new Error("pilot target parent rejected");
  if (!isInside(fs.realpathSync(parentPath), sourceRoot)) throw new Error("pilot target parent escapes workspace");
  return null;
}

function readWorkspaceFiles(workspace) {
  const files = new Map();
  let totalBytes = 0;
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(workspace, absolutePath).replaceAll("\\", "/");
      if (excludedPilotFiles.has(relativePath.toLocaleLowerCase("en-US"))) continue;
      const status = fs.lstatSync(absolutePath);
      if (status.isSymbolicLink()) throw new Error("pilot output link rejected");
      if (status.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!status.isFile() || status.nlink !== 1 || status.size > maximumFileBytes) throw new Error("pilot output file rejected");
      const content = fs.readFileSync(absolutePath);
      if (content.includes(0)) throw new Error("pilot binary output rejected");
      if (!Buffer.from(content.toString("utf8"), "utf8").equals(content)) throw new Error("pilot output encoding rejected");
      totalBytes += content.length;
      if (totalBytes > maximumTotalBytes || files.size >= maximumFiles) throw new Error("pilot output limit exceeded");
      files.set(relativePath, content.toString("utf8"));
    }
  }
  visit(workspace);
  return files;
}

function createUnifiedDiff(relativePath, before, after) {
  const beforeLines = before === null ? [] : before.replace(/\r\n/g, "\n").split("\n");
  const afterLines = after === null ? [] : after.replace(/\r\n/g, "\n").split("\n");
  return [
    `--- ${before === null ? "/dev/null" : `a/${relativePath}`}`,
    `+++ ${after === null ? "/dev/null" : `b/${relativePath}`}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`)
  ].join("\n");
}

export function containsSecretLikeValue(value) {
  const scannedValue = value.replace(sourceCodeSecretReferencePattern, "");
  return secretPatterns.some((pattern) => pattern.test(scannedValue));
}

export function containsSecretLikeAddedValue(diff) {
  return containsSecretLikeValue(diff.split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n"));
}

export function applyPreparedChanges(sourceRoot, preparedChanges, expectedStates) {
  const normalizedRoot = fs.realpathSync(sourceRoot);
  if (!Array.isArray(preparedChanges) || preparedChanges.length === 0) throw new Error("pilot promotion requires changes");
  const statesByPath = new Map();
  for (const sourceState of expectedStates || []) {
    const relativePath = normalizeRelativePath(sourceState.relativePath);
    if (statesByPath.has(relativePath)) throw new Error("pilot promotion duplicate path");
    if (sourceState.state === "absent") statesByPath.set(relativePath, { state: "absent" });
    else if (sourceState.state === "present" && /^[a-f0-9]{64}$/.test(sourceState.sha256 || "")) statesByPath.set(relativePath, { state: "present", sha256: sourceState.sha256 });
    else throw new Error("pilot promotion source state rejected");
  }
  const items = preparedChanges.map((change) => {
    const relativePath = normalizeRelativePath(change.relativePath);
    const expected = statesByPath.get(relativePath);
    if (!expected) throw sourceStateChangedError();
    if (!Buffer.isBuffer(change.content)) throw new Error("pilot promotion content rejected");
    return { relativePath, content: change.content, expected };
  });
  if (new Set(items.map((item) => item.relativePath)).size !== items.length) throw new Error("pilot promotion duplicate path");
  const recoveryScan = detectRecoveryArtifacts(normalizedRoot, items.map((item) => item.relativePath));
  if (recoveryScan.affectedPaths.length > 0 || recoveryScan.scanFailed) {
    const error = new Error(recoveryScan.scanFailed ? "pilot promotion recovery scan could not complete" : "pilot promotion recovery artifacts detected; complete manual recovery before retrying");
    error.failureClass = "recovery_required";
    throw error;
  }
  const prepared = [];
  const removeArtifact = (target) => {
    try {
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
      return true;
    } catch {
      return false;
    }
  };
  try {
    for (const item of items) {
      const sourcePath = path.join(normalizedRoot, ...item.relativePath.split("/"));
      const currentContent = fs.existsSync(sourcePath) ? requireSafeSourceFile(normalizedRoot, item.relativePath) : null;
      const stateMatches = item.expected.state === "absent"
        ? currentContent === null
        : currentContent !== null && sha256Hex(currentContent) === item.expected.sha256;
      if (!stateMatches) throw sourceStateChangedError();
      const parentPath = path.dirname(sourcePath);
      if (!fs.existsSync(parentPath) || !fs.lstatSync(parentPath).isDirectory() || fs.lstatSync(parentPath).isSymbolicLink() || !isInside(fs.realpathSync(parentPath), normalizedRoot)) throw new Error("pilot promotion target rejected");
       const permittedValues = currentContent === null ? [] : sourceSecretValues(currentContent.toString("utf8"));
       if (containsUnapprovedSecretLikeValue(item.content.toString("utf8"), permittedValues)) throw promotionSecretError();
      const temporaryPath = path.join(parentPath, `.${path.basename(sourcePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
      const backupPath = `${temporaryPath}.backup`;
      fs.writeFileSync(temporaryPath, item.content, { flag: "wx" });
      prepared.push({ sourcePath, temporaryPath, backupPath, relativePath: item.relativePath, content: item.content, expected: item.expected, existed: currentContent !== null });
      if (currentContent !== null) fs.chmodSync(temporaryPath, fs.statSync(sourcePath).mode);
    }
  } catch (error) {
    let cleanupIncomplete = false;
    for (const item of prepared) {
      if (!removeArtifact(item.temporaryPath)) cleanupIncomplete = true;
    }
    if (cleanupIncomplete) error.cleanupIncomplete = true;
    throw error;
  }
  const applied = [];
  try {
    for (const item of prepared) {
      const currentContent = fs.existsSync(item.sourcePath) ? requireSafeSourceFile(normalizedRoot, item.relativePath) : null;
      const stateMatches = item.expected.state === "absent"
        ? currentContent === null
        : currentContent !== null && sha256Hex(currentContent) === item.expected.sha256;
      if (!stateMatches) throw sourceStateChangedError();
      if (item.existed) fs.renameSync(item.sourcePath, item.backupPath);
      try {
        fs.renameSync(item.temporaryPath, item.sourcePath);
        applied.push(item);
      } catch (error) {
        if (item.existed && fs.existsSync(item.backupPath)) fs.renameSync(item.backupPath, item.sourcePath);
        throw error;
      }
    }
    for (const item of applied) {
      const promotedContent = requireSafeSourceFile(normalizedRoot, item.relativePath);
      if (!promotedContent.equals(item.content)) throw new Error("pilot promotion verification failed");
    }
  } catch (error) {
    const rollbackItems = [...applied, ...prepared.filter((item) => !applied.includes(item) && item.existed && fs.existsSync(item.backupPath))].reverse();
    let rollbackFailed = false;
    for (const item of rollbackItems) {
      try {
        if (fs.existsSync(item.sourcePath)) fs.rmSync(item.sourcePath, { force: true });
        if (item.existed && fs.existsSync(item.backupPath)) fs.renameSync(item.backupPath, item.sourcePath);
      } catch {
        rollbackFailed = true;
      }
    }
    if (rollbackFailed) {
      const rollbackError = new Error("pilot promotion rollback incomplete; source workspace mutation state is unknown and recovery artifacts were retained");
      rollbackError.failureClass = "mutation_state_unknown";
      rollbackError.cleanupIncomplete = true;
      throw rollbackError;
    }
    let cleanupIncomplete = false;
    for (const item of prepared) {
      if (!removeArtifact(item.temporaryPath)) cleanupIncomplete = true;
    }
    if (cleanupIncomplete) error.cleanupIncomplete = true;
    throw error;
  }
  let cleanupFailed = false;
  for (const item of prepared) {
    if (!removeArtifact(item.temporaryPath)) cleanupFailed = true;
    if (!removeArtifact(item.backupPath)) cleanupFailed = true;
  }
  return { applied: true, cleanupFailed };
}

export function provisionDisposableWorkspace(configuration, sourceWorkspace, requestedFiles, editableFiles = requestedFiles, editAgentName = "deepseek-edit") {
  const sourceRoot = fs.realpathSync(sourceWorkspace);
  const relativePaths = [...new Set(requestedFiles.map(normalizeRelativePath))];
  const editablePaths = new Set(editableFiles.map(normalizeRelativePath));
  if ([...editablePaths].some((relativePath) => !relativePaths.includes(relativePath))) throw new Error("pilot editable file must be selected");
  if (relativePaths.length === 0 || relativePaths.length > maximumFiles) throw new Error("pilot requires selected files");
  const disposableRoot = path.join(configuration.statePaths.cache, "deepseek-edit-pilot");
  fs.mkdirSync(disposableRoot, { recursive: true });
  const rootStatus = fs.lstatSync(disposableRoot);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) throw new Error("unsafe disposable workspace root");
  const container = fs.mkdtempSync(path.join(disposableRoot, "run-"));
  const workspace = path.join(container, "workspace");
  fs.mkdirSync(workspace);
  const secretMarkers = new Map();
  const redactSourceSecrets = (relativePath, content) => {
    const markers = new Map();
    const redacted = redactSecretLikeValues(content.toString("utf8"), (match) => {
      const marker = `__BRIDGE_REDACTED_SOURCE_SECRET_${crypto.randomUUID()}__`;
      markers.set(marker, match);
      return marker;
    });
    secretMarkers.set(relativePath, markers);
    return Buffer.from(redacted, "utf8");
  };
  const restoreSourceSecrets = (relativePath, content) => {
    const markers = secretMarkers.get(relativePath);
    if (!markers) return content;
    let restored = content;
    for (const [marker, secret] of markers) {
      if (restored.split(marker).length - 1 > 1) throw sourceSecretError();
      restored = restored.replaceAll(marker, secret);
    }
    return restored;
  };
  try {
    let totalBytes = 0;
    const baselineStates = new Map();
    for (const relativePath of relativePaths) {
       const sourceContent = readOptionalSourceFile(sourceRoot, relativePath, editablePaths.has(relativePath));
       const targetPath = path.join(workspace, ...relativePath.split("/"));
       fs.mkdirSync(path.dirname(targetPath), { recursive: true });
       if (sourceContent === null) continue;
       const content = containsSecretLikeValue(sourceContent.toString("utf8")) ? redactSourceSecrets(relativePath, sourceContent) : sourceContent;
       totalBytes += content.length;
       if (totalBytes > maximumTotalBytes) throw new Error("pilot input limit exceeded");
       baselineStates.set(relativePath, sha256Hex(sourceContent));
      fs.writeFileSync(targetPath, content, { flag: "wx" });
    }
    fs.writeFileSync(path.join(workspace, "opencode.json"), `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        "subagent-bridge": { enabled: false }
      },
      agent: {
        [editAgentName]: {
          description: "Edits only files inside the disposable workspace without shell or delegation.",
          mode: "primary",
          permission: {
            read: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            edit: "allow",
            bash: "deny",
            task: "deny",
            question: "deny",
            external_directory: "deny"
          },
          prompt: "Edit only files inside the current disposable workspace. Never run shell commands, delegate, access external directories, or read secrets."
        }
      }
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    const baseline = readWorkspaceFiles(workspace);
    return {
      workspace,
      collectChanges() {
        if (fs.readdirSync(container).some((entry) => entry !== "workspace")) throw new Error("pilot workspace escape detected");
        const current = readWorkspaceFiles(workspace);
        const paths = [...new Set([...baseline.keys(), ...current.keys()])].sort();
        const changes = paths.flatMap((relativePath) => {
          const before = baseline.has(relativePath) ? baseline.get(relativePath) : null;
          const after = current.has(relativePath) ? current.get(relativePath) : null;
          if (before === after) return [];
           const restored = after === null ? null : restoreSourceSecrets(relativePath, after);
           return [{ relativePath, changeType: before === null ? "created" : after === null ? "deleted" : "modified", diff: createUnifiedDiff(relativePath, before, after), contentSha256: restored === null ? null : sha256Hex(Buffer.from(restored, "utf8")) }];
        });
        if (changes.some((change) => !editablePaths.has(change.relativePath))) throw new Error("pilot changed a non-editable file");
        const diff = changes.map((change) => change.diff).join("\n");
        if (Buffer.byteLength(diff, "utf8") > maximumTotalBytes) throw new Error("pilot diff limit exceeded");
        return { filesChanged: changes.map((change) => change.relativePath), changes, diff };
      },
      capturePreparedChanges() {
        const collected = this.collectChanges();
        if (collected.changes.some((change) => change.changeType === "deleted")) throw new Error("pilot file deletion is not allowed");
        const changes = collected.changes.map((change) => {
          const disposablePath = path.join(workspace, ...change.relativePath.split("/"));
           const content = Buffer.from(restoreSourceSecrets(change.relativePath, fs.readFileSync(disposablePath, "utf8")), "utf8");
          return { relativePath: change.relativePath, changeType: change.changeType, diff: change.diff, contentSha256: sha256Hex(content), content };
        });
        const expectedStates = changes.map((change) => {
          const baselineSha = baselineStates.get(change.relativePath);
          return baselineSha
            ? { relativePath: change.relativePath, state: "present", sha256: baselineSha }
            : { relativePath: change.relativePath, state: "absent" };
        });
        return { filesChanged: collected.filesChanged, diff: collected.diff, changes, expectedStates };
      },
      promoteChanges() {
        const prepared = this.capturePreparedChanges();
        const outcome = applyPreparedChanges(sourceRoot, prepared.changes, prepared.expectedStates);
        return { filesChanged: prepared.filesChanged, changes: prepared.changes.map(({ relativePath, changeType, diff }) => ({ relativePath, changeType, diff })), diff: prepared.diff, applied: true, cleanupFailed: outcome.cleanupFailed };
      },
      cleanup() {
        fs.rmSync(container, { recursive: true, force: true });
        return !fs.existsSync(container);
      }
    };
  } catch (error) {
    fs.rmSync(container, { recursive: true, force: true });
    throw error;
  }
}
