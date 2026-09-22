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
- [MCP rule attestation](#mcp-rule-attestation)
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

The package is `hades-orchestrator@2.2.0`, the runtime is Node.js 20.9+ and ESM; CI uses Node.js 22/24. The canonical record lives under `%LOCALAPPDATA%\subagent-bridge\logs\metrics`, with the optional view at `<workspace>/.hades/runs.jsonl`. Run `npm test` for the current regression; `npm run verify`, `npm run verify:ci` and `npm run smoke` succeed.

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

### MCP rule attestation

The bridge exposes one read-only resource for a redacted workspace-rule manifest:

- URI: `hades://rules/attestation/v1`
- Name: `rule-attestation-v1`
- MIME type: `application/json`
- Files: `AGENTS.md`, `CLAUDE.md`, `config/agent-rules.md`
- Hash contract: SHA-256 of the unchanged raw UTF-8 file bytes

The manifest uses a strict schema, fixed entry order, RFC 8785 canonicalization, fixed file and total-size limits, descriptor reads, link checks, UTF-8 validation, secret scanning and TOCTOU checks. No tool fallback exists. Unsupported resource clients remain `unsupported` rather than invoking a tool.

The result is an untrusted observation with `sourceClass: "mcp_resource"`. `workspace_file` and `mcp_resource` can report a matching snapshot; `startup_context` is `unavailable` until a trusted host loader hook exists. The resource does not prove that the host injected the rules into startup context, that a model followed them, or that the returned resource is a signed attestation. The contract and implementation are recorded in [the MCP rule attestation plan](docs/plans/yapilanlar/MCP_KURAL_DOGRULAMA_PLANI_2026-09-20.md). `npm run smoke` validates resource listing, reading and the strict manifest.

### Personal configuration

It passes `configVersion: 2` schema validation; unknown or missing fields are rejected. Providers are constrained by `defaultMode`/`allowedModes`. `reliability.monthlyCostLimitUsd: 100` and `warningThresholdPercent: 80` are advisory references; admission-time budget enforcement is off by default (`costBudgetEnforced: false`) and can be enabled explicitly. `npm run budget` shows the snapshot, separating observed cost, estimated/reserved cost, run counts and cost coverage; unknown cost is reported as `not_observable` and is never counted as zero. When enforcement is enabled, the limit is checked atomically at reservation time against active reservations and recorded spend; a late settlement after an expired reservation is still counted, and any exceedance is surfaced as `dailyOverageUsd`/`monthlyOverageUsd`. Codex `allowNonGitWorkspace` is enabled only through the personal machine config; DeepSeek preserves denied-root and Zod validation without requiring a Git repository.

### Canonical routing

```text
Gemini Pro / Flash      → AntigravityAdapter → AGY (gemini-3.1-pro-high / gemini-3.8-flash-high)
Codex                   → CodexAdapter → official standalone codex.exe
Native Claude Code      → ClaudeCodeAdapter
DeepSeek V4 Pro / Flash → OpenCodeAdapter → deepseek/deepseek-v4-pro or deepseek/deepseek-flash (DeepSeek-V4.1-Flash)
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
sol6_review             → GPT-6 Sol, read_only, 13, cache enabled
luna6_review            → GPT-6 Luna, read_only, 13, cache enabled
luna_implementation     → Codex Luna, edit, 12, cache disabled, no fallback
implementation          → Codex Terra, edit, 10, fallback: GLM 5.2 → DeepSeek Pro → Gemini Pro
glm_implementation      → GLM 5.2, edit, 8, fallback: DeepSeek Pro → Codex Terra → Gemini Pro
critical_implementation → Codex Sol, edit, 5, fallback: GLM 5.2 → DeepSeek Pro
sol6_implementation     → GPT-6 Sol, edit, 4, fallback: Codex Sol (5.6) → DeepSeek Pro
luna6_implementation    → GPT-6 Luna, edit, 11, no fallback
```

Profiles live under `orchestration.taskProfiles` in `~/.config/subagent-bridge/config.json`.

```powershell
npm run config:apply-routing
npm run config:apply-agent-modes
```

Backups are created under `~/.config/subagent-bridge/backups/`; use `npm run config:rollback -- <backup>` or `npm run config:rollback-agent-modes -- <backup>` to roll back.

### Verified provider matrix

Antigravity/Gemini Pro and Flash, Codex and DeepSeek V4 Pro/Flash are verified. GPT-6 Luna, GPT-6 Sol and GPT-6 Astra are verified Codex identities (live capability probe, 2026-09-22); GPT-6 Luna/Sol are preferred for the Luna/Sol roles and the GPT-5.6 counterparts remain as compatibility profiles. Because the GLM subscription is inactive, GLM models, profiles and fallbacks are not invoked; Codex Luna is the fast performance/cost implementer, Terra the balanced editor and Sol the model for hard debugging and review. The independent OpenCode backend depends on configuration, Claude Code requires an active subscription and its native acceptance phase is closed here, and Kimi/Qwen depend on catalog entries.

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

The normal flow contains no sandbox or approval bypass. Edit tools apply only selected files in a disposable workspace with hash checks, secret scanning and rollback-supported promotion; test, build, script, package manager and mutating shell commands are forbidden. High-impact promotions stay fail-closed until the orchestrator approves the stored prepared edit; multi-file application provides handled-error rollback. Interrupted promotion artifacts block new applications until manual recovery: inspect the `.tmp` and `.tmp.backup` artifacts in the target directories, restore a `.backup` over its source when needed, then remove the artifacts before retrying.

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

The current regression baseline is verified with `npm test`; timing-sensitive heavy verifications must run serially on the same machine.

### Known non-blocking items

The Codex `%TMPDIR` isolation evaluation, the non-reproducible historical AGY nested `ENOENT`, the closed native Claude acceptance phase (no Claude Code subscription) and pending Phase 5 providers are not blockers.

### Verified baseline freeze

The shared core is re-opened only for a confirmed production bug, a new provider, a security vulnerability, a measured concurrency defect or a contract-breaking upstream change.

## Model roles

Codex defines scope and architecture, runs code and tests, and verifies results. DeepSeek provides structured results for analysis, second opinions, research and planning; edits are limited to selected files. Gemini Pro is for web research and file auditing, Gemini Flash for short research, and second opinions use DeepSeek or Antigravity Claude Sonnet; native Claude Code stays disabled without a subscription.

## Security separation

- Local analysis and internet access are not combined in the same subagent call.
- `analyst`/`reviewer`/`planner` use only `Read`/`Glob`/`Grep`; `researcher` uses only `WebSearch`/`WebFetch`.
- API keys are never written to prompts, checkpoints or source code.

## Skills

Canonical skills live under `.agents/skills` and Claude-compatible copies under `.claude/skills`: `commit-at`, `guvenlik-ve-sertlestirme`, `kod-denetleyicisi`, `otomatik-dokumantasyon`, `veri-seti-analizcisi`, `proje-kesif-planlama`, `model-saglayici-ekleme`, `dogrulama-kapisi`, `mcp-sozlesme-denetimi`, `hafiza-vault-bakimi`, `maliyet-ve-butce-denetimi`, `bagimlilik-guvenligi`. Synchronize with `npm run skills:sync`. Global installs copy the same folders into `~/.config/opencode/skills`, `~/.codex/skills`, `~/.claude/skills` and `~/.agents/skills` so the skills are available outside the project; `npm run verify` checks the `.agents` ↔ `.claude` synchronization, while global copies are installed manually and are outside that gate. `npm run skills:check-global` compares the four global copies against the canonical `.agents` source and reports equal, missing and different roots; `--strict` treats missing copies as failures. `proje-kesif-planlama` writes the plan document through `codexLunaEdit` on a single selected file and verifies the change set stays within that file.

## Installation

Requirements: Node.js 20.9+ (22/24 recommended), OpenCode CLI, Antigravity CLI, the official standalone Codex CLI and Git; an API key for DeepSeek. The optional native Claude Code backend requires a Claude Code subscription and stays disabled without one.

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
npm run budget                Advisory budget, observed/estimated cost and coverage snapshot
npm run p0:e2e                Trusted workspace portability acceptance
npm run p2b:e2e               Personal global integration acceptance
npm test                      All Node.js regression tests
npm run verify                Local executable, skill, config and Vault verification
npm run verify:ci             Provider-auth-free CI verification
npm run skills:check-global   Compare the four global skill copies with the canonical source (--strict fails on missing)
npm run metrics               Aggregated redacted metric summary
npm run metrics:prune         Retention-expired rotated metric cleanup
npm run runs:recent           Show recent runs read-only
npm run runs:mirror -- ...    Project-local mirror lifecycle
npm run edit:feedback         Record a direct-edit user outcome
npm run edit:classify         Append-only direct-edit eligibility disposition (list|dispose|classify-legacy)
npm run routing:feedback      Record a task-profile user outcome
npm run routing:classify      Classify a read-only routing run before feedback
npm run hook:feedback          Record a redacted memory-hook session outcome
npm run hook:classify          Classify a memory-hook session before feedback
npm run memory:review         Persistent memory lifecycle review
npm run memory:doctor         Read-only Vault health, version and audit diagnosis
npm run memory:repair         Explicit Vault repair (dry-run by default, --apply to write)
npm run state:migrate         Explicit runtime state migration (dry-run by default)
npm run video:collect         Collect a public YouTube transcript as an untrusted, hashed envelope (--url=, optional --out=)
npm run hook:install          Generate the opt-in read-only memory hook (--client=opencode|codex|claude)
npm run memory:evaluate       Retrieval quality evaluation
npm run config:backup         Personal policy backup
```

## Hard limits

DeepSeek applies promotion to selected files only in `implementer` + `edit` mode; it cannot write to the Vault or outside the workspace. Codex does not consider a task complete without verification. Irreversible operations, production access, writes to external systems and secret transfer require human approval.

## Persistent memory

The Obsidian-compatible local Vault under `memory` is outside Git tracking. `check_persistent_memory`, `search_persistent_memory`, `read_persistent_memory`, `review_persistent_memory`, `analyze_memory_write`, `store_persistent_memory` and `promote_memory` manage secure access, drafts and SHA-256 controlled publishing. DeepSeek cannot access the Vault and cannot write to memory.

The write pipeline rejects secret-like, PII-shaped and prompt-injection content before writing; PII detection is checksum-validated for national ID, IBAN and payment cards. The note's `relativePath` is also scanned for PII, injection markers and exact secret signatures; the high-entropy heuristic is limited to non-path content. `store_persistent_memory` stores injection-marked content only with `acknowledgeInjectionRisk: true`, and the attempt is recorded as a redacted `QUARANTINE` audit event. `analyze_memory_write` returns a `coverage` block (indexed files, index cap, truncation), and idempotent `promote_memory` returns `auditWritten` and `recoveryRequired` evidence fields.

`npm run memory:doctor` reports frontmatter, soft-expiry, quarantine, hash-integrity, schema-version and audit-race findings read-only; it never deletes, moves, merges or repairs a note. The Vault and runtime state carry explicit schema versions; incompatible state fails closed at startup and requires `npm run state:migrate`.

The optional hook enriches a client session with at most five read-only Vault excerpts (1200 characters). It never writes or publishes, excludes drafts, expired and quarantined notes, and stays silent when memory is unavailable. Consumption profiles (`normal`, `economic`, `manual`) only change automation parameters; secret scanning, path/symlink protection, SHA-256 locking, schema validation, quarantine and write permissions are invariant. Install per client with `npm run hook:install -- --client=opencode` (add `--apply`), `--client=codex` (`~/.codex/hooks.json`, requires `/hooks` trust review) or `--client=claude` (prints the `settings.json` snippet; merge manually). The OpenCode plugin additionally requires `SUBAGENT_SECOND_BRAIN_HOOK=1`.

`npm run video:collect -- --url=<watch-url> [--out=<file>]` downloads only subtitles and oEmbed metadata for a public YouTube video through local `yt-dlp`, verifies the video identity, enforces 2 MB subtitle and 400k character transcript limits and prints a hashed `untrusted_video_transcript` envelope. Antigravity read-only calls additionally enforce the JSON carrier with `--json-schema` and allow one bounded carrier repair attempt when validation fails. Nested JSON carrier envelopes are unwrapped to a bounded depth of two; inner `webEvidence` is preserved when the outer layer is empty, and invalid evidence is rejected by the strict schema.

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

These documents are historical plans. Each audited plan starts with a dated status note; current verification is `npm test` and CI rather than the fixed test or tool counts captured at plan creation time.

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
- [MCP kural attestation](#mcp-kural-attestation)
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

Paket `hades-orchestrator@2.2.0`, çalışma zamanı Node.js 20.9+ ve ESM’dir; CI Node.js 22/24 kullanır. Kanonik kayıt `%LOCALAPPDATA%\subagent-bridge\logs\metrics`, isteğe bağlı görünüm `<workspace>/.hades/runs.jsonl` altındadır. Güncel regresyon için `npm test` çalıştırılır; `npm run verify`, `npm run verify:ci` ve `npm run smoke` başarılıdır.

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

### MCP kural attestation

Bridge, workspace kural dosyaları için redacted ve salt-okunur tek bir resource sunar:

- URI: `hades://rules/attestation/v1`
- Ad: `rule-attestation-v1`
- MIME türü: `application/json`
- Dosyalar: `AGENTS.md`, `CLAUDE.md`, `config/agent-rules.md`
- Hash sözleşmesi: değiştirilmemiş ham UTF-8 dosya byte'larının SHA-256 özeti

Manifest strict şema, sabit entry sırası, RFC 8785 canonicalization, dosya ve toplam boyut sınırları, descriptor okuması, link kontrolleri, UTF-8 doğrulaması, secret taraması ve TOCTOU kontrolleri uygular. Tool fallback yoktur. Resource desteklemeyen client `unsupported` kalır ve tool çağrılmaz.

Sonuç `sourceClass: "mcp_resource"` ile güvenilmeyen bir gözlemdir. `workspace_file` ve `mcp_resource` eşleşen snapshot bildirebilir; trusted host loader hook'u bulunana kadar `startup_context` `unavailable` kalır. Resource, host'un kuralları startup context'e enjekte ettiğini, modelin kurallara uyduğunu veya sonucun imzalı attestation olduğunu kanıtlamaz. Sözleşme ve uygulama [MCP kural attestation planında](docs/plans/yapilanlar/MCP_KURAL_DOGRULAMA_PLANI_2026-09-20.md) kayıtlıdır. `npm run smoke` resource listeleme, okuma ve strict manifest doğrulamasını çalıştırır.

### Kişisel yapılandırma

`configVersion: 2` şema doğrulamasından geçer; bilinmeyen veya eksik alan reddedilir. Provider’lar `defaultMode`/`allowedModes` ile sınırlıdır. `reliability.monthlyCostLimitUsd: 100` ve `warningThresholdPercent: 80` bilgilendirme referansıdır; admission-time bütçe uygulaması varsayılan olarak kapalıdır (`costBudgetEnforced: false`) ve açıkça etkinleştirilebilir. `npm run budget` gözlenen maliyeti, tahmini/rezerv maliyeti, çalıştırma sayılarını ve maliyet kapsama oranını ayrı gösterir; bilinmeyen maliyet `not_observable` olarak raporlanır ve asla sıfır sayılmaz. Uygulama etkinken limit, rezervasyon anında aktif rezervasyonlar ve kayıtlı harcamaya göre atomik kontrol edilir; süresi dolmuş rezervasyondan sonra gelen geç settlement yine sayılır ve aşım `dailyOverageUsd`/`monthlyOverageUsd` olarak raporlanır. Codex `allowNonGitWorkspace` yalnız kişisel machine config ile açılır; DeepSeek Git repository zorunluluğu olmadan denied-root ve Zod doğrulamasını korur.

### Kanonik yönlendirme

```text
Gemini Pro / Flash      → AntigravityAdapter → AGY (gemini-3.1-pro-high / gemini-3.8-flash-high)
Codex                   → CodexAdapter → official standalone codex.exe
Native Claude Code      → ClaudeCodeAdapter
DeepSeek V4 Pro / Flash → OpenCodeAdapter → deepseek/deepseek-v4-pro veya deepseek/deepseek-flash (DeepSeek-V4.1-Flash)
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
sol6_review             → GPT-6 Sol, read_only, 13, cache açık
luna6_review            → GPT-6 Luna, read_only, 13, cache açık
luna_implementation     → Codex Luna, edit, 12, cache kapalı, fallback yok
implementation          → Codex Terra, edit, 10, fallback: GLM 5.2 → DeepSeek Pro → Gemini Pro
glm_implementation      → GLM 5.2, edit, 8, fallback: DeepSeek Pro → Codex Terra → Gemini Pro
critical_implementation → Codex Sol, edit, 5, fallback: GLM 5.2 → DeepSeek Pro
sol6_implementation     → GPT-6 Sol, edit, 4, fallback: Codex Sol (5.6) → DeepSeek Pro
luna6_implementation    → GPT-6 Luna, edit, 11, fallback yok
```

Profiller `~/.config/subagent-bridge/config.json` içindeki `orchestration.taskProfiles` alanındadır.

```powershell
npm run config:apply-routing
npm run config:apply-agent-modes
```

Backup `~/.config/subagent-bridge/backups/` altında oluşturulur; rollback için `npm run config:rollback -- <backup>` veya `npm run config:rollback-agent-modes -- <backup>` kullanılır.

### Doğrulanmış sağlayıcı matrisi

Antigravity/Gemini Pro ve Flash, Codex ve DeepSeek V4 Pro/Flash doğrulanmıştır. GPT-6 Luna, GPT-6 Sol ve GPT-6 Astra doğrulanmış Codex kimlikleridir (canlı capability probe, 2026-09-22); Luna/Sol rollerinde GPT-6 sürümleri tercih edilir, GPT-5.6 karşılıkları uyumluluk profili olarak korunur. GLM aboneliği pasif olduğundan GLM model, profil ve fallback'leri çağrılmaz; Codex Luna hızlı fiyat/performans uygulayıcı, Terra dengeli edit, Sol zor hata ayıklama ve denetim modelidir. OpenCode bağımsız backend'i yapılandırmaya bağlıdır; Claude Code etkin abonelik gerektirir ve native Claude acceptance fazı bu kurulumda kapalıdır; Kimi/Qwen katalog girdisine bağlıdır.

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

Normal akış sandbox veya approval bypass içermez. Edit araçları disposable workspace’te yalnız seçili dosyaları hash kontrolü, secret taraması ve rollback destekli promotion ile uygular; test, build, script, paket yöneticisi ve mutasyon yapan shell komutları yasaktır. Yüksek etkili promotion, orkestratör saklanan prepared edit’i onaylayana kadar fail-closed kalır; çok dosyalı uygulama işlenen hatalarda geri alınır. Kesintiye uğramış promotion artifaktları manuel kurtarma tamamlanana kadar yeni uygulamaları engeller: hedef dizinlerdeki `.tmp` ve `.tmp.backup` artifaktlarını inceleyin, gerekiyorsa `.backup` dosyasını hedefinin üzerine geri taşıyın ve yeniden denemeden önce artifaktları kaldırın.

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

Güncel regresyon tabanı `npm test` ile doğrulanır; zamanlamaya duyarlı ağır doğrulamalar aynı makinede sıralı çalıştırılmalıdır.

### Bilinen engelleyici olmayan maddeler

Codex `%TMPDIR` isolation değerlendirmesi, yeniden üretilemeyen tarihsel AGY nested `ENOENT`, kapalı native Claude acceptance fazı (Claude Code aboneliği yok) ve bekleyen Faz 5 provider'ları engelleyici değildir.

### Doğrulanmış taban dondurma

Shared core yalnız confirmed production bug, yeni provider, security vulnerability, ölçülmüş concurrency defect veya contract-breaking upstream değişikliğiyle yeniden açılır.

## Model rolleri

Codex kapsamı ve mimariyi belirler, kodu ve testleri yürütür, sonuçları doğrular. DeepSeek analiz, ikinci görüş, araştırma ve planlama için yapılandırılmış sonuç verir; edit yalnız seçili dosyalardadır. Gemini Pro web araştırması ve dosya denetimi, Gemini Flash kısa araştırma içindir; ikinci görüş için DeepSeek veya Antigravity Claude Sonnet kullanılır, native Claude Code abonelik olmadan kapalı kalır.

## Güvenlik ayrımı

- Yerel analiz ve internet erişimi aynı subagent çağrısında birleşmez.
- `analyst`/`reviewer`/`planner` yalnız `Read`/`Glob`/`Grep`; `researcher` yalnız `WebSearch`/`WebFetch` kullanır.
- API anahtarları prompta, checkpoint’e veya kaynak koda yazılmaz.

## Skill’ler

Kanonik skill’ler `.agents/skills`, Claude uyumlu kopyalar `.claude/skills` altındadır: `commit-at`, `guvenlik-ve-sertlestirme`, `kod-denetleyicisi`, `otomatik-dokumantasyon`, `veri-seti-analizcisi`, `proje-kesif-planlama`, `model-saglayici-ekleme`, `dogrulama-kapisi`, `mcp-sozlesme-denetimi`, `hafiza-vault-bakimi`, `maliyet-ve-butce-denetimi`, `bagimlilik-guvenligi`. Eşitleme: `npm run skills:sync`. Global kurulum aynı klasörleri `~/.config/opencode/skills`, `~/.codex/skills`, `~/.claude/skills` ve `~/.agents/skills` altına kopyalar; `npm run verify` `.agents` ↔ `.claude` eşlemesini doğrular, global kopyalar elle kurulur ve bu kapının dışındadır. `npm run skills:check-global` dört global kopyayı kanonik `.agents` kaynağıyla karşılaştırır ve eşit, eksik ve farklı kökleri raporlar; `--strict` eksik kopyayı hata sayar. `proje-kesif-planlama` plan belgesini `codexLunaEdit` ile seçili tek dosyaya yazar ve değişiklik kümesinin o dosyada kaldığını doğrular.

## Kurulum

Gereksinimler: Node.js 20.9+ (22/24 önerilir), OpenCode CLI, Antigravity CLI, resmi standalone Codex CLI ve Git; DeepSeek için API anahtarı. İsteğe bağlı native Claude Code backend'i Claude Code aboneliği gerektirir ve abonelik yokken kapalı kalır.

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
npm run budget                Bilgilendirme amaçlı bütçe, gözlenen/tahmini maliyet ve kapsama görünümü
npm run p0:e2e                Trusted workspace portability kabulü
npm run p2b:e2e               Kişisel global entegrasyon kabulü
npm test                      Tüm Node.js regresyon testleri
npm run verify                Yerel executable, skill, config ve Vault doğrulaması
npm run verify:ci             Provider auth gerektirmeyen CI doğrulaması
npm run skills:check-global   Dört global skill kopyasını kanonik kaynakla karşılaştırır (--strict eksikte hata verir)
npm run metrics               Toplu redacted metric özeti
npm run metrics:prune         Retention dışı rotated metric temizliği
npm run runs:recent           Son çalışmaları salt-okunur gösterir
npm run runs:mirror -- ...    Proje-local mirror yaşam döngüsü
npm run edit:feedback         Direct-edit kullanıcı sonucu kaydı
npm run edit:classify         Append-only direct-edit uygunluk sınıflandırması (list|dispose|classify-legacy)
npm run routing:feedback      Task-profile kullanıcı sonucu kaydı
npm run routing:classify      Read-only routing kaydını geri bildirimden önce sınıflandırır
npm run hook:feedback         Redacted hafıza hook oturum sonucu kaydı
npm run hook:classify         Hafıza hook oturumunu geri bildirim öncesi sınıflandırma
npm run memory:review         Kalıcı hafıza yaşam döngüsü denetimi
npm run memory:doctor         Salt-okunur Vault sağlık, sürüm ve audit teşhisi
npm run memory:repair         Açık Vault onarımı (varsayılan dry-run, yazmak için --apply)
npm run state:migrate         Explicit runtime state migrasyonu (varsayılan dry-run)
npm run video:collect         Herkese açık YouTube altyazısını güvenilmeyen, hashlı zarf olarak toplar (--url=, opsiyonel --out=)
npm run hook:install          Opt-in salt-okunur hafıza hook'u üretir (--client=opencode|codex|claude)
npm run memory:evaluate       Retrieval kalite değerlendirmesi
npm run config:backup         Kişisel policy backup'ı
```

## Kalıcı sınırlar

DeepSeek yalnız `implementer` + `edit` modunda seçili dosyalara promotion uygular; Vault veya workspace dışına yazamaz. Codex doğrulamasız görevi tamamlanmış saymaz. Geri alınamaz işlem, üretim erişimi, dış sistemde yazma ve secret aktarımı insan onayı gerektirir.

## Kalıcı hafıza

`memory` klasöründeki Obsidian uyumlu yerel Vault, Git takibinin dışındadır. `check_persistent_memory`, `search_persistent_memory`, `read_persistent_memory`, `review_persistent_memory`, `analyze_memory_write`, `store_persistent_memory` ve `promote_memory` güvenli erişim, taslak ve SHA-256 kontrollü yayını yönetir. DeepSeek Vault’a erişemez ve belleğe yazamaz.

Yazma hattı secret benzeri, PII biçimli ve prompt injection içeren metni yazımdan önce reddeder; PII tespiti ulusal kimlik, IBAN ve ödeme kartı için checksum doğrulamalıdır. Not `relativePath` değeri de PII, injection işaretleri ve kesin secret imzaları açısından taranır; yüksek entropi sezgisi yol dışı içerikle sınırlıdır. `store_persistent_memory` injection işaretli içeriği yalnız `acknowledgeInjectionRisk: true` ile saklar ve deneme redacted `QUARANTINE` audit olayı olarak kaydedilir. `analyze_memory_write` `coverage` bloğu (indekslenen dosya, indeks üst sınırı, kırpma), idempotent `promote_memory` ise `auditWritten` ve `recoveryRequired` kanıt alanları döndürür.

`npm run memory:doctor` frontmatter, soft-expiry, karantina, hash bütünlüğü, şema sürümü ve audit yarış bulgularını salt-okunur raporlar; hiçbir notu silmez, taşımaz, birleştirmez veya onarmaz. Vault ve runtime state açık şema sürümleri taşır; uyumsuz state başlangıçta fail-closed olur ve `npm run state:migrate` gerektirir.

İsteğe bağlı hook, istemci oturumuna en fazla beş salt-okunur Vault alıntısı (1200 karakter) ekler. Asla yazmaz veya yayınlamaz; taslak, süresi dolmuş ve karantina notlarını dışlar; hafıza erişilemezse sessiz kalır. Tüketim profilleri (`normal`, `economic`, `manual`) yalnız otomasyon parametrelerini değiştirir; secret taraması, path/symlink koruması, SHA-256 kilidi, şema doğrulaması, karantina ve yazma izinleri değişmez. İstemci bazında kurulum: `npm run hook:install -- --client=opencode` (`--apply` ekle), `--client=codex` (`~/.codex/hooks.json`, `/hooks` güven incelemesi gerekir) veya `--client=claude` (`settings.json` snippet'ini yazdırır; elle birleştir). OpenCode plugin'i ayrıca `SUBAGENT_SECOND_BRAIN_HOOK=1` gerektirir.

`npm run video:collect -- --url=<watch-adresi> [--out=<dosya>]` herkese açık bir YouTube videosu için yalnız altyazı ve oEmbed künyesini yerel `yt-dlp` ile indirir, video kimliğini doğrular, 2 MB altyazı ve 400 bin karakter transcript sınırlarını uygular ve hashlı `untrusted_video_transcript` zarfını yazdırır. Antigravity salt-okunur çağrıları ayrıca JSON carrier'ı `--json-schema` ile zorlar ve doğrulama düştüğünde tek denemelik sınırlı carrier onarımına izin verir. İç içe JSON carrier zarfları en fazla iki derinlikte çözülür; dış katman boşken iç `webEvidence` korunur ve geçersiz kanıt strict şemada reddedilir.

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

Bu dokümanlar tarihsel planlardır. Denetlenen her planın başında tarihli durum notu bulunur; güncel doğrulama, plan oluşturma anındaki sabit test veya araç sayıları yerine `npm test` ve CI ile yapılır.

## Sürekli entegrasyon

`.github/workflows/validate.yml`, Windows ve Linux üzerinde Node 22/24 ile `npm ci`, `npm test` ve `npm run verify:ci` çalıştırır. `verify:ci` yerel executable, provider auth veya Vault gerektirmez. Kişisel policy değişikliğinden önce `npm run config:backup`, geri alma için `npm run config:rollback -- <backup>` kullanılır.

## Teşekkür

Mimari yaklaşım [Avenox](https://avenox.lol/) projeleri ve [github.com/avenoxai](https://github.com/avenoxai) depolarından ilham alır.

## Lisans ve katkı

- Lisans: [Apache-2.0](LICENSE)
- Güvenlik açığı bildirimi: [SECURITY.md](SECURITY.md)
- Katkı rehberi: [CONTRIBUTING.md](CONTRIBUTING.md)
