# Hades Orchestrator

Hades Orchestrator, OpenCode host, Codex ve diğer ana modellerin yerel MCP üzerinden bağımsız subagent backend'leri çağırmasını sağlayan provider-neutral bir orkestrasyon sistemidir. İç yürütme bileşeni `subagent-bridge` olarak adlandırılır. Host veya orchestrator modeli ile subagent backend'i aynı kavram değildir.

## Ne sunar

- Provider-neutral MCP köprüsü: OpenCode host ve ana orkestratör modeli; DeepSeek V4 Pro/Flash, GLM 5.2/5.3 (HighSpeed/Flash dahil), Codex Luna/Terra/Sol ve GPT-6 Astra, Gemini Pro/Flash (Antigravity) ve native Claude Code backend'lerini tek MCP yüzeyinden çağırır.
- Salt-okunur sandbox ve izole izin profili: read-only çağrılar provider başlamadan doğrulanır; örneğin Antigravity ortamında harici MCP sunucusu veya kalıtsal geniş izin varsa fail-closed reddedilir.
- Kontrollü edit: yalnız seçilmiş dosyalar disposable workspace içinde düzenlenir; source hash eşzamanlılık kontrolü, secret taraması ve rollback destekli promotion uygulanır.
- Model yetki ve erişim modu politikası: `defaultMode` ve `allowedModes` fail-closed çalışır; istenmeyen modda provider process'i başlatılmaz.
- Bütçe ve retry yönetimi: günlük/aylık maliyet limitleri atomik rezervasyonla uygulanır; yalnız geçici hatalar retry edilir, kalıcı hatalar fail-fast döner.
- Kalıcı hafıza katmanı: secret korumalı, kaynaklandırılmış ve denetlenebilir Obsidian tabanlı bellek entegrasyonu.
- Gözlemlenebilirlik: redacted metrikler, süreçler arası kilitler, circuit breaker ve isteğe bağlı proje mirror'ı.

## İçindekiler

