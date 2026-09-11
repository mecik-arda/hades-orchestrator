# Hades Orchestrator

[English](#english) | [Türkçe](#türkçe)

# English

Hades Orchestrator is a provider-neutral orchestration system in which the OpenCode host and lead orchestrator invoke independent subagent backends over a local MCP layer. The runtime component is `subagent-bridge`; the host/orchestrator model and the subagent backend are separate.

## What it offers

- DeepSeek, GLM, Codex, Gemini/Antigravity and native Claude Code backends through a single MCP surface.
- Fail-closed read-only sandbox, controlled edits to selected files, promotion with rollback support.
- Access mode, cost, retry, persistent memory and redacted metric policies.

## Table of contents

- [Usage](#usage)
- [Verified baseline](#verified-baseline)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Personal configuration](#personal-configuration)
- [Canonical routing](#canonical-routing)
- [Task profiles](#task-profiles)
- [Verified provider matrix](#verified-provider-matrix)
- [Antigravity contract](#antigravity-contract)
- [Codex contract](#codex-contract)
- [Shared invariants](#shared-invariants)
- [Final acceptance evidence](#final-acceptance-evidence)
- [Test baseline](#test-baseline)
- [Known non-blocking items](#known-non-blocking-items)
- [Verified baseline freeze](#verified-baseline-freeze)
- [Model roles](#model-roles)
- [Security separation](#security-separation)
- [Skills](#skills)
- [Installation](#installation)
- [Launch](#launch)
- [Command reference](#command-reference)
- [Hard limits](#hard-limits)
- [Persistent memory](#persistent-memory)
- [Reliability and metrics](#reliability-and-metrics)
- [Architecture documents](#architecture-documents)
- [Continuous integration](#continuous-integration)
- [Acknowledgements](#acknowledgements)
- [License and contribution](#license-and-contribution)

## Usage

The runtime policy is loaded from `~/.config/subagent-bridge/config.json`; executable and adapter settings are loaded from `~/.config/subagent-bridge/agents.json`. `ORCHESTRATOR_CONFIG` and `SUBAGENT_BRIDGE_AGENTS_CONFIG` override the locations; `config/policy.json` and `config/agents.json` are distribution templates. The host MCP definition is adapted from `opencode.jsonc.example`; the server runs as `subagent-bridge/src/server.js` with `SUBAGENT_BRIDGE_TRUSTED_WORKSPACE`. Read-only tasks run through global tools, while controlled edits run with selected files and acceptance criteria. Verification: `npm test`, `npm run verify:ci`, `npm run budget`, `npm run metrics`.

## Verified baseline

The package is `hades-orchestrator@2.2.0`, the runtime is Node.js 20.9+ and ESM; CI uses Node.js 22/24. The canonical record lives under `%LOCALAPPDATA%\subagent-bridge\logs\metrics`, with the optional view at `<workspace>/.hades/runs.jsonl`. The current regression is `411/411 PASS`; `npm run verify`, `npm run verify:ci` and `npm run smoke` succeed.

## Quick start

```powershell
npm ci
npm test
npm run verify
npm run smoke
npm run runs:recent
```

Daily usage runs through the personal global integration; the repository-local MCP flow is for development and smoke testing. Provider credentials are never stored in the repository.

## Architecture

```text
OpenCode Host
└─ @orchestrator → local MCP → subagent-bridge
     ├─ MCP Frontend         → trusted host workspace injection
     ├─ Bridge Runtime       → canonical router, capability, lock, retry, cancellation
     ├─ AntigravityAdapter   → AGY (Gemini Pro/Flash, Claude Sonnet via Antigravity)
     ├─ ClaudeCodeAdapter    → native Claude Code
     ├─ OpenCodeAdapter      → DeepSeek, GLM, independent OpenCode providers/models
     ├─ CodexAdapter         → official OpenAI Codex CLI
     └─ Observability        → global redacted metrics + opt-in .hades mirror
```

```text
HOST / ORCHESTRATOR MODEL != SUBAGENT BACKEND
PACKAGE LOCATION != ACTIVE WORKSPACE
```

The active workspace is not derived from the package location, configuration or runtime CWD; `SUBAGENT_BRIDGE_TRUSTED_WORKSPACE` is canonicalized.

### Personal configuration

It passes `configVersion: 2` schema validation; unknown or missing fields are rejected. Providers are constrained by `defaultMode`/`allowedModes`. `reliability.monthlyCostLimitUsd: 50` and `warningThresholdPercent: 80` are enforced; `npm run budget` shows the current state. Codex `allowNonGitWorkspace` is enabled only through the personal machine config; DeepSeek preserves denied-root and Zod validation without requiring a Git repository.

### Canonical routing

```text
Gemini Pro / Flash      → AntigravityAdapter → AGY (gemini-3.1-pro-high / gemini-3.8-flash-high)
Codex                   → CodexAdapter → official standalone codex.exe
Native Claude Code      → ClaudeCodeAdapter
DeepSeek V4 Pro / Flash → OpenCodeAdapter → deepseek/deepseek-v4-pro or -flash
GLM 5.2/5.3 (+Flash)    → OpenCodeAdapter → zai-coding-plan/glm-5.2, -highspeed, -5.3, -5.3-flash
Independent OpenCode    → OpenCodeAdapter (only explicitly requested identities)
```

Gemini is not routed to OpenCodeAdapter. Results carry `requestedModel`, nullable `resolvedModel` and `accessMode`.

### Task profiles

`run_task_profile` executes the task with a fixed route; read-only profiles have no fallback. Edit fallback is used only in the policy `fallbackTargets` order, under a clean disposable workspace, a single attempt, secret inspection and verified promotion.

```text
quick_read              → Codex Luna, read_only, 30, cache enabled
low_cost_analysis       → DeepSeek Flash, read_only, 25, cache enabled
deep_analysis           → DeepSeek Pro, read_only, 20, cache enabled
low_cost_glm_highspeed  → GLM 5.2 HighSpeed, read_only, 22, cache enabled
glm_analysis            → GLM 5.2, read_only, 18, cache enabled
kimi_analysis           → Kimi K2.5 Instruct, read_only, 18, cache enabled
qwen_analysis           → Qwen3 Coder 480B, read_only, 18, cache enabled
web_research_fast       → Gemini Flash, read_only, 25, cache enabled
web_research / file_audit → Gemini Pro, read_only, 20, cache enabled
review                  → Codex Terra, read_only, 20, cache enabled
critical_review         → Codex Sol, read_only, 15, cache enabled
luna_implementation     → Codex Luna, edit, 12, cache disabled, no fallback
implementation          → Codex Terra, edit, 10, fallback: GLM 5.2 → DeepSeek Pro → Gemini Pro
glm_implementation      → GLM 5.2, edit, 8, fallback: DeepSeek Pro → Codex Terra → Gemini Pro
critical_implementation → Codex Sol, edit, 5, fallback: GLM 5.2 → DeepSeek Pro
```

Profiles live under `orchestration.taskProfiles` in `~/.config/subagent-bridge/config.json`.

```powershell
npm run config:apply-routing
npm run config:apply-agent-modes
```

Backups are created under `~/.config/subagent-bridge/backups/`; use `npm run config:rollback -- <backup>` or `npm run config:rollback-agent-modes -- <backup>` to roll back.

### Verified provider matrix

Antigravity/Gemini Pro and Flash, Codex and DeepSeek V4 Pro/Flash are verified. Because the GLM subscription is inactive, GLM models, profiles and fallbacks are not invoked; Codex Luna is the fast performance/cost implementer, Terra the balanced editor and Sol the model for hard debugging and review. The independent OpenCode backend depends on configuration, Claude Code on auth, and Kimi/Qwen on catalog entries.

### Antigravity contract

The canonical executable is `%LOCALAPPDATA%\agy\bin\agy.exe` and is invoked as `agy` through PATH.

```text
gemini_pro        → gemini-3.1-pro-high
gemini_flash      → gemini-3.8-flash-high
gemini_flash_3_7  → gemini-3.7-flash-high
gemini_flash_3_8  → gemini-3.8-flash-high
claude_sonnet     → claude-sonnet-4-6
```

Read-only calls are constrained with `--add-dir`, `deny write_file(*)` and `no command(*)` policies. The `agy mcp list` output must be `No MCP servers configured.`; external MCP, permanently broad permissions, mutation and network probing are rejected. Settings are serialized with a PID lock and restored afterwards.

Canonical error classes are `rate_limited`, `authentication_failure`, `permission_denied`, `timeout`, `server`, `network`, `process_exit`, `process_error` and `output_limit`; the real `exitCode` and `signal` are preserved. The provider circuit key is model-scoped for Antigravity (`antigravity:<model>`), so a transient failure in one model does not open the circuit for other Gemini models.

`check_antigravity_subagent` measures `modelAccess`, `toolFreeResponse`, `workspaceRead` and `webRead` per model with opt-in `probeModels` and `probeCapabilities`, serially and without side effects. `authValid: null` means the capability was not probed; `--version` success is not counted as auth success. Permission denial is reported as `not_probed` instead of `unavailable`. The default probe timeout is 300 seconds and is configurable through `antigravity.probeTimeoutMs`.

### Codex contract

The canonical executable is the official standalone `codex` on PATH.

```text
read_only  → codex exec --sandbox read-only
edit       → codex exec --sandbox workspace-write
```

The normal flow contains no sandbox or approval bypass. Edit tools apply only selected files in a disposable workspace with hash checks, secret scanning and rollback-supported promotion; test, build, script, package manager and mutating shell commands are forbidden.

### Shared invariants

```text
MAX_DELEGATION_DEPTH = 1
Host → subagent                         ALLOWED
subagent → bridge → another subagent   DENIED
```

Retry is limited to transient read-only failures within `maxRetries`. The workspace lock is the canonical workspace SHA-256; cache is used only for successful read-only results. Timeout and explicit cancel terminate the process tree.

### Final acceptance evidence

Gemini Pro and Codex were invoked with real file-backed results; timeout override, retry, fallback, repository mutation and orphan process were `0`; AGY settings restore `YES`, stale sentinel `NO`; acceptance `3x 143/143 PASS`.

### Test baseline

The current frozen regression baseline is `411/411 PASS`; timing-sensitive heavy verifications must run serially on the same machine.

### Known non-blocking items

The Codex `%TMPDIR` isolation evaluation, the non-reproducible historical AGY nested `ENOENT`, auth-dependent native Claude acceptance and pending Phase 5 providers are not blockers.

### Verified baseline freeze

The shared core is re-opened only for a confirmed production bug, a new provider, a security vulnerability, a measured concurrency defect or a contract-breaking upstream change.

## Model roles

Codex defines scope and architecture, runs code and tests, and verifies results. DeepSeek provides structured results for analysis, second opinions, research and planning; edits are limited to selected files. Gemini Pro is for web research and file auditing, Gemini Flash for short research, and native Claude Code for second opinions subject to auth.

## Security separation

- Local analysis and internet access are not combined in the same subagent call.
- `analyst`/`reviewer`/`planner` use only `Read`/`Glob`/`Grep`; `researcher` uses only `WebSearch`/`WebFetch`.
- API keys are never written to prompts, checkpoints or source code.

## Skills

Canonical skills live under `.agents/skills` and Claude-compatible copies under `.claude/skills`: `commit-at`, `guvenlik-ve-sertlestirme`, `kod-denetleyicisi`, `otomatik-dokumantasyon`, `veri-seti-analizcisi`. Synchronize with `npm run skills:sync`.

## Installation

Requirements: Node.js 20.9+ (22/24 recommended), OpenCode CLI, Antigravity CLI, the official standalone Codex CLI and Git; Claude Code CLI plus auth for native Claude, and an API key for DeepSeek.

```powershell
npm ci
npm test
npm run verify
npm run smoke
npm run pilot
```

DeepSeek user environment: `powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\configure-deepseek.ps1" -DeepSeekApiKey "<DEEPSEEK_API_KEY>"`.

## Launch

In daily usage the OpenCode host and `@orchestrator` connect to the canonical bridge source through the personal global integration; `context.worktree` is verified in a Git workspace and `context.directory` elsewhere. For repository-local development, start OpenCode at the project root and `opencode.jsonc` loads the local stdio MCP server.

## Command reference

```text
npm start                     Start the local MCP stdio bridge
npm run pilot                 DeepSeek Pro synthetic pilot
npm run pilot:flash           DeepSeek Flash synthetic pilot
npm run pilot:edit:deepseek   DeepSeek Pro disposable edit pilot
npm run accept:edit:deepseek  DeepSeek Pro controlled promotion acceptance (temporary workspace)
npm run accept:edit:glm       GLM 5.2 controlled promotion acceptance (temporary workspace)
npm run accept:read:glm       GLM 5.2 read-only acceptance (temporary workspace)
npm run smoke                 MCP tool schema and runtime health smoke test
npm run budget                Daily/monthly hard cap snapshot
npm run p0:e2e                Trusted workspace portability acceptance
npm run p2b:e2e               Personal global integration acceptance
npm test                      All Node.js regression tests
npm run verify                Local executable, skill, config and Vault verification
npm run verify:ci             Provider-auth-free CI verification
npm run metrics               Aggregated redacted metric summary
npm run metrics:prune         Retention-expired rotated metric cleanup
npm run runs:recent           Show recent runs read-only
npm run runs:mirror -- ...    Project-local mirror lifecycle
npm run edit:feedback         Record a direct-edit user outcome
npm run routing:feedback      Record a task-profile user outcome
npm run memory:review         Persistent memory lifecycle review
npm run memory:evaluate       Retrieval quality evaluation
npm run config:backup         Personal policy backup
```

## Hard limits

DeepSeek applies promotion to selected files only in `implementer` + `edit` mode; it cannot write to the Vault or outside the workspace. Codex does not consider a task complete without verification. Irreversible operations, production access, writes to external systems and secret transfer require human approval.

## Persistent memory

The Obsidian-compatible local Vault under `memory` is outside Git tracking. `check_persistent_memory`, `search_persistent_memory`, `read_persistent_memory`, `review_persistent_memory`, `analyze_memory_write`, `store_persistent_memory` and `promote_memory` manage secure access, drafts and SHA-256 controlled publishing. DeepSeek cannot access the Vault and cannot write to memory.

## Reliability and metrics

DeepSeek results are validated with Zod; transient failures use retry, circuit breaker and atomic cost reservation.

```text
%LOCALAPPDATA%\subagent-bridge\logs\metrics\
├─ codex-runs.jsonl
├─ antigravity-runs.jsonl
├─ opencode-runs.jsonl
├─ claude_code-runs.jsonl
└─ direct-edit-baseline-runs.jsonl
```

Records never contain prompt, response, diff, workspace or file paths, task ID or secrets. The optional `<workspace>/.hades/runs.jsonl` mirror is managed with `npm run runs:mirror -- enable|status|view|disable|clear --confirm`.

Execution metrics are written with the `execution_metric_v2` explicit allowlist; they carry `failureStage`, `providerCode`, the real `exitCode`, `signal`, `retryDecision`, `retryStopReason`, `settingsLockWaitMs`, `providerExecutionMs` and stdout/stderr size buckets. `recent-runs` is a strict v1/v2 reader and the operator view shows only the last-attempt diagnosis; the full attempt array stays in the machine metric.

## Architecture documents

Key decisions live under [`docs/architecture`](docs/architecture):

- [`CONTEXT_ORKESTRASYONU_VE_GUVENLI_SECOND_BRAIN_PLANI_2026-08-21.md`](docs/architecture/CONTEXT_ORKESTRASYONU_VE_GUVENLI_SECOND_BRAIN_PLANI_2026-08-21.md)
- [`MODEL_KIMLIGI_VE_ERISIM_MODU_PLANI.md`](docs/architecture/MODEL_KIMLIGI_VE_ERISIM_MODU_PLANI.md)
- [`DEEPSEEK_EDIT_PILOT_VE_MIRROR_KARARLILIK_PLANI.md`](docs/architecture/DEEPSEEK_EDIT_PILOT_VE_MIRROR_KARARLILIK_PLANI.md)
- [`RECENT_RUNS_GOZLEMLENEBILIRLIK_PLANI.md`](docs/architecture/RECENT_RUNS_GOZLEMLENEBILIRLIK_PLANI.md)

## Continuous integration

`.github/workflows/validate.yml` runs `npm ci`, `npm test` and `npm run verify:ci` on Windows and Linux with Node 22/24. `verify:ci` requires no local executable, provider auth or Vault. Use `npm run config:backup` before a personal policy change and `npm run config:rollback -- <backup>` to roll back.

## Acknowledgements

The architectural approach is inspired by [Avenox](https://avenox.lol/) projects and [github.com/avenoxai](https://github.com/avenoxai) repositories.

## License and contribution

- License: [Apache-2.0](LICENSE)
- Security reporting: [SECURITY.md](SECURITY.md)
- Contribution guide: [CONTRIBUTING.md](CONTRIBUTING.md)

# Türkçe

Hades Orchestrator, OpenCode host ve ana orkestratörün yerel MCP üzerinden bağımsız subagent backend’lerini çağırdığı provider-neutral orkestrasyon sistemidir. Çalışma zamanı bileşeni `subagent-bridge`’dir; host/orkestratör modeli ile subagent backend’i ayrıdır.

## Ne sunar

- Tek MCP yüzeyinden DeepSeek, GLM, Codex, Gemini/Antigravity ve native Claude Code backend’leri.
- Fail-closed salt-okunur sandbox, seçili dosyalara kontrollü edit, rollback destekli promotion.
- Erişim modu, maliyet, retry, kalıcı hafıza ve redacted metrik politikaları.

## İçindekiler

- [Kullanım](#kullanım)
- [Doğrulanmış taban](#doğrulanmış-taban)
- [Hızlı başlangıç](#hızlı-başlangıç)
- [Mimari](#mimari)
- [Kişisel yapılandırma](#kişisel-yapılandırma)
- [Kanonik yönlendirme](#kanonik-yönlendirme)
- [Görev profilleri](#görev-profilleri)
- [Doğrulanmış sağlayıcı matrisi](#doğrulanmış-sağlayıcı-matrisi)
- [Antigravity sözleşmesi](#antigravity-sözleşmesi)
- [Codex sözleşmesi](#codex-sözleşmesi)
- [Ortak değişmezler](#ortak-değişmezler)
- [Nihai kabul kanıtı](#nihai-kabul-kanıtı)
- [Test tabanı](#test-tabanı)
- [Bilinen engelleyici olmayan maddeler](#bilinen-engelleyici-olmayan-maddeler)
- [Doğrulanmış taban dondurma](#doğrulanmış-taban-dondurma)
- [Model rolleri](#model-rolleri)
- [Güvenlik ayrımı](#güvenlik-ayrımı)
- [Skill’ler](#skiller)
- [Kurulum](#kurulum)
- [Başlatma](#başlatma)
- [Komut referansı](#komut-referansı)
- [Kalıcı sınırlar](#kalıcı-sınırlar)
- [Kalıcı hafıza](#kalıcı-hafıza)
- [Güvenilirlik ve metrikler](#güvenilirlik-ve-metrikler)
- [Mimari dokümanlar](#mimari-dokümanlar)
- [Sürekli entegrasyon](#sürekli-entegrasyon)
- [Teşekkür](#teşekkür)
- [Lisans ve katkı](#lisans-ve-katkı)

## Kullanım

Runtime policy’si `~/.config/subagent-bridge/config.json`, executable ve adapter ayarları `~/.config/subagent-bridge/agents.json` dosyasından yüklenir. `ORCHESTRATOR_CONFIG` ve `SUBAGENT_BRIDGE_AGENTS_CONFIG` konumları değiştirir; `config/policy.json` ve `config/agents.json` dağıtım şablonudur. Host MCP tanımı `opencode.jsonc.example` ile uyarlanır; server `subagent-bridge/src/server.js` ve `SUBAGENT_BRIDGE_TRUSTED_WORKSPACE` ile çalışır. Salt-okunur görevler global araçlarla, kontrollü edit ise seçili dosya ve kabul kriterleriyle yürütülür. Doğrulama: `npm test`, `npm run verify:ci`, `npm run budget`, `npm run metrics`.

## Doğrulanmış taban

Paket `hades-orchestrator@2.2.0`, çalışma zamanı Node.js 20.9+ ve ESM’dir; CI Node.js 22/24 kullanır. Kanonik kayıt `%LOCALAPPDATA%\subagent-bridge\logs\metrics`, isteğe bağlı görünüm `<workspace>/.hades/runs.jsonl` altındadır. Güncel regresyon `411/411 PASS`; `npm run verify`, `npm run verify:ci` ve `npm run smoke` başarılıdır.

## Hızlı başlangıç

```powershell
npm ci
npm test
npm run verify
npm run smoke
npm run runs:recent
```

Günlük kullanım kişisel global entegrasyonla yürür; repository-local MCP akışı geliştirme ve smoke testi içindir. Provider kimlik bilgileri repoda tutulmaz.

## Mimari

```text
OpenCode Host
└─ @orchestrator → local MCP → subagent-bridge
     ├─ MCP Frontend         → trusted host workspace injection
     ├─ Bridge Runtime       → canonical router, capability, lock, retry, cancellation
     ├─ AntigravityAdapter   → AGY (Gemini Pro/Flash, Claude Sonnet via Antigravity)
     ├─ ClaudeCodeAdapter    → native Claude Code
     ├─ OpenCodeAdapter      → DeepSeek, GLM, bağımsız OpenCode provider/model
     ├─ CodexAdapter         → official OpenAI Codex CLI
     └─ Observability        → global redacted metrics + opt-in .hades mirror
```

```text
HOST / ORKESTRATOR MODEL != SUBAGENT BACKEND
PACKAGE LOCATION != ACTIVE WORKSPACE
```

Aktif workspace package konumundan, config’ten veya runtime CWD’den türetilmez; `SUBAGENT_BRIDGE_TRUSTED_WORKSPACE` canonicalize edilir.

### Kişisel yapılandırma

`configVersion: 2` şema doğrulamasından geçer; bilinmeyen veya eksik alan reddedilir. Provider’lar `defaultMode`/`allowedModes` ile sınırlıdır. `reliability.monthlyCostLimitUsd: 50` ve `warningThresholdPercent: 80` uygulanır; `npm run budget` anlık durumu gösterir. Codex `allowNonGitWorkspace` yalnız kişisel machine config ile açılır; DeepSeek Git repository zorunluluğu olmadan denied-root ve Zod doğrulamasını korur.

### Kanonik yönlendirme

```text
Gemini Pro / Flash      → AntigravityAdapter → AGY (gemini-3.1-pro-high / gemini-3.8-flash-high)
Codex                   → CodexAdapter → official standalone codex.exe
Native Claude Code      → ClaudeCodeAdapter
DeepSeek V4 Pro / Flash → OpenCodeAdapter → deepseek/deepseek-v4-pro veya -flash
GLM 5.2/5.3 (+Flash)    → OpenCodeAdapter → zai-coding-plan/glm-5.2, -highspeed, -5.3, -5.3-flash
Bağımsız OpenCode model → OpenCodeAdapter (yalnız açıkça istenen kimlikler)
```

Gemini OpenCodeAdapter’a yönlendirilmez. Sonuçlar `requestedModel`, nullable `resolvedModel` ve `accessMode` taşır.

### Görev profilleri

`run_task_profile` görevi sabit route ile çalıştırır; read-only profillerde fallback yoktur. Edit fallback’i yalnız policy’deki `fallbackTargets` sırası ile temiz disposable workspace, tek deneme, secret denetimi ve doğrulanmış promotion altında kullanılır.

```text
quick_read              → Codex Luna, read_only, 30, cache açık
low_cost_analysis       → DeepSeek Flash, read_only, 25, cache açık
deep_analysis           → DeepSeek Pro, read_only, 20, cache açık
low_cost_glm_highspeed  → GLM 5.2 HighSpeed, read_only, 22, cache açık
glm_analysis            → GLM 5.2, read_only, 18, cache açık
kimi_analysis           → Kimi K2.5 Instruct, read_only, 18, cache açık
qwen_analysis           → Qwen3 Coder 480B, read_only, 18, cache açık
web_research_fast       → Gemini Flash, read_only, 25, cache açık
web_research / file_audit → Gemini Pro, read_only, 20, cache açık
review                  → Codex Terra, read_only, 20, cache açık
critical_review         → Codex Sol, read_only, 15, cache açık
luna_implementation     → Codex Luna, edit, 12, cache kapalı, fallback yok
implementation          → Codex Terra, edit, 10, fallback: GLM 5.2 → DeepSeek Pro → Gemini Pro
glm_implementation      → GLM 5.2, edit, 8, fallback: DeepSeek Pro → Codex Terra → Gemini Pro
critical_implementation → Codex Sol, edit, 5, fallback: GLM 5.2 → DeepSeek Pro
```

Profiller `~/.config/subagent-bridge/config.json` içindeki `orchestration.taskProfiles` alanındadır.

```powershell
npm run config:apply-routing
npm run config:apply-agent-modes
```

Backup `~/.config/subagent-bridge/backups/` altında oluşturulur; rollback için `npm run config:rollback -- <backup>` veya `npm run config:rollback-agent-modes -- <backup>` kullanılır.

### Doğrulanmış sağlayıcı matrisi

Antigravity/Gemini Pro ve Flash, Codex ve DeepSeek V4 Pro/Flash doğrulanmıştır. GLM aboneliği pasif olduğundan GLM model, profil ve fallback'leri çağrılmaz; Codex Luna hızlı fiyat/performans uygulayıcı, Terra dengeli edit, Sol zor hata ayıklama ve denetim modelidir. OpenCode bağımsız backend’i yapılandırmaya, Claude Code auth’a, Kimi/Qwen katalog girdisine bağlıdır.

### Antigravity sözleşmesi

Kanonik executable `%LOCALAPPDATA%\agy\bin\agy.exe` olup PATH üzerinden `agy` çağrılır.

```text
gemini_pro        → gemini-3.1-pro-high
gemini_flash      → gemini-3.8-flash-high
gemini_flash_3_7  → gemini-3.7-flash-high
gemini_flash_3_8  → gemini-3.8-flash-high
claude_sonnet     → claude-sonnet-4-6
```

Salt-okunur çağrı `--add-dir`, `deny write_file(*)` ve `no command(*)` politikalarıyla sınırlanır. `agy mcp list` sonucu `No MCP servers configured.` olmalıdır; harici MCP, kalıcı geniş izin, mutasyon ve network probe reddedilir. Ayarlar PID lock ile serileştirilir ve geri yüklenir.

Kanonik hata sınıfları `rate_limited`, `authentication_failure`, `permission_denied`, `timeout`, `server`, `network`, `process_exit`, `process_error` ve `output_limit`’tir; gerçek `exitCode` ve `signal` korunur. Provider circuit anahtarı Antigravity’de model bazlıdır (`antigravity:<model>`), böylece bir modelin geçici hatası diğer Gemini modellerini kapatmaz.

`check_antigravity_subagent`, opt-in `probeModels` ve `probeCapabilities` ile model başına `modelAccess`, `toolFreeResponse`, `workspaceRead` ve `webRead` yeteneklerini seri ve yan etkisiz ölçer. `authValid: null` probe yapılmadığını ifade eder; `--version` başarısı auth başarısı sayılmaz. İzin reddi `unavailable` yerine `not_probed` raporlanır. Varsayılan probe zaman aşımı 300 sn’dir ve `antigravity.probeTimeoutMs` ile ayarlanır.

### Codex sözleşmesi

Kanonik executable PATH üzerindeki resmi standalone `codex`’tir.

```text
read_only  → codex exec --sandbox read-only
edit       → codex exec --sandbox workspace-write
```

Normal akış sandbox veya approval bypass içermez. Edit araçları disposable workspace’te yalnız seçili dosyaları hash kontrolü, secret taraması ve rollback destekli promotion ile uygular; test, build, script, paket yöneticisi ve mutasyon yapan shell komutları yasaktır.

### Ortak değişmezler

```text
MAX_DELEGATION_DEPTH = 1
Host → subagent                         ALLOWED
subagent → bridge → another subagent   DENIED
```

Retry yalnız geçici salt-okunur hatalarda `maxRetries` sınırındadır. Workspace lock canonical workspace SHA-256’sıdır; cache yalnız başarılı salt-okunur sonuçlarda kullanılır. Timeout ve explicit cancel süreç ağacını sonlandırır.

### Nihai kabul kanıtı

Gemini Pro ve Codex gerçek file-backed sonuçla çağrıldı; timeout override, retry, fallback, repository mutation ve orphan process `0`; AGY settings restore `YES`, stale sentinel `NO`; acceptance `3x 143/143 PASS`.

### Test tabanı

Güncel dondurulmuş regresyon tabanı `411/411 PASS`’tir; zamanlamaya duyarlı ağır doğrulamalar aynı makinede sıralı çalıştırılmalıdır.

### Bilinen engelleyici olmayan maddeler

Codex `%TMPDIR` isolation değerlendirmesi, yeniden üretilemeyen tarihsel AGY nested `ENOENT`, auth’a bağlı native Claude acceptance ve bekleyen Faz 5 provider’ları engelleyici değildir.

### Doğrulanmış taban dondurma

Shared core yalnız confirmed production bug, yeni provider, security vulnerability, ölçülmüş concurrency defect veya contract-breaking upstream değişikliğiyle yeniden açılır.

## Model rolleri

Codex kapsamı ve mimariyi belirler, kodu ve testleri yürütür, sonuçları doğrular. DeepSeek analiz, ikinci görüş, araştırma ve planlama için yapılandırılmış sonuç verir; edit yalnız seçili dosyalardadır. Gemini Pro web araştırması ve dosya denetimi, Gemini Flash kısa araştırma, native Claude Code auth’a bağlı ikinci görüş içindir.

## Güvenlik ayrımı

- Yerel analiz ve internet erişimi aynı subagent çağrısında birleşmez.
- `analyst`/`reviewer`/`planner` yalnız `Read`/`Glob`/`Grep`; `researcher` yalnız `WebSearch`/`WebFetch` kullanır.
- API anahtarları prompta, checkpoint’e veya kaynak koda yazılmaz.

## Skill’ler

Kanonik skill’ler `.agents/skills`, Claude uyumlu kopyalar `.claude/skills` altındadır: `commit-at`, `guvenlik-ve-sertlestirme`, `kod-denetleyicisi`, `otomatik-dokumantasyon`, `veri-seti-analizcisi`. Eşitleme: `npm run skills:sync`.

## Kurulum

Gereksinimler: Node.js 20.9+ (22/24 önerilir), OpenCode CLI, Antigravity CLI, resmi standalone Codex CLI ve Git; native Claude için Claude Code CLI + auth, DeepSeek için API anahtarı.

```powershell
npm ci
npm test
npm run verify
npm run smoke
npm run pilot
```

DeepSeek kullanıcı ortamı: `powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\configure-deepseek.ps1" -DeepSeekApiKey "<DEEPSEEK_API_KEY>"`.

## Başlatma

Günlük kullanımda OpenCode host ve `@orchestrator` kişisel global entegrasyonla canonical bridge source’a bağlanır; Git workspace’te `context.worktree`, diğerlerinde `context.directory` doğrulanır. Repository-local geliştirmede proje kökünde OpenCode başlatılır ve `opencode.jsonc` local stdio MCP sunucusunu yükler.

## Komut referansı

```text
npm start                     Local MCP stdio bridge'i başlatır
npm run pilot                 DeepSeek Pro sentetik pilotu
npm run pilot:flash           DeepSeek Flash sentetik pilotu
npm run pilot:edit:deepseek   DeepSeek Pro disposable edit pilotu
npm run accept:edit:deepseek  DeepSeek Pro kontrollü promotion kabulü (geçici workspace)
npm run accept:edit:glm       GLM 5.2 kontrollü promotion kabulü (geçici workspace)
npm run accept:read:glm       GLM 5.2 salt-okunur kabulü (geçici workspace)
npm run smoke                 MCP araç şeması ve runtime health smoke testi
npm run budget                Günlük/aylık hard cap snapshot'ı
npm run p0:e2e                Trusted workspace portability kabulü
npm run p2b:e2e               Kişisel global entegrasyon kabulü
npm test                      Tüm Node.js regresyon testleri
npm run verify                Yerel executable, skill, config ve Vault doğrulaması
npm run verify:ci             Provider auth gerektirmeyen CI doğrulaması
npm run metrics               Toplu redacted metric özeti
npm run metrics:prune         Retention dışı rotated metric temizliği
npm run runs:recent           Son çalışmaları salt-okunur gösterir
npm run runs:mirror -- ...    Proje-local mirror yaşam döngüsü
npm run edit:feedback         Direct-edit kullanıcı sonucu kaydı
npm run routing:feedback      Task-profile kullanıcı sonucu kaydı
npm run memory:review         Kalıcı hafıza yaşam döngüsü denetimi
npm run memory:evaluate       Retrieval kalite değerlendirmesi
npm run config:backup         Kişisel policy backup'ı
```

## Kalıcı sınırlar

DeepSeek yalnız `implementer` + `edit` modunda seçili dosyalara promotion uygular; Vault veya workspace dışına yazamaz. Codex doğrulamasız görevi tamamlanmış saymaz. Geri alınamaz işlem, üretim erişimi, dış sistemde yazma ve secret aktarımı insan onayı gerektirir.

## Kalıcı hafıza

`memory` klasöründeki Obsidian uyumlu yerel Vault, Git takibinin dışındadır. `check_persistent_memory`, `search_persistent_memory`, `read_persistent_memory`, `review_persistent_memory`, `analyze_memory_write`, `store_persistent_memory` ve `promote_memory` güvenli erişim, taslak ve SHA-256 kontrollü yayını yönetir. DeepSeek Vault’a erişemez ve belleğe yazamaz.

## Güvenilirlik ve metrikler

DeepSeek sonucu Zod ile doğrulanır; geçici hatalarda retry, circuit breaker ve atomik maliyet rezervasyonu uygulanır.

```text
%LOCALAPPDATA%\subagent-bridge\logs\metrics\
├─ codex-runs.jsonl
├─ antigravity-runs.jsonl
├─ opencode-runs.jsonl
├─ claude_code-runs.jsonl
└─ direct-edit-baseline-runs.jsonl
```

Kayıtlar prompt, cevap, diff, workspace veya dosya yolu, task ID ve secret içermez. İsteğe bağlı `<workspace>/.hades/runs.jsonl` mirror’ı `npm run runs:mirror -- enable|status|view|disable|clear --confirm` ile yönetilir.

Execution metrikleri `execution_metric_v2` explicit allowlist’i ile yazılır; `failureStage`, `providerCode`, gerçek `exitCode`, `signal`, `retryDecision`, `retryStopReason`, `settingsLockWaitMs`, `providerExecutionMs` ve stdout/stderr boyut kovaları taşınır. `recent-runs` strict v1/v2 okuyucusudur ve operatör görünümünde yalnız son attempt tanısı gösterilir; tam attempt dizisi machine metric’te kalır.

## Mimari dokümanlar

Temel kararlar [`docs/architecture`](docs/architecture) altındadır:

- [`CONTEXT_ORKESTRASYONU_VE_GUVENLI_SECOND_BRAIN_PLANI_2026-08-21.md`](docs/architecture/CONTEXT_ORKESTRASYONU_VE_GUVENLI_SECOND_BRAIN_PLANI_2026-08-21.md)
- [`MODEL_KIMLIGI_VE_ERISIM_MODU_PLANI.md`](docs/architecture/MODEL_KIMLIGI_VE_ERISIM_MODU_PLANI.md)
- [`DEEPSEEK_EDIT_PILOT_VE_MIRROR_KARARLILIK_PLANI.md`](docs/architecture/DEEPSEEK_EDIT_PILOT_VE_MIRROR_KARARLILIK_PLANI.md)
- [`RECENT_RUNS_GOZLEMLENEBILIRLIK_PLANI.md`](docs/architecture/RECENT_RUNS_GOZLEMLENEBILIRLIK_PLANI.md)

## Sürekli entegrasyon

`.github/workflows/validate.yml`, Windows ve Linux üzerinde Node 22/24 ile `npm ci`, `npm test` ve `npm run verify:ci` çalıştırır. `verify:ci` yerel executable, provider auth veya Vault gerektirmez. Kişisel policy değişikliğinden önce `npm run config:backup`, geri alma için `npm run config:rollback -- <backup>` kullanılır.

## Teşekkür

Mimari yaklaşım [Avenox](https://avenox.lol/) projeleri ve [github.com/avenoxai](https://github.com/avenoxai) depolarından ilham alır.

## Lisans ve katkı

- Lisans: [Apache-2.0](LICENSE)
- Güvenlik açığı bildirimi: [SECURITY.md](SECURITY.md)
- Katkı rehberi: [CONTRIBUTING.md](CONTRIBUTING.md)
