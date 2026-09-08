import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "node:module";
import { z } from "zod";
import { ANTIGRAVITY_MODEL_MAP } from "../../adapters/antigravity-adapter.js";
import { analyzePersistentMemoryWrite, checkPersistentMemory, promotePersistentMemory, readPersistentMemory, reviewPersistentMemory, searchPersistentMemory, storePersistentMemory } from "../../memory.js";
import { createMcpToolHandlers, publicToolSchemas } from "./tools.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};
const require = createRequire(import.meta.url);
const { version: packageVersion } = require("../../../../package.json");

const executionAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
};

const externalReadOnlyExecutionAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
};

function errorResponse(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
  };
}

function safe(handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

function sanitizeHealth(health) {
  return {
    installed: health.installed,
    version: health.version,
    authValid: health.authValid,
    error: health.error
  };
}

function sanitizeRuntimeHealth(result) {
  return {
    services: result.services,
    circuits: result.circuits,
    costBudget: result.costBudget,
    adapters: Object.fromEntries(Object.entries(result.adapters).map(([id, entry]) => [id, {
      id: entry.id,
      capabilities: entry.capabilities,
      modePolicy: entry.modePolicy,
      configuredModels: entry.configuredModels,
      health: sanitizeHealth(entry.health)
    }]))
  };
}

export function createSubagentMcpServer({ runtime, configuration, trustedWorkspace }) {
  const server = new McpServer({
    name: "subagent-bridge",
    version: packageVersion
  }, {
    instructions: "Frontend-neutral subagent bridge runtime için MCP frontend'i. Trusted workspace sunucu başlangıç context'i tarafından sağlanır."
  });
  const handlers = createMcpToolHandlers({ runtime, trustedWorkspace, caller: "openCode", configuration });

  server.registerTool("check_persistent_memory", {
    title: "Kalıcı hafıza bağlantısını kontrol et",
    description: "Obsidian Vault erişimini, sınırları ve izinli yazma klasörlerini içerik veya secret göstermeden kontrol eder.",
    inputSchema: {},
    annotations: readOnlyAnnotations
  }, safe(async () => {
    const result = checkPersistentMemory(configuration);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }));

  server.registerTool("search_persistent_memory", {
    title: "Kalıcı hafızada ara",
    description: "Vault'un tamamını bağlama yüklemeden ilgili Markdown notlarını yerel olarak arar; secret içeriği engeller, injection şüphelilerini karantinaya alır ve güvenilmeyen sınırlı alıntılar döndürür.",
    inputSchema: {
      query: z.string().min(2).max(500),
      limit: z.number().int().min(1).max(20).default(5),
      includeExpired: z.boolean().default(false),
      includeDrafts: z.boolean().default(false)
    },
    annotations: readOnlyAnnotations
  }, safe(async (input) => {
    const result = searchPersistentMemory(configuration, input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }));

  server.registerTool("read_persistent_memory", {
    title: "Kalıcı hafıza notunu oku",
    description: "Arama sonucunda seçilen tek bir Markdown notunu boyut, yol, secret ve prompt injection sınırlarıyla güvenilmeyen içerik olarak okur.",
    inputSchema: {
      relativePath: z.string().min(3).max(500),
      acknowledgeQuarantinedContent: z.boolean().default(false)
    },
    annotations: readOnlyAnnotations
  }, safe(async (input) => {
    const result = readPersistentMemory(configuration, input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }));

  server.registerTool("review_persistent_memory", {
    title: "Kalıcı hafızayı denetle",
    description: "Vault'u değiştirmeden taslak, süresi dolmuş, inceleme tarihi geçmiş, kaynağı eskimiş, düşük güvenli, geçersiz metadata veya konsolidasyon adaylarını raporlar.",
    inputSchema: {},
    annotations: readOnlyAnnotations
  }, safe(async () => {
    const result = reviewPersistentMemory(configuration);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }));

  server.registerTool("analyze_memory_write", {
    title: "Kalıcı hafıza yazımını analiz et",
    description: "Vault'u değiştirmeden yeni not için aynı gövdeli tekrarları ve aynı başlıklı olası çelişkileri bulur.",
    inputSchema: {
      relativePath: z.string().min(3).max(500).optional(),
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(60000)
    },
    annotations: readOnlyAnnotations
  }, safe(async (input) => {
    const result = analyzePersistentMemoryWrite(configuration, input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }));

  server.registerTool("store_persistent_memory", {
    title: "Kalıcı hafıza notunu sakla",
    description: "Ana orkestratörün değerlendirdiği, kaynaklandırılmış, doğrulama metadata'sı bulunan ve secret içermeyen bir Markdown notunu izinli Vault klasörüne yazar.",
    inputSchema: {
      relativePath: z.string().min(3).max(500),
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(60000),
      tags: z.array(z.string().min(1).max(60)).max(20).default([]),
      sources: z.array(z.object({
        title: z.string().min(1).max(300),
        url: z.string().url().refine((value) => value.startsWith("https://"), "Kaynak URL HTTPS olmalı"),
        accessedAt: z.string().datetime()
      })).max(30).default([]),
      confidence: z.enum(["low", "medium", "high"]),
      verificationStatus: z.enum(["user-provided", "verified", "provisional"]),
      memoryType: z.enum(["semantic", "episodic", "procedural", "preference", "decision"]).optional(),
      stage: z.enum(["draft", "published"]).optional(),
      reviewAfter: z.string().datetime().optional(),
      validUntil: z.string().datetime().optional(),
      taskId: z.string().min(1).max(120),
      acknowledgeMemoryConflicts: z.boolean().default(false),
      acknowledgeExpiredMemory: z.boolean().default(false),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  }, safe(async (input) => {
    const result = storePersistentMemory(configuration, input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }));

  server.registerTool("promote_memory", {
    title: "Kalıcı hafıza taslağını yayınla",
    description: "00_Inbox altındaki SHA-256 kontrollü taslağı çift kilit ve redacted audit ile yayın klasörüne taşır.",
    inputSchema: {
      sourceRelativePath: z.string().min(3).max(500),
      targetRelativePath: z.string().min(3).max(500),
      expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/)
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  }, safe(async (input) => {
    const result = promotePersistentMemory(configuration, input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }));

  server.registerTool("check_deepseek_subagent", {
    title: "DeepSeek subagent bağlantısını kontrol et",
    description: "OpenCode yürütücüsünü ve DeepSeek Pro/Flash model eşlemesini secret değerlerini göstermeden kontrol eder.",
    inputSchema: {},
    annotations: readOnlyAnnotations
  }, safe(async () => {
    const health = await runtime.checkLegacyDeepSeek();
    const { executable, ...result } = health;
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }));

  server.registerTool("run_deepseek_subagent", {
    title: "DeepSeek V4 Pro veya Flash subagent çalıştır",
    description: "OpenCode üzerinden DeepSeek Pro veya Flash'ı read-only veya kontrollü edit modunda çalıştırır. Edit yalnız seçilmiş dosyaları disposable workspace sonrası trusted host workspace'e doğrulanmış promotion ile uygular.",
    inputSchema: publicToolSchemas.runDeepSeek.shape,
    annotations: executionAnnotations
  }, safe(handlers.runDeepSeek));

  server.registerTool("run_deepseek_edit_pilot", {
    title: "DeepSeek disposable edit pilotu çalıştır",
    description: "DeepSeek Pro veya Flash'a yalnız bridge-owned disposable workspace içinde kontrollü dosya düzenleme görevi verir; ana workspace'e değişiklik uygulamaz.",
    inputSchema: publicToolSchemas.runDeepSeekEditPilot.shape,
    annotations: executionAnnotations
  }, safe(handlers.runDeepSeekEditPilot));

  server.registerTool("check_glm_subagent", {
    title: "GLM subagent bağlantısını kontrol et",
    description: "OpenCode yürütücüsünü ve GLM 5.2/HighSpeed/5.3/5.3 Flash model eşlemesini secret değerlerini göstermeden kontrol eder.",
    inputSchema: {},
    annotations: readOnlyAnnotations
  }, safe(async () => {
    const health = await runtime.checkGlm();
    const { executable, ...result } = health;
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }));

  server.registerTool("run_glm_subagent", {
    title: "GLM subagent çalıştır",
    description: "OpenCode üzerinden GLM 5.2, GLM 5.2 HighSpeed, GLM 5.3 veya GLM 5.3 Flash'ı read-only ya da kontrollü edit modunda çalıştırır. Edit yalnız seçilmiş dosyaları disposable workspace sonrası trusted host workspace'e doğrulanmış promotion ile uygular.",
    inputSchema: publicToolSchemas.runGlm.shape,
    annotations: executionAnnotations
  }, safe(handlers.runGlm));

  server.registerTool("run_glm_edit_pilot", {
    title: "GLM disposable edit pilotu çalıştır",
    description: "GLM 5.2, HighSpeed, 5.3 veya 5.3 Flash'a yalnız bridge-owned disposable workspace içinde kontrollü dosya düzenleme görevi verir; ana workspace'e değişiklik uygulamaz.",
    inputSchema: publicToolSchemas.runGlmEditPilot.shape,
    annotations: executionAnnotations
  }, safe(handlers.runGlmEditPilot));

  for (const [provider, handler] of [["kimi", handlers.runKimi], ["qwen", handlers.runQwen]]) {
    server.registerTool(`check_${provider}_subagent`, {
      title: `${provider} subagent bağlantısını kontrol et`,
      description: `OpenCode model kataloğunda ${provider} model eşlemesini secret göstermeden kontrol eder.`,
      inputSchema: {},
      annotations: readOnlyAnnotations
    }, safe(async () => {
      const result = await runtime.checkCatalogProvider(provider);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    }));
    server.registerTool(`run_${provider}_subagent`, {
      title: `${provider} subagent çalıştır`,
      description: `OpenCode üzerinden ${provider} modelini read-only veya kontrollü edit modunda çalıştırır.`,
      inputSchema: publicToolSchemas.runCatalogProvider.shape,
      annotations: executionAnnotations
    }, safe(handler));
  }

  server.registerTool("check_antigravity_subagent", {
    title: "Antigravity subagent bağlantısını kontrol et",
    description: "Antigravity CLI yürütücüsünü, model eşlemesini ve auth durumunu secret değerlerini göstermeden kontrol eder.",
    inputSchema: {},
    annotations: readOnlyAnnotations
  }, safe(async () => {
    const health = await runtime.health(["antigravity"]);
    const entry = health.adapters.antigravity;
    const result = {
      adapterId: entry.id,
      capabilities: entry.capabilities,
      modePolicy: entry.modePolicy,
      configuredModels: entry.configuredModels,
      health: sanitizeHealth(entry.health),
      modelAliases: Object.keys(ANTIGRAVITY_MODEL_MAP),
      schemaValid: true
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }));

  server.registerTool("run_antigravity_subagent", {
    title: "Antigravity subagent çalıştır",
    description: "Antigravity CLI üzerinden Gemini Pro, Gemini Flash, Gemini 3.7 Flash, Gemini 3.8 Flash veya Claude Sonnet görevi devreder. İsteğe bağlı workspace yalnızca salt okunur modda ve izinli kökler altında kullanılabilir.",
    inputSchema: publicToolSchemas.runAntigravity.shape,
    annotations: executionAnnotations
  }, safe(handlers.runAntigravity));

  server.registerTool("run_claude_code_subagent", {
    title: "Claude Code subagent çalıştır",
    description: "Claude Code CLI üzerinden salt okunur veya düzenleme modunda görev devreder.",
    inputSchema: publicToolSchemas.runClaudeCode.shape,
    annotations: executionAnnotations
  }, safe(handlers.runClaudeCode));

  server.registerTool("run_opencode_subagent", {
    title: "OpenCode subagent çalıştır",
    description: "Açıkça belirtilmiş bağımsız OpenCode provider modellerine görev devreder. Gemini modelleri Antigravity üzerinden çalıştırılmalıdır.",
    inputSchema: publicToolSchemas.runOpenCode.shape,
    annotations: executionAnnotations
  }, safe(handlers.runOpenCode));

  server.registerTool("run_codex_subagent", {
    title: "OpenAI Codex subagent çalıştır",
    description: "OpenAI Codex CLI üzerinden salt okunur veya düzenleme modunda görev devreder.",
    inputSchema: publicToolSchemas.runCodex.shape,
    annotations: executionAnnotations
  }, safe(handlers.runCodex));

  server.registerTool("run_task_profile", {
    title: "Görev profiliyle subagent çalıştır",
    description: "Açıkça seçilen görev profiline ait canonical provider ve modla çalışır; yalnız policy'de tanımlı read-only fallback hedeflerini kullanabilir.",
    inputSchema: publicToolSchemas.runProfile.shape,
    annotations: executionAnnotations
  }, safe(handlers.runProfile));

  server.registerTool("check_subagent_bridge", {
    title: "Subagent bridge runtime bağlantısını kontrol et",
    description: "Runtime servislerini ve tüm provider adapter health durumlarını doğrular.",
    inputSchema: {},
    annotations: readOnlyAnnotations
  }, safe(async () => {
    const result = sanitizeRuntimeHealth(await runtime.health());
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }));

  server.registerTool("check_workspace_lock", {
    title: "Workspace kilit durumunu kontrol et",
    description: "Yerel kuyruk ve süreçler arası disk kilitlerini workspace yolu veya owner kimliği göstermeden raporlar.",
    inputSchema: {},
    annotations: readOnlyAnnotations
  }, safe(async () => {
    const result = runtime.workspaceLockSnapshot();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }));

  return server;
}