- [Güncel durum](#güncel-durum)
- [Hızlı başlangıç](#hızlı-başlangıç)
- [Kullanım](#kullanım)
- [Verified baseline](#verified-baseline)
- [Model rolleri](#model-rolleri)
- [Güvenlik ayrımı](#güvenlik-ayrımı)
- [Gereksinimler](#gereksinimler)
- [Kurulum](#kurulum)
- [Başlatma](#başlatma)
- [Komut referansı](#komut-referansı)
- [Kalıcı hafıza](#kalıcı-hafıza)
- [Güvenilirlik ve metrikler](#güvenilirlik-ve-metrikler)
- [Architecture documents](#architecture-documents)
- [Continuous integration](#continuous-integration)
- [Lisans ve katkı](#lisans-ve-katkı)

## Kullanım

Köprü, MCP üzerinden salt-okunur ve kontrollü edit araçları sunar:

- Çalışma zamanı policy'si `~/.config/subagent-bridge/config.json` ve `~/.config/subagent-bridge/agents.json` dosyalarından yüklenir; `ORCHESTRATOR_CONFIG` ve `SUBAGENT_BRIDGE_AGENTS_CONFIG` ortam değişkenleri bu konumları değiştirir. Repo içindeki `config/policy.json` ve `config/agents.json` dağıtım şablonudur.
- Host tarafı MCP tanımı için `opencode.jsonc.example` dosyasını kendi konfigürasyonunuza uyarlayın; server `subagent-bridge/src/server.js` ve `SUBAGENT_BRIDGE_TRUSTED_WORKSPACE` başlangıç context'i ile başlatılır.
- Salt-okunur görev: `subagent-bridge_deepseekPro`, `subagent-bridge_glm52`, `subagent-bridge_codex`, `subagent-bridge_geminiFlash` gibi global araçlarla tek mesajda uzman modele görev verin; izinli kök içinde isteğe bağlı `workspace` kabul edilir.
- Kontrollü edit: yalnız seçili dosyalar ve kabul kriterleriyle; doğrudan workspace yazma yetkisi verilmez. Örnek: `subagent-bridge_glm52Edit`, `subagent-bridge_codexSolEdit`, `subagent-bridge_codexAstraEdit` veya `run_task_profile` üzerinden tanımlı edit profilleri.
- Doğrulama ve izleme: `npm test`, `npm run verify:ci`, `npm run budget` ve `npm run metrics` komutlarıyla.

## Güncel durum

- Paket: `hades-orchestrator@2.1.0`
- Çalışma zamanı: Node.js 20.9 veya üzeri, ESM; CI Node.js 22 ve 24 kullanır
- Ana orkestratör ve uygulayıcı: OpenCode oturumunda aktif kullanılan model
- Varsayılan salt-okunur uzman yolları: DeepSeek V4 Pro/Flash, GLM 5.2, Gemini Pro/Flash ve native Claude Code
- Canonical operasyon kaydı: `%LOCALAPPDATA%\subagent-bridge\logs\metrics`; GLM yürütmeleri redacted `glm-runs.jsonl` altında ayrılır
- İsteğe bağlı proje görünümü: `<workspace>/.hades/runs.jsonl`
- Güncel izole regresyon sonucu: `304/304 PASS`
- Son doğrulama: `npm run verify`, `npm run verify:ci` ve `npm run smoke` başarılı

## Hızlı başlangıç

```powershell
& "%NVM_HOME%\nodejs\npm.cmd" ci
& "%NVM_HOME%\nodejs\npm.cmd" test
& "%NVM_HOME%\nodejs\npm.cmd" run verify
& "%NVM_HOME%\nodejs\npm.cmd" run smoke
& "%NVM_HOME%\nodejs\npm.cmd" run runs:recent
```

Günlük OpenCode kullanımı kişisel global entegrasyon üzerinden yürütülür. Repository-local MCP akışı geliştirme, smoke testi ve doğrudan proje kabulü için korunur. Provider kimlik bilgileri repository içinde tutulmaz.

## Verified baseline

Bu bölüm, final multi-agent acceptance sonrasında dondurulan canonical doğrulama kaynağıdır.

```text
OpenCode Host
│
└─ @orchestrator
      ↓
   local MCP
      ↓
subagent-bridge
│
├─ MCP Frontend
│    └─ trusted host workspace injection
│
├─ Bridge Runtime
│    └─ canonical router, capability, lock, retry, cancellation
│
├─ AntigravityAdapter
│    └─ AGY
│        ├─ Gemini Pro
│        ├─ Gemini Flash
│        └─ Claude Sonnet via Antigravity
│
├─ ClaudeCodeAdapter
│    └─ native Claude Code
│
├─ OpenCodeAdapter
│    ├─ DeepSeek V4 Pro
│    ├─ DeepSeek V4 Flash
│    ├─ GLM 5.2
│    ├─ GLM 5.2 HighSpeed
│    └─ independent explicitly configured OpenCode provider/model
│
├─ CodexAdapter
│    └─ official OpenAI Codex CLI
│
└─ Observability
     ├─ global canonical redacted metrics
     └─ opt-in project-local .hades mirror
```

Canonical invariant:

```text
HOST / ORCHESTRATOR MODEL != SUBAGENT BACKEND

PACKAGE LOCATION != ACTIVE WORKSPACE
```

Aktif workspace bridge package konumundan, config dosyasından veya runtime process CWD'sinden türetilmez. Mevcut MCP frontend'i explicit `SUBAGENT_BRIDGE_TRUSTED_WORKSPACE` başlangıç context'ini canonicalize ederek `createBridgeRuntime()` çağrılarına bridge-owned metadata olarak enjekte eder. Antigravity read-only çağrıları, machine-owned allowed roots içinde doğrulanmış isteğe bağlı `workspace` kabul eder; diğer public araçlar `workspace`, `cwd`, `worktree`, `projectRoot`, executable, exec args, sandbox, delegation depth, execution ID, caller ve state path alanlarını kabul etmez.

OpenCode 1.18 P2A global custom-tool spike'i `~/.config/opencode/tools/subagent-bridge.js` altında read-only Gemini Pro/Flash, Antigravity Claude Sonnet, Codex, native Claude Code, DeepSeek Pro/Flash ve GLM 5.2/HighSpeed araçlarını doğrulamıştır. Git workspace için doğrulanmış `context.worktree`, Git olmayan workspace için doğrulanmış `context.directory` runtime'a trusted metadata olarak aktarılır. Her global araç, allowed roots içinde doğrulanmış isteğe bağlı bir `workspace` kabul eder. P2A source repository importuna bağlıdır; dağıtılabilir global kurulum değildir.

P2B kişisel global entegrasyonu canonical bridge source'u `<repo-root>`, trusted machine config'i `~/.config/subagent-bridge` ve runtime state'i `%LOCALAPPDATA%\subagent-bridge` altında sabitler. Günlük OpenCode kullanımı project-local MCP tanımına bağlı değildir. Global Gemini araçları `subagent-bridge_geminiFlash` ve `subagent-bridge_geminiFlash38` ile varsayılan veya explicit 3.8 Flash çağrısı, `subagent-bridge_geminiFlash37` ile explicit 3.7 Flash çağrısı sunar. Global tools tüm yapılandırılmış sağlayıcılar için read-only delegation, health ve workspace diagnostic yüzeyini açar. Codex Luna, Terra ve Sol ile GLM 5.2, 5.3 ve 5.3 Flash için global edit araçları (`subagent-bridge_codexLunaEdit`/`codexTerraEdit`/`codexSolEdit`, `subagent-bridge_glm52Edit`/`glm53Edit`/`glm53FlashEdit`) ve edit task profile aracı yalnız seçilmiş dosyalar ve kabul kriterleriyle controlled-edit akışına yönlenir; doğrudan workspace yazma yetkisi vermez. GPT-6 Astra `subagent-bridge_codexAstra` read-only ve `subagent-bridge_codexAstraEdit` controlled-edit araçları ile `astra_review`/`astra_implementation` profillerinden opt-in kullanılır; Sol ve GLM 5.2 fallback zinciri tanımlıdır.

### Personal Configuration

Çalışma zamanı policy'si `~/.config/subagent-bridge/config.json`, executable ve adapter ayarları `~/.config/subagent-bridge/agents.json` dosyasından yüklenir. İsteğe bağlı `ORCHESTRATOR_CONFIG` ve `SUBAGENT_BRIDGE_AGENTS_CONFIG` ortam değişkenleri bu konumları değiştirir. Repository içindeki `config/policy.json` ve `config/agents.json` dağıtım şablonudur; agent-yazılabilir workspace içinden runtime policy veya executable ayarı okunmaz. Command interpreter (`cmd`, PowerShell, sh veya bash) executable olarak reddedilir.

Policy `configVersion: 2` ile şema doğrulamasından geçer. Version 1 policy deterministik olarak çalışma belleğinde version 2'ye migrate edilir; yeni veya düzenlenmiş policy dosyalarında version 2 kullanılmalıdır. Bilinmeyen alan, eksik alan ve desteklenmeyen version fail-closed reddedilir.

Her provider, `agents.json` içinde `defaultMode` ve `allowedModes` ile merkezi olarak sınırlandırılır. Runtime, istenen `accessMode` izin listesinde değilse provider process'ini başlatmadan `mode_not_allowed` döndürür. Legacy `mode: read_only` yalnız read-only iznine, legacy `mode: edit` ise read-only ve edit izinlerine deterministik olarak çevrilir. Dağıtım ve aktif kişisel policy'de Claude Code yalnız read-only; Codex, Antigravity ve OpenCode/DeepSeek read-only ve edit olarak yapılandırılmıştır.

`reliability.maxRetryCostUsd` yalnız retry denemelerinin toplu maliyet rezervini sınırlar. Dağıtım policy'sinde `monthlyCostLimitUsd: 50` ve `warningThresholdPercent: 80` tanımlıdır; günlük limit yapılandırılmamıştır. Bridge rezervasyon günlüğü üzerinde süreçler arası kilitle hard cap uygular; limit aşılırsa yeni çalışmayı provider başlamadan reddeder ve redacted hata metriğinde ilgili dönem, limit, harcama ve kalan kotayı döndürür. `npm run budget` anlık kullanım, kalan tutar ve uyarı durumunu gösterir. Bu sınır bridge seviyesindedir; provider billing hesabındaki dış harcamaları kapsamaz.

Personal machine config, non-Git trusted workspace'lerde Codex için `allowNonGitWorkspace` politikasını açar. `--skip-git-repo-check` yalnız bu machine-owned alan açıkken ve selected workspace'te `.git` yokken eklenir; read-only sandbox korunur. Kullanıcı named provider verification istediğinde provider failure host self-review ile sessizce ikame edilmez.

MCP `run_deepseek_subagent` public `workspace` alanını P0 compatibility amacıyla korur; execution workspace seçimi için bu alan kullanılmaz. Global `subagent-bridge_deepseekPro` ve `subagent-bridge_deepseekFlash` araçları allowed roots içindeki isteğe bağlı `workspace` ile çalışır. DeepSeek için Git repository zorunluluğu yoktur; denied-root ve Zod yapılandırılmış-çıktı doğrulaması korunur.

### Canonical routing

```text
Gemini Pro
→ AntigravityAdapter
→ AGY
→ gemini-3.1-pro-high

Gemini Flash
→ AntigravityAdapter
→ AGY
→ gemini-3.8-flash-high

Codex
→ CodexAdapter
→ official standalone codex.exe

Native Claude Code
→ ClaudeCodeAdapter

Independent OpenCode provider/model
→ OpenCodeAdapter

DeepSeek V4 Pro / Flash
→ OpenCodeAdapter
→ deepseek/deepseek-v4-pro veya deepseek/deepseek-v4-flash

GLM 5.2 / HighSpeed / 5.3
→ OpenCodeAdapter
→ zai-coding-plan/glm-5.2, zai-coding-plan/glm-5.2-highspeed, zai-coding-plan/glm-5.3 veya zai-coding-plan/glm-5.3-flash
```

Gemini hiçbir durumda `OpenCodeAdapter → google/gemini-*` yoluna yönlendirilmez. OpenCodeAdapter Gemini alias'larını ve `google/gemini-*` provider model kimliklerini fail-closed reddeder. OpenCodeAdapter'ın rolü yalnızca açıkça istenen bağımsız OpenCode provider/model execution'ıdır.

Her normalize edilmiş provider sonucu `requestedModel`, nullable `resolvedModel` ve `accessMode` taşır. `requestedModel` public alias veya explicit istektir; `resolvedModel` yalnız bridge mapping'i veya provider'ın yapısal çıktısıyla doğrulanabilen gerçek kimliktir. Codex provider default'u kesin model sayılmaz ve `resolvedModel: null` döner. DeepSeek read-only ve edit checkpoint sonuçları public alias'ı, çözülen tam modeli ve gerçek erişim modunu ayrı tutar; edit checkpoint'i prompt, diff, dosya yolu, workspace veya görev kimliği saklamaz. Health görünümü provider `modePolicy` ve `configuredModels` alanlarını aynı canonical config'ten üretir.

### Task profiles

`run_task_profile` seçili görevi sabit bir canonical route ile çalıştırır. Named-provider araçları hiçbir zaman provider değiştirmez. Read-only profillerde fallback tanımlı değildir. Edit profilleri yalnız policy'de açıkça listelenen `fallbackTargets` sırasını controlled-edit akışında kullanır; her hedef temiz disposable workspace, tek provider denemesi, secret fail-closed kontrolü ve doğrulanmış promotion sınırına tabidir.

```text
quick_read              → Codex Luna, read_only, öncelik 30, cache açık
low_cost_analysis       → DeepSeek V4 Flash, read_only, öncelik 25, cache açık
deep_analysis           → DeepSeek V4 Pro, read_only, öncelik 20, cache açık
glm_analysis            → GLM 5.2, read_only, öncelik 18, cache açık
low_cost_glm_highspeed  → GLM 5.2 HighSpeed, read_only, öncelik 22, cache açık
kimi_analysis           → Kimi K2.5 Instruct, read_only, öncelik 18, cache açık
qwen_analysis           → Qwen3 Coder 480B, read_only, öncelik 18, cache açık
web_research_fast       → Gemini Flash, read_only, öncelik 25, cache açık
web_research            → Gemini Pro, read_only, öncelik 20, cache açık
file_audit              → Gemini Pro, read_only, öncelik 20, cache açık
review                  → Codex Terra, read_only, öncelik 20, cache açık
critical_review         → Codex Sol, read_only, öncelik 15, cache açık
luna_implementation     → Codex Luna, edit, öncelik 12, cache kapalı
implementation          → Codex Terra, edit, öncelik 10, cache kapalı
glm_implementation      → GLM 5.2, edit, öncelik 8, cache kapalı
critical_implementation → Codex Sol, edit, öncelik 5, cache kapalı
```

Profile tanımları `~/.config/subagent-bridge/config.json` içindeki `orchestration.taskProfiles` alanındadır. Repository'deki `config/policy.json` dağıtım şablonudur. Profil modu runtime tarafından doğrulanır; örneğin `implementation` yalnız edit modunda çalışır. Read-only profiller fallback kullanmaz. `implementation` sırasıyla GLM 5.2, DeepSeek Pro ve Gemini Pro; `glm_implementation` sırasıyla DeepSeek Pro, Codex Terra ve Gemini Pro; `critical_implementation` sırasıyla GLM 5.2 ve DeepSeek Pro hedeflerini deneyebilir. `luna_implementation` fallback kullanmaz. Bu açık hedefler yalnız controlled-edit sınırları içinde kullanılabilir; doğrudan veya örtük edit yetkisi verilmez. GLM 5.2 `glm_analysis` ve `glm_implementation` profillerinde hem okuma hem yazma yetkisine sahiptir; yüksek maliyetli olduğu için seçici kullanılır. Görüntü girdisi task profile yüzeyinde desteklenmez; DeepSeek ve GLM'e görüntü görevi yönlendirilmez.

Dağıtım şablonundaki provider rol profillerini aktif kişisel config'e backup alarak uygulamak için:

```powershell
& "%NVM_HOME%\nodejs\npm.cmd" run config:apply-routing
```

Dağıtım şablonundaki provider mode policy'sini executable ve diğer kişisel ayarları koruyarak aktif `agents.json` dosyasına uygulamak için:

```powershell
& "%NVM_HOME%\nodejs\npm.cmd" run config:apply-agent-modes
```

Komut önce `~/.config/subagent-bridge/backups/agents-<timestamp>.json` oluşturur. Geri yükleme `npm run config:rollback-agent-modes -- agents-<timestamp>.json` ile yapılır.

### Verified provider matrix

```text
Antigravity / Gemini Pro      VERIFIED
Antigravity / Gemini Flash    VERIFIED
Codex                         VERIFIED
DeepSeek V4 Pro / Flash       VERIFIED
GLM 5.2                       VERIFIED
GLM 5.2 HighSpeed             BLOCKED / SUBSCRIPTION ENTITLEMENT REQUIRED
OpenCode independent backend  IMPLEMENTED / CONFIGURED BACKEND'E BAĞLI
Claude Code                   IMPLEMENTED / PROVIDER AUTH-DEPENDENT
Kimi                          INTEGRATED / OPENCODE CATALOG ENTRY REQUIRED
Qwen                          INTEGRATED / OPENCODE CATALOG ENTRY REQUIRED
Hermes                        WSL INSTALL DISCOVERED / ISOLATED PROFILE PENDING
```

Native Claude Code executable ve adapter wiring doğrulanmıştır; mevcut health durumunda auth geçerli olmadığı için native Claude provider VERIFIED olarak işaretlenmez. Antigravity üzerinden Claude Sonnet ve native Claude Code birbirinden ayrı execution yollarıdır.

### Antigravity contract

Canonical executable:

```text
C:\Users\ornek\AppData\Local\agy\bin\agy.exe
```

Health ve execute aynı adapter-local resolver'ı kullanır. `supportsModelSelection = true` durumundadır ve model alias eşlemesi şöyledir:

```text
gemini_pro        → gemini-3.1-pro-high
gemini_flash      → gemini-3.8-flash-high
gemini_flash_3_7  → gemini-3.7-flash-high
gemini_flash_3_8  → gemini-3.8-flash-high
claude_sonnet     → claude-sonnet-4-6
```

Read-only enforcement sandbox açıkken çalışma alanını `--add-dir` ile görünür kılar. `--add-dir` tek başına çalışma alanının yazılabilir olduğu anlamına gelmez. Geçici permission policy şu sınırları korur:

```text
deny write_file(*)
no command(*)
```

Read-only çağrıdan önce `agy mcp list` sonucu tam olarak `No MCP servers configured.` olmalıdır. Harici MCP sunucusu veya dar allowlist dışında kalıtsal bir izin bulunduğunda provider başlatılmadan fail-closed reddedilir. Bu koşulda AGY'nin yerleşik salt-okunur inceleme yolu kullanılabilir.

Dar komut allowlist'i:

```text
git status
git diff
git log
git show
git ls-files
git rev-parse
rg
Get-ChildItem
Get-Location
dir
pwd
ls
pwd; ls
```

Filesystem-backed adversarial kabul proplarında separator mutation, redirection mutation, pipeline mutation, `write_file`, mutating Git komutları ve network probe engellenmiştir.

AGY yardım yüzeyi execution başına ayrı settings dosyası seçeneği sunmadığından geçici read-only settings yaşam döngüsü mutex ve süreçler arası owner PID lock ile serileştirilir. Canlı lock yalnız dosya yaşı nedeniyle stale sayılmaz. Execute başlangıcı, aktif lock yoksa önceki çökmüş çalışmadan kalan sentinel'i kurtarır; read-only lock alındıktan sonra recovery yeniden doğrulanır. Normal akış `finally` içinde orijinal byte içeriğine döner. Success restore, failure restore, canlı eski lock ve concurrent safety propları geçmiştir.

`executable_missing` yalnız gerçek process spawn hatasından, örneğin `error.code === "ENOENT"`, üretilebilir. Provider stdout veya stderr içindeki `ENOENT` ya da `executable not found` metni AGY executable'ının eksik olduğu anlamına gelmez; nested provider/runtime hatası `non_zero_exit` eşdeğerine normalize edilir. Tarihsel yanlış sınıflandırma düzeltilmiştir.

### Codex contract

Canonical kurulum ve executable:

```text
codex-cli (resmi standalone Windows build; PATH üzerinden `codex`)
ChatGPT login: valid
```

Doğrulanmış paket bileşenleri:

```text
codex.exe
codex-code-mode-host.exe
rg.exe
codex-command-runner.exe
codex-windows-sandbox-setup.exe
```

Execution contract:

```text
read_only  → codex exec --sandbox read-only
edit       → codex exec --sandbox workspace-write
```

Normal execution path `danger-full-access`, sandbox bypass veya approval bypass içermez. Provider default modelinde `--model` tamamen omit edilir; `--model default` kullanılmaz.

Global `subagent-bridge_codexLunaEdit`, `subagent-bridge_codexTerraEdit` ve `subagent-bridge_codexSolEdit` araçları ile edit task profile çağrıları bridge-owned disposable workspace içinde çalışır. Yalnız seçilmiş dosyalar promotion için değerlendirilir; source hash eşzamanlılık kontrolü, secret taraması ve rollback destekli promotion uygulanır. Codex edit process'i pytest cache ve Python bytecode üretmeyecek ortamla başlatılır. Prompt sözleşmesi seçilmiş dosyalar ile salt-okunur bağlam dosyalarının incelenmesine izin verir; test, build, script, paket yöneticisi ve dosya mutasyonu yapan shell komutlarını yasaklar. Disposable workspace her sonuçta temizlenir.

Gerçek kabul propları:

```text
No-tool inference              PASS
File/tool-backed read          PASS
Read-only normal               PASS
Read-only write                BLOCKED
Prompt-injection write         BLOCKED
Edit create                    PASS
Existing file edit             PASS
Desktop sibling outside write  DENIED
User .ssh read probe           DENIED
Cancellation                   PASS
Timeout                        PASS
Process cleanup                PASS
```

`workspace-write`, Windows runtime davranışı olarak `%TMPDIR` writable root'una erişebilir. Desktop sibling write reddedilmiş ve arbitrary user filesystem write gözlenmemiştir. Bu davranış keyfi filesystem erişimi olarak tanımlanmaz.

`CODEX-TD-01`, gelecekte `TEMP` ve `TMP` değişkenlerini bridge-owned per-execution dizine yönlendirip execution sonunda temizlemeyi değerlendiren hardening kaydıdır. Mevcut verified baseline için gerekli değildir.

### Shared invariants

Delegation sınırı:

```text
MAX_DELEGATION_DEPTH = 1
Host → subagent                         ALLOWED
subagent → bridge → another subagent   DENIED
```

Orchestrator recursive delegation yapmaz. Bir provider timeout verdikten sonra kullanıcı açıkça retry istemedikçe aynı provider farklı `timeout_seconds` ile yeniden çağrılmaz; timeout doğrudan synthesis'e taşınır. Bu orchestrator politikası bridge-level retry semantiğinden ayrıdır.

Retry contract:

```text
read_only transient error
→ shared RetryService ve maxRetries sınırında retry

edit timeout/process_exit/network
→ automatic retry prohibited
→ mutation_state_unknown
```

Workspace lock anahtarı canonical workspace'in SHA-256 değeridir; backend adı lock key'e dahil değildir. Runtime state cache dizininde dosya tabanlı reader/writer lock tutulur. Aynı workspace'te read işleri paralel çalışır, edit işi read ve write işlerini dışlar. Farklı bridge süreçleri aynı lock alanını kullandığında işlemler öncelik sırasıyla kuyruğa alınır. Aktif lock sahibi owner token ile `orchestration.scheduler.leaseHeartbeatMs` aralığında lease'i yeniler; stale lock temizliği yalnız heartbeat'i durmuş lock'lar için `staleLockMs` sonrasında uygulanır.

Cache yalnız profile ait read-only başarı sonuçları için etkindir. Anahtar canonical workspace hash'i, Git `HEAD`, backend, model, profile ve prompt hash'iyle türetilir. Git revision bulunamazsa, edit çağrılarında veya TTL/entry boyutu sınırı aşıldığında cache kullanılmaz.

Timeout ve output limit süreç ağacı için `killProcessTree(pid)` uygular. Explicit cancel execution handle'a bağlı child PID için process tree termination uygular ve ardından `AbortController.abort()` akışını tamamlar. Process-tree testi descendant PID'nin sonlandığını doğrular. Final acceptance sonunda test-created AGY, Codex, `codex-code-mode-host` veya command runner orphan gözlenmemiştir.

### Final acceptance evidence

```text
OpenCode Host
→ @orchestrator

Call 1:
run_antigravity_subagent
→ Gemini Pro
→ real file-backed result

Call 2:
run_codex_subagent
→ Codex
→ real file-backed result

→ independent normalized results
→ orchestrator synthesis
```

Observed evidence:

```text
Gemini calls                   1
Codex calls                    1
timeout overrides              0
orchestrator provider retries  0
fallback                       0
repository mutation            0
orphan processes               0
AGY settings restored          YES
stale sentinel                 NO
total host duration            332.668s
```

Duration yalnız bilgilendirme amaçlıdır ve performans hedefi değildir.

### Test baseline

```text
Acceptance run 1  143/143 PASS
Acceptance run 2  143/143 PASS
Acceptance run 3  143/143 PASS
npm run verify   PASS
npm run smoke    PASS
```

Bu dondurulmuş acceptance kanıtından sonraki güncel regresyon baseline'ı 2026-08-12 tarihinde `264/264 PASS` olarak doğrulanmıştır. `npm run verify`, `npm run verify:ci` ve `npm run smoke` aynı uygulama durumu üzerinde geçmiştir. Süreçler arası lock ve lease testleri zamanlamaya duyarlı olduğundan ağır doğrulama komutları aynı makinede paralel değil sıralı çalıştırılmalıdır.

### Known non-blocking items

1. Codex `%TMPDIR` writable-root davranışı için gelecekte per-execution TEMP isolation değerlendirilebilir.
2. Tarihsel nested AGY provider `ENOENT` hedefi belirlenememiştir; classifier düzeltilmiş, sorun yeniden üretilememiştir ve yalnız tekrar ederse incelenecektir.
3. Native Claude gerçek provider acceptance mevcut authentication durumuna bağlıdır.
4. Faz 5 provider'ları bilinçli olarak beklemededir.

### Verified baseline freeze

- Concrete requirement olmadan shared core refactor edilmez.
- Yeni acceptance testi olmadan provider routing değiştirilmez.
- Convenience amacıyla read-only permission kapsamı genişletilmez.
- Filesystem-backed security propları olmadan sandbox davranışı değiştirilmez.
- Health ve real execution doğrulaması olmadan executable path değiştirilmez.
- Tek bir provider çalışması yavaş diye timeout veya retry davranışı değiştirilmez.
- Mock veya unit test tek başına provider'ı VERIFIED yapmak için yeterli değildir.

Core yalnız confirmed production bug, gerçekten generic abstraction gerektiren yeni provider, security vulnerability, ölçülmüş concurrency/cancellation defect veya contract-breaking upstream CLI değişikliği oluşursa yeniden açılır. Spekülatif cleanup yeterli neden değildir.

## Codex liderliğindeki DeepSeek danışmanlık yolu

```text
Kullanıcı hedefi
        ↓
Codex GPT-5.6 Sol ve medium reasoning
        ↓
Plan, görev sözleşmesi ve delegasyon kararı
        ↓
run_deepseek_subagent MCP aracı
        ↓
DeepSeek V4 Pro veya V4 Flash read-only analiz ya da kontrollü edit
        ↓
Codex doğrulaması ve test
        ↓
Checkpoint ve nihai sonuç
```

## Model rolleri

Codex:

- Kullanıcı niyetini ve proje kapsamını belirler.
- Mimari ve uygulama kararlarını verir.
- Kod oluşturur ve değiştirir.
- Testleri ve doğrulamaları çalıştırır.
- DeepSeek bulgularını bağımsız doğrular.
- Tamamlanma kararını verir.

DeepSeek:

- Geniş kod tabanı analizi yapar.
- İkinci görüş ve alternatif yaklaşım sunar.
- Araştırma, inceleme ve planlama görevlerini yürütür.
- Kanıta dayalı yapılandırılmış sonuç döndürür.
- `implementer` ve `edit` modunda yalnız seçilmiş hedef dosyalar için disposable değişiklik ve kontrollü promotion üretir.
- Kabuk komutu çalıştırmaz, context veya listelenmemiş dosyayı değiştiremez ve commit oluşturmaz.
- Başka bir ajan çağırmaz.

Diğer uzman backend'ler:

- Gemini Pro web araştırması, dosya denetimi ve geniş salt-okunur analiz için kullanılır.
- Gemini Flash kısa ve düşük maliyetli salt-okunur araştırma için kullanılır.
- Native Claude Code bağımsız ikinci görüş veya Claude'a özgü inceleme için kullanılır; kullanılabilirlik provider auth durumuna bağlıdır.
- Named-provider çağrıları başarısız olduğunda başka provider sonucu aynı çağrının sonucuymuş gibi sunulmaz.

`run_deepseek_subagent` içindeki `model` alanı varsayılan olarak `deepseek_pro` değerindedir. `deepseek_flash`, kısa ve düşük maliyetli işler için seçilebilir. `mode` varsayılan olarak `read_only` değerindedir; `edit` yalnız implementer rolü, seçilmiş hedef dosyalar ve kontrollü promotion sözleşmesiyle çalışır.

`run_deepseek_edit_pilot`, seçilmiş dosyaları bridge-owned disposable workspace'e kopyalar ve DeepSeek edit agent'ını yalnız bu geçici alanda çalıştırır. Ana workspace değişmez; sonuç değişen göreli dosya yollarını ve unified diff'i döndürür. Path traversal, link, hassas dosya, binary, boyut ve secret-benzeri çıktı kontrolleri fail-closed uygulanır. Geçici alan her sonuçta temizlenir.

Production `run_deepseek_subagent` varsayılan olarak `read_only` kalır. `mode: edit` yalnız `role: implementer` ve en az bir seçilmiş `files` hedefiyle kabul edilir. DeepSeek disposable kopyayı düzenler; bridge context veya listelenmemiş dosya mutasyonunu reddeder, source concurrency kontrolünü yapar ve doğrulanmış hedefleri rollback destekli promotion ile trusted workspace'e uygular. Edit çağrısı tek provider denemesi kullanır ve belirsiz mutation durumunda otomatik retry yapmaz.

`run_glm_subagent`, GLM 5.2 ve HighSpeed için aynı `read_only/edit` sözleşmesini kullanır. Edit, yalnız `role: implementer`, seçilmiş hedef dosyalar ve disposable workspace içindeki `glm-edit` agent üzerinden kontrollü promotion ile uygulanır.

GLM read-only sonuçları DeepSeek ile aynı sıkı JSON sözleşmesiyle doğrulanır ve yalnız redacted checkpoint metadata'sı saklanır. `check_glm_subagent`, GLM model eşlemesini kontrol eder. `run_glm_edit_pilot`, seçilmiş dosyalarda disposable workspace diff'i üretir ancak ana workspace'e promotion yapmaz.

## Güvenlik ayrımı

Yerel repository analizi ile internet erişimi aynı subagent çağrısında birleştirilmez.

- `analyst`, `reviewer` ve `planner` rolleri yalnızca `Read`, `Glob` ve `Grep` araçlarını kullanır.
- `researcher` rolü yalnızca `WebSearch` ve `WebFetch` araçlarını kullanır; yerel dosya okuyamaz.
- Her rolün araçları `--allowedTools` ile önceden izinli hale getirilir ve `dontAsk` modunda diğer araçlar reddedilir.
- Claude Code proje MCP sunucularını yüklememesi için `--strict-mcp-config` ile çalışır.
- Oturum kaydı `--no-session-persistence` ile kapatılır.
- Her çağrı en fazla sekiz agent turuyla sınırlandırılır.
- API anahtarı prompta, checkpoint'e veya kaynak koduna yazılmaz.

## Başlangıç kuralları

Codex proje başında `AGENTS.md` dosyasını okur. DeepSeek çağrıları OpenCode plan modunda çalışır; seçilen skill içeriği dar görev promptuna eklenir. `CLAUDE.md`, native Claude Code doğrudan açılırsa rol sınırlarını koruyan ek güvenlik katmanıdır.

## Skill'ler

Kanonik skill dosyaları `.agents/skills` altında tutulur ve Codex tarafından keşfedilir. Claude uyumlu kopyalar `.claude/skills` altında bulunur.

- `commit-at`
- `guvenlik-ve-sertlestirme`
- `kod-denetleyicisi`
- `otomatik-dokumantasyon`
- `veri-seti-analizcisi`

DeepSeek aynı uzmanlık talimatına ihtiyaç duyduğunda Codex, `run_deepseek_subagent` çağrısındaki `skills` dizisine ilgili adı ekler. Bridge skill'in tam içeriğini prompta enjekte eder.

Skill kopyalarını eşitlemek için:

```powershell
& "%NVM_HOME%\nodejs\npm.cmd" run skills:sync
```

## Gereksinimler

- Node.js 20.9 veya üzeri; Node.js 22 veya 24 önerilir
- OpenCode CLI
- Antigravity CLI
- Official standalone Codex CLI
- Native Claude Code kullanımı için Claude Code CLI ve geçerli auth
- Git for Windows
- DeepSeek yolu kullanılacaksa DeepSeek API anahtarı

## Kurulum

Bağımlılıkları yükle:

```powershell
& "%NVM_HOME%\nodejs\npm.cmd" ci
```

Lockfile bilinçli olarak güncellenecekse geliştirme sırasında `npm install` kullanılabilir; normal kurulum ve CI için `npm ci` tercih edilir.

DeepSeek kullanıcı ortamını yapılandır:

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\configure-deepseek.ps1" -DeepSeekApiKey "<DEEPSEEK_API_KEY>"
```

Projeyi doğrula:

```powershell
& "%NVM_HOME%\nodejs\npm.cmd" test
& "%NVM_HOME%\nodejs\npm.cmd" run verify
& "%NVM_HOME%\nodejs\npm.cmd" run smoke
```

Yerel dosya içeriği göndermeyen sentetik DeepSeek çağrısını kontrollü pilotla doğrula:

```powershell
& "%NVM_HOME%\nodejs\npm.cmd" run pilot
```

## Başlatma

Günlük kullanımda OpenCode host ve `@orchestrator`, kişisel global tool entegrasyonu üzerinden canonical bridge source'a bağlanır. Git workspace'te `context.worktree`, Git olmayan workspace'te `context.directory` trusted workspace olarak doğrulanır.

Repository-local geliştirme akışında proje kökünde OpenCode başlatılabilir. `opencode.jsonc`, local stdio `subagent-bridge` MCP sunucusunu yükler. Bu yol kişisel global kurulumun yerine geçmez.

Codex liderliğindeki DeepSeek danışmanlık yolunu normal bir PowerShell veya Git Bash oturumunda başlatmak için:

```powershell
Set-Location -LiteralPath "<repo-root>"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\start-codex.ps1"
```

Başlatma betiği kullanıcı düzeyindeki DeepSeek ortam değişkenlerini mevcut sürece yükler ve Codex'i proje kökünde GPT-5.6 Sol ile başlatır. Codex proje güveni verildiğinde `.codex/config.toml` içindeki `deepseek-subagent` MCP sunucusunu yükler.

Codex içinde önce `check_deepseek_subagent` aracını çalıştır. Sonra dar ve salt okunur bir görev için `run_deepseek_subagent` aracını çağır.

## Komut referansı

Çalıştırma ve provider doğrulaması:

```text
npm start                  Local MCP stdio bridge'i başlatır
npm run pilot              DeepSeek Pro sentetik pilotunu çalıştırır
npm run pilot:flash        DeepSeek Flash sentetik pilotunu çalıştırır
npm run pilot:edit:deepseek DeepSeek Pro disposable edit pilotunu çalıştırır
npm run accept:edit:deepseek DeepSeek Pro kontrollü promotion kabulünü geçici workspace'te çalıştırır
npm run accept:edit:glm  GLM 5.2 kontrollü promotion kabulünü geçici workspace'te çalıştırır
npm run accept:read:glm  GLM 5.2 salt-okunur kabulünü geçici workspace'te çalıştırır
npm run pilot:edit:glm  GLM 5.2 disposable edit pilotunu ana workspace'i değiştirmeden çalıştırır
npm run smoke              MCP araç şeması ve runtime health smoke testi
npm run budget             Günlük ve aylık hard cap snapshot'ı
npm run p0:e2e             Trusted workspace portability kabulü
npm run p2a:e2e            OpenCode global custom-tool spike kabulü
npm run p2b:e2e            Kişisel global entegrasyon kabulü
```

Test ve doğrulama:

```text
npm test                   Tüm Node.js regresyon testleri
npm run verify             Yerel executable, skill, config ve Vault doğrulaması
npm run verify:ci          Provider auth gerektirmeyen CI doğrulaması
```

Gözlemlenebilirlik ve feedback:

```text
npm run metrics            Toplu redacted metric özeti
npm run metrics:prune      Retention dışındaki rotated metric dosyalarını temizler
npm run runs:recent        Son yapısal subagent çalışmalarını salt-okunur gösterir
npm run runs:mirror -- ... Proje-local mirror yaşam döngüsünü yönetir
npm run edit:feedback      Direct-edit kullanıcı sonucunu kaydeder
npm run routing:feedback   Task-profile kullanıcı sonucunu kaydeder
```

Hafıza, skill ve config bakımı:

```text
npm run memory:review      Kalıcı hafıza yaşam döngüsü denetimi
npm run memory:evaluate    Retrieval kalite değerlendirmesi
npm run memory:prune-audit Eski rotated hafıza audit dosyalarını temizler
npm run skills:sync        Canonical skill'leri Claude kopyalarıyla eşitler
npm run config:backup      Kişisel policy backup'ı oluşturur
npm run config:rollback -- <backup-file> Seçilen doğrulanmış backup'a döner
npm run config:apply-routing Provider rol profillerini backup alarak uygular
npm run config:apply-agent-modes Provider mode policy'sini backup alarak uygular
npm run config:rollback-agent-modes -- <backup-file> Seçilen agents backup'ına döner
```

## Delegasyon örneği

```text
Bu authentication hatasını önce kendin sınırlandır. Geniş kod yolu incelemesi yararlıysa DeepSeek'i reviewer rolünde salt okunur çağır. Bulgularını bağımsız doğrula, en küçük düzeltmeyi uygula ve testleri çalıştır.
```

## Kalıcı sınırlar

- DeepSeek yalnız `implementer` ve `edit` modunda seçilmiş dosyalara doğrulanmış promotion uygular.
- DeepSeek context, listelenmemiş dosya, Vault veya workspace dışına değişiklik uygulayamaz.
- Codex doğrulamadan görevi tamamlandı saymaz.
- Sandbox veya onay mekanizmasını devre dışı bırakan kalıcı seçenekler kullanılmaz.
- Geri alınamaz işlem, üretim erişimi, dış sistemde yazma ve secret aktarımı insan onayı gerektirir.

## Kalıcı hafıza

Proje, `memory` klasöründeki Obsidian uyumlu yerel Vault'u Codex kontrollü kalıcı hafıza olarak kullanır. Bu klasör proje içinde tutulur ve varsayılan olarak Git takibinin dışındadır. Vault her görevin başlangıcında bağlama yüklenmez. Codex yalnızca süreklilik yararlı olduğunda yerel arama yapar, ilgili notları seçer ve sınırlı içerik okur.

Hafıza araçları:

- `check_persistent_memory`: Vault erişimini ve güvenlik sınırlarını kontrol eder.
- `search_persistent_memory`: Markdown notlarını yerel olarak arar; secret içeren sonuçları engeller, injection şüphelilerini içeriksiz karantinaya ayırır ve güvenli sonuçları XML-escaped `UNTRUSTED_CONTENT` alıntıları olarak döndürür.
- `read_persistent_memory`: Seçilmiş tek bir notu boyut, yol, secret ve prompt injection doğrulamasıyla okur. Karantina varsayılan olarak fail-closed çalışır; açık onay yalnız sınırlı ve XML-escaped alıntı döndürür.
- `review_persistent_memory`: Vault'u değiştirmeden yaşam döngüsü, kaynak yaşı, güven, tür ve yinelenme sorunlarını raporlar.
- `analyze_memory_write`: Yeni notu yazmadan aynı gövdeli tekrarları ve aynı başlıklı olası çelişkileri salt-okunur analiz eder.
- `store_persistent_memory`: Doğrulanmış, kaynaklandırılmış ve secret içermeyen notu varsayılan olarak `00_Inbox` altında draft oluşturur.
- `promote_memory`: SHA-256 kontrollü Inbox taslağını çift süreç kilidi ve redacted audit ile yayın klasörüne taşır.

Yazma klasörleri `00_Inbox`, `01_Projects`, `02_Areas`, `03_Resources`, `04_Archive` ve `06_Metadata` ile sınırlıdır. Var olan bir notun güncellenmesi güncel SHA-256 değerini gerektirir. Path traversal, sembolik bağlantı, gizli dosya, izinsiz klasör, aşırı boyut ve secret benzeri içerik kontrolleri uygulanır.

Notlar `stage` alanında `draft` veya `published` değerini, ayrıca isteğe bağlı `memory_type`, `review_after` ve `valid_until` alanlarını taşır. Yeni not varsayılan olarak draft olur ve `00_Inbox` altında oluşturulmalıdır. Stage'siz eski notlar published kabul edilir; mevcut not güncellenirken stage korunur ve yalnız `promote_memory` stage değiştirebilir. Standart hafıza türleri `semantic`, `episodic`, `procedural`, `preference` ve `decision` değerleridir.

Salt-okunur yaşam döngüsü denetimi taslakları, geçersiz metadata'yı, inceleme tarihi geçmiş veya süresi dolmuş notları, eski kaynakları, düşük güvenli kayıtları, eksik hafıza türlerini, promotion yarışlarını ve konsolidasyon adaylarını listeler. Konsolidasyon tam gövde, başlık, etiket ve kelime-shingle bloklarıyla ölçülür; draft ve expired notlar aday havuzuna alınmaz. Denetim hiçbir notu otomatik silmez, taşımaz, birleştirmez veya güncellemez.

Draft notlar normal aramada gizlenir ve bakım aramasında `includeDrafts: true` ile alınır. `valid_until` tarihi geçmiş notlar soft-expiry ile gizlenir; tarihsel aramada `includeExpired: true` kullanılmalıdır. Geçmiş `validUntil` ile bilinçli kayıt için `acknowledgeExpiredMemory: true` gerekir.

Yeni not yazılmadan önce tekrar ve çelişki aday analizi yapılır. Aynı gövdeli veya aynı başlıklı adaylar varsa yeni kayıt varsayılan olarak reddedilir; Codex adayları inceledikten sonra `acknowledgeMemoryConflicts: true` ile bilinçli olarak devam edebilir. Sistem içerikleri otomatik birleştirmez veya eski notları otomatik geçersiz kılmaz.

Başarılı hafıza yazımları, promotion işlemleri, secret engellemeleri ve injection karantinaları `%LOCALAPPDATA%\subagent-bridge\logs\audit\memory-events.jsonl` içinde allowlist'li redacted olay olarak kaydedilir. Audit yalnız timestamp, hash ve sınıflandırma metadata'sı taşır; içerik, not yolu, görev kimliği, actor veya request ID saklamaz. Mutation tamamlandıktan sonra audit yazılamazsa sonuç `mutationCompleted: true` ve `auditWritten: false` olarak döner; mutation otomatik tekrarlanmaz. Döndürülmüş eski audit dosyaları `npm run memory:prune-audit` ile retention politikasına göre temizlenir.

Retrieval kalite regresyonu `npm run memory:evaluate` ile 25 vakalı, qrels dereceli ve secret içermeyen veri setinde ölçülür. Rapor standart `precision@k`, `recall@k`, MRR, NDCG, abstention, gecikme ve bağlam bütçesini içerir. Evaluator strategy injection destekler; semantik veya hibrit arama yalnız keyword baseline'a karşı ölçülmüş yarar gösterirse değerlendirilir.

Arama sıralaması path ve içerik anahtar kelime eşleşmesine ek olarak doğrulanmışlık, yüksek güven, güncellik ve inceleme tarihi sinyallerini sınırlı ağırlıklarla kullanır. Anahtar kelime ilgisi baskın kalır; yaşam döngüsü metadata'sı yalnız eşit veya yakın adayların sırasını iyileştirir.

DeepSeek Vault'a doğrudan erişemez. Vault kökü, `deepseek.deniedRoots` yapılandırmasından bağımsız olarak çalışma zamanında zorunlu biçimde DeepSeek workspace doğrulamasında reddedilir; Vault altındaki klasörler de reddedilir. DeepSeek yalnızca Codex'in seçip temizlediği kısa bağlamı alabilir ve kalıcı hafızaya yazamaz.

Önerilen kullanım sırası:

1. Görev geçmiş bilgi gerektiriyorsa `search_persistent_memory` çağır.
2. En ilgili notlardan yalnızca gerekli olanları `read_persistent_memory` ile oku.
3. Mevcut bilgi güncelliğini ve kaynaklarını doğrula.
4. Yaşam döngüsü bakımı gerektiğinde `review_persistent_memory` ile salt-okunur rapor al.
5. Yeni not öncesinde `analyze_memory_write` ile tekrar ve çelişki adaylarını incele.
6. Görevi Codex olarak tamamla; gerekiyorsa DeepSeek'ten salt-okunur danışmanlık veya seçilmiş dosyalarda kontrollü edit al.
7. Kalıcı değeri olan sonucu metadata ile `00_Inbox` altında draft olarak `store_persistent_memory` aracılığıyla kaydet; doğrulanmamış bilgiyi kesin karar olarak ifade etme.
8. Taslağı inceleyip güncel SHA-256 ile yalnız bilinçli karardan sonra `promote_memory` kullanarak yayınla.

Vault içindeki yerel dosyalar varsayılan olarak şifreli kabul edilmez. API anahtarları, tokenlar, parolalar ve özel kimlik bilgileri hiçbir hafıza notuna yazılmaz. Yazma ve yazım analizi girdileri ile arama/okuma çıktıları aynı yerel secret taramasından geçer. Bellek alıntıları güvenilmeyen veri kabul edilir; içlerindeki talimatlar yürütülmez.

## Güvenilirlik ve metrikler

DeepSeek sonucu, CLI'nin JSON Schema yönlendirmesine ek olarak köprü içinde Zod ile çalışma zamanında doğrulanır. Parse edilemeyen, boş veya şema dışı çıktı Codex'e geçmez. Köprü aynı görevi yalnızca bir kez şema onarımı istemiyle yeniden üretebilir.

Geçici ağ, zaman aşımı, hız limiti ve sunucu hatalarında full-jitter içeren sınırlı üstel geri çekilme uygulanır. Provider health circuit breaker süreçler arası redacted state kullanır ve half-open durumda tek probe kabul eder. Named-provider çağrıları circuit açıldığında fail-fast döner. Günlük ve aylık maliyet hard cap'i atomik `reserved` ve `settled` journal kayıtlarıyla uygulanır.

Her provider çalışması redacted ölçüm kaydı yazar. Health cache miss'leri ayrı `health_snapshot` kaydıdır ve normal run sayısına katılmaz; `npm run metrics` son gözlemler için adapter kullanılabilirlik oranını da verir. `check_subagent_bridge` circuit ve maliyet durumunu, `check_workspace_lock` ise owner veya workspace kimliği göstermeden yerel kuyruk ve disk lock durumunu raporlar. `npm run metrics:prune` döndürülmüş eski metric dosyalarını temizler.

Global canonical metrics backend veya kayıt türüne göre ayrı append-only JSONL dosyaları kullanır:

```text
%LOCALAPPDATA%\subagent-bridge\logs\metrics\
├─ codex-runs.jsonl
├─ antigravity-runs.jsonl
├─ opencode-runs.jsonl
├─ claude_code-runs.jsonl
├─ routing-evaluation-runs.jsonl
└─ direct-edit-baseline-runs.jsonl
```

Dosya boyut sınırına ulaşan global kayıtlar timestamp ve UUID içeren yeni ada rotate edilir. Global metrics bridge-owned canonical operasyon kaynağıdır; proje-local mirror canonical audit veya güvenlik kanıtı değildir.

Son çalışmaları içerik göstermeden incelemek için global metrics dosyalarını salt-okunur tarayan recent-runs görünümü kullanılabilir:

```powershell
& "%NVM_HOME%\nodejs\npm.cmd" run runs:recent
& "%NVM_HOME%\nodejs\npm.cmd" run runs:recent -- --days=14 --limit=50
```

Komut varsayılan olarak son 7 gündeki en yeni 20 run'ı, en fazla 45 gün ve 200 kayıt sınırıyla JSON olarak gösterir. Prompt, model cevabı, tool verisi, diff, workspace yolu, dosya yolu ve task ID gösterilmez. Okuma 64 dosya ve 64 MiB ile sınırlıdır; kaynak sınırına ulaşılırsa `truncated: true` döner.

İsteğe bağlı proje-local mirror, global metrics yerine geçmeyen ve `integrity: untrusted_project_mirror` taşıyan `<workspace>/.hades/runs.jsonl` kaydıdır:

```powershell
& "%NVM_HOME%\nodejs\npm.cmd" run runs:mirror -- enable
& "%NVM_HOME%\nodejs\npm.cmd" run runs:mirror -- status
& "%NVM_HOME%\nodejs\npm.cmd" run runs:mirror -- view
& "%NVM_HOME%\nodejs\npm.cmd" run runs:mirror -- disable
& "%NVM_HOME%\nodejs\npm.cmd" run runs:mirror -- clear --confirm
```

Mirror varsayılan kapalıdır. Enable işlemi Git workspace'te `.hades/` kuralını `.gitignore` dosyasına eklemek, Git olmayan workspace'te yerel yazım yapmak için terminalden açık onay ister. Aktif dosya 5 MiB, rotated dosya sayısı beş ve toplam kullanım 30 MiB ile sınırlıdır. Mirror lock, path veya I/O hatası provider sonucunu ve canonical metric kaydını etkilemez.

Enable durumu `%LOCALAPPDATA%\subagent-bridge\state\project-run-mirrors.json` içinde yalnız opaque workspace binding hash ve redacted hata sınıfıyla tutulur. Canonical workspace yolu ve ham dosya sistemi kimliği state dosyasına yazılmaz. Ayrıntılı güvenlik ve kabul sözleşmesi [`docs/architecture/RECENT_RUNS_GOZLEMLENEBILIRLIK_PLANI.md`](docs/architecture/RECENT_RUNS_GOZLEMLENEBILIRLIK_PLANI.md) dosyasındadır.

Etkin mirror bütün backend run'larını aynı aktif JSONL dosyasına satır satır yazar:

```text
<workspace>/.hades/
├─ runs.jsonl
├─ runs-<timestamp>-<uuid>.jsonl
└─ runs.jsonl.lock
```

`runs.jsonl.lock` yalnız eşzamanlı append, rotation veya cleanup sırasında bulunur ve normal tamamlanmada silinir. Mirror kaydı prompt, cevap, tool verisi, diff, workspace yolu, dosya yolu, task ID, kullanıcı kimliği veya secret içermez.

Direct edit baseline ölçümü, edit akışını değiştirmeden mevcut redacted execution hash'lerini kullanır. Bekleyen edit sonuçlarını görmek ve kullanıcı sonucunu kaydetmek için:

```powershell
& "%NVM_HOME%\nodejs\npm.cmd" run edit:feedback -- list
& "%NVM_HOME%\nodejs\npm.cmd" run edit:feedback -- accepted <feedback-id>
& "%NVM_HOME%\nodejs\npm.cmd" run edit:feedback -- minor_fix <feedback-id>
& "%NVM_HOME%\nodejs\npm.cmd" run edit:feedback -- reverted <feedback-id>
& "%NVM_HOME%\nodejs\npm.cmd" run edit:feedback -- security_concern <feedback-id>
```

Tek bir bekleyen edit varsa `feedback-id` omit edilebilir. Feedback kaydı prompt, model cevabı, diff, dosya yolu, workspace yolu veya task ID içermez. `npm run metrics` içindeki `directEditBaseline`, etiketlenmiş edit sayısını, bekleyen feedback'i, sonuç dağılımını ve müdahale oranını raporlar. En az 30 etiketli gerçek edit oluşmadan izole edit mimarisi için karar verilmez.

Task profile kalite değerlendirmesi için:

```powershell
& "%NVM_HOME%\nodejs\npm.cmd" run routing:feedback -- list
& "%NVM_HOME%\nodejs\npm.cmd" run routing:feedback -- useful <feedback-id>
& "%NVM_HOME%\nodejs\npm.cmd" run routing:feedback -- partial <feedback-id>
& "%NVM_HOME%\nodejs\npm.cmd" run routing:feedback -- not_useful <feedback-id>
```

`npm run metrics` içindeki `routingEvaluation`, profile bazında etiketli sonuç sayısını, yararlılık oranını, ortalama süreyi ve bildirilen provider maliyetini gösterir. Bir profile için en az 15 etiketli gerçek görev oluşmadan routing kalıcı olarak başarılı sayılmaz.

```powershell
& "%NVM_HOME%\nodejs\npm.cmd" run metrics
```

## Architecture documents

Temel mimari kararlar `docs/architecture` altındadır:

- [`CONTEXT_ORKESTRASYONU_VE_GUVENLI_SECOND_BRAIN_PLANI_2026-08-21.md`](docs/architecture/CONTEXT_ORKESTRASYONU_VE_GUVENLI_SECOND_BRAIN_PLANI_2026-08-21.md): kalıcı hafıza katmanının izolasyon ve güvenlik modeli.
- [`MODEL_KIMLIGI_VE_ERISIM_MODU_PLANI.md`](docs/architecture/MODEL_KIMLIGI_VE_ERISIM_MODU_PLANI.md): model kimlikleri, erişim modları ve yetki sınırları.
- [`DEEPSEEK_EDIT_PILOT_VE_MIRROR_KARARLILIK_PLANI.md`](docs/architecture/DEEPSEEK_EDIT_PILOT_VE_MIRROR_KARARLILIK_PLANI.md): kontrollü edit promotion ve mirror kararlılığı.
- [`RECENT_RUNS_GOZLEMLENEBILIRLIK_PLANI.md`](docs/architecture/RECENT_RUNS_GOZLEMLENEBILIRLIK_PLANI.md): redacted çalışma ve gözlemlenebilirlik sözleşmesi.

## Continuous integration

`.github/workflows/validate.yml`, Node 22 ve 24 üzerinde Windows ve Linux matrisiyle `npm ci`, `npm test` ve `npm run verify:ci` çalıştırır. `verify:ci` yerel executable, provider auth ve Vault'a ihtiyaç duymaz; dağıtım şablonlarını, policy şemasını, eşlenmiş skill içeriklerini ve zorunlu recent-runs/mirror bileşenlerini denetler. Gerçek provider acceptance komutları yerel veya onaylı nightly ortam için bırakılır.

Personal policy değişikliği öncesinde `npm run config:backup` ile backup alınabilir. Doğrulanmış bir backup'a dönmek için `npm run config:rollback -- config-<timestamp>.json` kullanılır. Rollback yalnız `~/.config/subagent-bridge/backups` içindeki bridge tarafından oluşturulmuş backup adlarını kabul eder. Değişiklikten sonra `npm run verify` ve `npm run smoke` çalıştırılmalıdır.

## Lisans ve katkı

- Lisans: [Apache-2.0](LICENSE)
- Güvenlik açığı bildirimi: [SECURITY.md](SECURITY.md)
- Katkı rehberi: [CONTRIBUTING.md](CONTRIBUTING.md)
