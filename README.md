# Hades Orchestrator

Hades Orchestrator, OpenCode host ve ana orkestratör modelinin yerel MCP üzerinden bağımsız subagent backend'lerini çağırmasını sağlayan provider-neutral bir orkestrasyon sistemidir. İç yürütme bileşeni `subagent-bridge` olarak adlandırılır. Host/orkestratör modeli ile subagent backend'i aynı kavram değildir.

## Ne sunar

- Provider-neutral MCP köprüsü: DeepSeek V4 Pro/Flash, GLM 5.2/5.3 (HighSpeed/Flash dahil), Codex Luna/Terra/Sol ve GPT-6 Astra, Gemini Pro/Flash (Antigravity) ve native Claude Code backend'lerini tek MCP yüzeyinden çağırır.
- Salt-okunur sandbox: read-only çağrılar provider başlamadan doğrulanır; Antigravity ortamında harici MCP sunucusu veya kalıtsal geniş izin varsa fail-closed reddedilir.
- Kontrollü edit: yalnız seçilmiş dosyalar disposable workspace içinde düzenlenir; source hash kontrolü, secret taraması ve rollback destekli promotion uygulanır.
- Model yetki ve erişim modu politikası: `defaultMode`/`allowedModes` fail-closed çalışır; istenmeyen modda provider process'i başlatılmaz.
- Bütçe ve retry: günlük/aylık maliyet limitleri atomik rezervasyonla uygulanır; yalnız geçici hatalar retry edilir.
- Kalıcı hafıza katmanı: secret korumalı, kaynaklandırılmış Obsidian tabanlı bellek entegrasyonu.
- Gözlemlenebilirlik: redacted metrikler, süreçler arası kilitler, circuit breaker ve isteğe bağlı proje mirror'ı.

## İçindekiler

- [Kullanım](#kullanım)
- [Güncel durum](#güncel-durum)
- [Hızlı başlangıç](#hızlı-başlangıç)
- [Mimari](#mimari)
- [Kişisel yapılandırma](#kişisel-yapılandırma)
- [Kanonik yönlendirme](#kanonik-yönlendirme)
- [Görev profilleri](#görev-profilleri)
- [Sağlayıcı matrisi](#sağlayıcı-matrisi)
- [Antigravity sözleşmesi](#antigravity-sözleşmesi)
- [Codex sözleşmesi](#codex-sözleşmesi)
- [Ortak değişmezler](#ortak-değişmezler)
- [Kabul kanıtı ve test tabanı](#kabul-kanıtı-ve-test-tabanı)
- [Model rolleri](#model-rolleri)
- [Güvenlik ayrımı](#güvenlik-ayrımı)
- [Skill'ler](#skiller)
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

- Çalışma zamanı policy'si `~/.config/subagent-bridge/config.json`, executable ve adapter ayarları `~/.config/subagent-bridge/agents.json` dosyasından yüklenir; `ORCHESTRATOR_CONFIG` ve `SUBAGENT_BRIDGE_AGENTS_CONFIG` ortam değişkenleri bu konumları değiştirir. Repo içindeki `config/policy.json` ve `config/agents.json` dağıtım şablonudur.
- Host tarafı MCP tanımı için `opencode.jsonc.example` dosyasını uyarlayın; server `subagent-bridge/src/server.js` ve `SUBAGENT_BRIDGE_TRUSTED_WORKSPACE` başlangıç context'i ile başlatılır.
- Salt-okunur görev: `subagent-bridge_deepseekPro`, `subagent-bridge_glm52`, `subagent-bridge_codex`, `subagent-bridge_geminiFlash` gibi global araçlarla uzman modele görev verin; izinli kök içinde isteğe bağlı `workspace` kabul edilir.
- Kontrollü edit: yalnız seçili dosyalar ve kabul kriterleriyle; örnek araçlar `subagent-bridge_glm52Edit`, `subagent-bridge_codexSolEdit`, `subagent-bridge_codexAstraEdit` veya `run_task_profile` edit profilleri.
- Doğrulama ve izleme: `npm test`, `npm run verify:ci`, `npm run budget`, `npm run metrics`.

## Güncel durum

- Paket: `hades-orchestrator@2.1.0`
- Çalışma zamanı: Node.js 20.9 veya üzeri, ESM; CI Node.js 22 ve 24 kullanır
- Canonical operasyon kaydı: `%LOCALAPPDATA%\subagent-bridge\logs\metrics`; isteğe bağlı proje görünümü `<workspace>/.hades/runs.jsonl`
- Güncel izole regresyon sonucu: `313/313 PASS`; `npm run verify`, `npm run verify:ci` ve `npm run smoke` başarılı

## Hızlı başlangıç

```powershell
npm ci
npm test
npm run verify
npm run smoke
npm run runs:recent
```

Günlük OpenCode kullanımı kişisel global entegrasyon üzerinden yürütülür. Repository-local MCP akışı geliştirme ve smoke testi için korunur. Provider kimlik bilgileri repository içinde tutulmaz.

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

Değişmezler:

```text
HOST / ORCHESTRATOR MODEL != SUBAGENT BACKEND
PACKAGE LOCATION != ACTIVE WORKSPACE
```

Aktif workspace bridge package konumundan, config dosyasından veya runtime CWD'sinden türetilmez; `SUBAGENT_BRIDGE_TRUSTED_WORKSPACE` başlangıç context'i canonicalize edilir. Antigravity read-only çağrıları machine-owned allowed roots içinde isteğe bağlı `workspace` kabul eder; diğer public araçlar `workspace`, `cwd`, `worktree`, executable, exec args, sandbox, delegation depth, execution ID ve caller alanlarını kabul etmez.

## Kişisel yapılandırma

- Policy `configVersion: 2` ile şema doğrulamasından geçer; v1 çalışma belleğinde v2'ye migrate edilir. Bilinmeyen/eksik alan fail-closed reddedilir.
- Her provider `defaultMode`/`allowedModes` ile sınırlıdır; istenmeyen modda provider başlatılmadan `mode_not_allowed` döner. Dağıtım policy'sinde Claude Code yalnız read-only; Codex, Antigravity ve OpenCode/DeepSeek read-only ve edit.
- `reliability.monthlyCostLimitUsd: 50` ve `warningThresholdPercent: 80` tanımlıdır. Limit aşımı provider başlamadan reddedilir; `npm run budget` anlık durumu gösterir. Limit bridge seviyesindedir; provider billing hesabını kapsamaz.
- Codex `allowNonGitWorkspace` yalnız kişisel machine config ile açılır; `--skip-git-repo-check` yalnız `.git` yokken eklenir ve read-only sandbox korunur.
- DeepSeek için Git repository zorunluluğu yoktur; denied-root ve Zod yapılandırılmış çıktı doğrulaması korunur.

## Kanonik yönlendirme

```text
Gemini Pro / Flash      → AntigravityAdapter → AGY (gemini-3.1-pro-high / gemini-3.8-flash-high)
Codex                   → CodexAdapter → official standalone codex.exe
Native Claude Code      → ClaudeCodeAdapter
DeepSeek V4 Pro / Flash → OpenCodeAdapter → deepseek/deepseek-v4-pro veya -flash
GLM 5.2/5.3 (+Flash)    → OpenCodeAdapter → zai-coding-plan/glm-5.2, -highspeed, -5.3, -5.3-flash
Bağımsız OpenCode model → OpenCodeAdapter (yalnız açıkça istenen kimlikler)
```

Gemini hiçbir durumda OpenCodeAdapter yoluna yönlendirilmez; OpenCodeAdapter `google/gemini-*` kimliklerini fail-closed reddeder.

Her normalize sonuç `requestedModel`, nullable `resolvedModel` ve `accessMode` taşır. `resolvedModel` yalnız bridge mapping'i veya provider'ın yapısal çıktısıyla doğrulanan gerçek kimliktir; Codex provider default'u kesin model sayılmaz. Health görünümü aynı canonical config'ten `modePolicy` ve `configuredModels` üretir.

## Görev profilleri

`run_task_profile` seçili görevi sabit canonical route ile çalıştırır; named-provider araçları provider değiştirmez. Read-only profillerde fallback yoktur. Edit profilleri yalnız policy'deki `fallbackTargets` sırasını controlled-edit akışında kullanır; her hedef temiz disposable workspace, tek deneme, secret fail-closed ve doğrulanmış promotion sınırına tabidir.

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

Profil tanımları `~/.config/subagent-bridge/config.json` içindeki `orchestration.taskProfiles` alanındadır; repo `config/policy.json` şablondur. Şablonu aktif kişisel config'e uygulamak için:

```powershell
npm run config:apply-routing
npm run config:apply-agent-modes
```

Komutlar önce `~/.config/subagent-bridge/backups/` altına backup oluşturur; rollback `npm run config:rollback -- <backup>` ve `npm run config:rollback-agent-modes -- <backup>` ile yapılır.

## Sağlayıcı matrisi

```text
Antigravity / Gemini Pro      VERIFIED
Antigravity / Gemini Flash    VERIFIED
Codex                         VERIFIED
DeepSeek V4 Pro / Flash       VERIFIED
GLM 5.2                       VERIFIED
GLM 5.2 HighSpeed             BLOCKED / SUBSCRIPTION ENTITLEMENT REQUIRED
OpenCode independent backend  IMPLEMENTED / CONFIGURED BACKEND'E BAĞLI
Claude Code                   IMPLEMENTED / PROVIDER AUTH-DEPENDENT
Kimi / Qwen                   INTEGRATED / OPENCODE CATALOG ENTRY REQUIRED
```

## Antigravity sözleşmesi

Canonical executable: `%LOCALAPPDATA%\agy\bin\agy.exe` (PATH üzerinden `agy`). Model alias eşlemesi:

```text
gemini_pro        → gemini-3.1-pro-high
gemini_flash      → gemini-3.8-flash-high
gemini_flash_3_7  → gemini-3.7-flash-high
gemini_flash_3_8  → gemini-3.8-flash-high
claude_sonnet     → claude-sonnet-4-6
```

Read-only enforcement sandbox açıkken çalışma alanını `--add-dir` ile görünür kılar; geçici permission policy `deny write_file(*)` ve `no command(*)` sınırlarını korur. Read-only çağrıdan önce `agy mcp list` sonucu tam olarak `No MCP servers configured.` olmalıdır; harici MCP sunucusu veya dar allowlist dışı kalıtsal izin varsa provider başlamadan fail-closed reddedilir.

Dar komut allowlist'i: `git status`, `git diff`, `git log`, `git show`, `git ls-files`, `git rev-parse`, `rg`, `Get-ChildItem`, `Get-Location`, `dir`, `pwd`, `ls`, `pwd; ls`. Separator/redirection/pipeline mutation, `write_file`, mutasyon yapan Git komutları ve network probe engellidir.

Geçici read-only settings yaşam döngüsü mutex ve süreçler arası owner PID lock ile serileştirilir; normal akış `finally` içinde orijinal ayarlara döner. `executable_missing` yalnız gerçek spawn hatasından (`ENOENT`) üretilir; provider çıktısındaki `ENOENT` metni `non_zero_exit` eşdeğerine normalize edilir.

## Codex sözleşmesi

Canonical executable: PATH üzerinden `codex` (resmi standalone; ChatGPT login geçerli).

```text
read_only  → codex exec --sandbox read-only
edit       → codex exec --sandbox workspace-write
```

Normal execution path `danger-full-access`, sandbox bypass veya approval bypass içermez; provider default modelinde `--model` tamamen omit edilir.

Global edit araçları (`codexLunaEdit`, `codexTerraEdit`, `codexSolEdit`, `codexAstraEdit`) ve edit task profilleri bridge-owned disposable workspace içinde çalışır; yalnız seçilmiş dosyalar source hash eşzamanlılık kontrolü, secret taraması ve rollback destekli promotion ile uygulanır. Prompt sözleşmesi seçili dosyalar ile salt-okunur bağlam dosyalarının incelenmesine izin verir; test, build, script, paket yöneticisi ve mutasyon yapan shell komutlarını yasaklar. Disposable workspace her sonuçta temizlenir.

Kabul propları: no-tool inference, file-backed read, edit create ve mevcut dosya edit PASS; read-only write, prompt-injection write, desktop sibling dışı write ve `~/.ssh` okuma BLOCKED/DENIED; cancellation, timeout ve process cleanup PASS. `%TMPDIR` writable-root erişimi Windows davranışıdır; keyfi filesystem erişimi olarak tanımlanmaz.

## Ortak değişmezler

```text
MAX_DELEGATION_DEPTH = 1
Host → subagent                         ALLOWED
subagent → bridge → another subagent   DENIED
```

- Orchestrator recursive delegation yapmaz; provider timeout'undan sonra kullanıcı açıkça istemedikçe aynı provider yeniden çağrılmaz.
- Retry yalnız read-only geçici hatalarda `maxRetries` sınırında; edit timeout/process_exit/network otomatik retry etmez ve `mutation_state_unknown` döner.
- Workspace lock anahtarı canonical workspace'in SHA-256'sıdır; aynı workspace'te read işleri paralel, edit read/write'ı dışlar; farklı süreçler sıraya alınır, aktif lock leaseHeartbeatMs ile yenilenir.
- Cache yalnız read-only başarı sonuçları için; anahtar workspace hash'i, Git `HEAD`, backend, model, profile ve prompt hash'idir.
- Timeout ve output limit süreç ağacını `killProcessTree(pid)` ile sonlandırır; explicit cancel AbortController akışını tamamlar; orphan process bırakılmaz.

## Kabul kanıtı ve test tabanı

Nihai acceptance: Gemini Pro ve Codex gerçek file-backed sonuçla çağrıldı; timeout override, orchestrator retry, fallback, repository mutation ve orphan process `0`; AGY settings restore `YES`, stale sentinel `NO`.

```text
Acceptance 3x   143/143 PASS
npm run verify   PASS
npm run smoke    PASS
```

Dondurulmuş acceptance sonrası güncel regresyon baseline'ı `313/313 PASS` olarak doğrulanmıştır. Süreçler arası lock ve lease testleri zamanlamaya duyarlıdır; ağır doğrulama komutları aynı makinede sıralı çalıştırılmalıdır.

Bilinen engelleyici olmayan maddeler: Codex `%TMPDIR` isolation değerlendirmesi; tarihsel AGY nested `ENOENT` hedefi (yeniden üretilemedi); native Claude acceptance auth'a bağlı; Faz 5 provider'ları bilinçli olarak beklemede.

Dondurma ilkeleri: shared core concrete requirement olmadan refactor edilmez; routing yeni acceptance olmadan değişmez; read-only permission kapsamı convenience ile genişletilmez; sandbox filesystem-backed proplar olmadan değişmez; mock/unit test tek başına VERIFIED üretmez. Core yalnız confirmed production bug, yeni provider, security vulnerability, ölçülmüş concurrency defect veya contract-breaking upstream değişikliğiyle yeniden açılır.

## Model rolleri

Codex: kullanıcı niyetini ve kapsamı belirler, mimari karar verir, kod üretir, testleri çalıştırır, DeepSeek bulgularını bağımsız doğrular, tamamlanma kararını verir.

DeepSeek: geniş kod analizi, ikinci görüş, araştırma/inceleme/planlama; kanıta dayalı yapılandırılmış sonuç döndürür. `implementer` + `edit` modunda yalnız seçilmiş hedef dosyalar için disposable değişiklik ve kontrollü promotion üretir; kabuk çalıştırmaz, commit oluşturmaz, başka ajan çağırmaz.

Diğer uzman backend'ler: Gemini Pro web araştırması/dosya denetimi; Gemini Flash kısa düşük maliyetli araştırma; native Claude Code ikinci görüş (auth'a bağlı). Named-provider çağrısı başarısızsa başka provider sonucu aynı çağrının sonucu gibi sunulmaz.

`run_deepseek_subagent` `model` varsayılanı `deepseek_pro` (`deepseek_flash` seçilebilir), `mode` varsayılanı `read_only`; `edit` yalnız implementer rolü + seçilmiş dosyalar ile. `run_deepseek_edit_pilot` ana workspace'i değiştirmez, disposable diff döndürür. `run_glm_subagent` aynı sözleşmeyi GLM 5.2/HighSpeed için kullanır; `run_glm_edit_pilot` promotion yapmaz.

## Güvenlik ayrımı

- Yerel analiz ile internet erişimi aynı subagent çağrısında birleştirilmez.
- `analyst`/`reviewer`/`planner` yalnız `Read`/`Glob`/`Grep`; `researcher` yalnız `WebSearch`/`WebFetch` kullanır; araçlar `--allowedTools` ile önceden sınırlıdır.
- Claude Code `--strict-mcp-config` ile proje MCP sunucusu yüklemez; oturum kaydı `--no-session-persistence` ile kapalıdır; her çağrı en fazla sekiz agent turu.
- API anahtarı prompta, checkpoint'e veya kaynak koduna yazılmaz.

## Skill'ler

Kanonik skill'ler `.agents/skills` altında tutulur; Claude uyumlu kopyalar `.claude/skills` altındadır: `commit-at`, `guvenlik-ve-sertlestirme`, `kod-denetleyicisi`, `otomatik-dokumantasyon`, `veri-seti-analizcisi`. Eşitleme: `npm run skills:sync`.

## Kurulum

Gereksinimler: Node.js 20.9+ (22/24 önerilir), OpenCode CLI, Antigravity CLI, official standalone Codex CLI, Git; native Claude için Claude Code CLI + auth; DeepSeek yolu için DeepSeek API anahtarı.

```powershell
npm ci
npm test
npm run verify
npm run smoke
npm run pilot
```

DeepSeek kullanıcı ortamı: `powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\configure-deepseek.ps1" -DeepSeekApiKey "<DEEPSEEK_API_KEY>"`.

## Başlatma

Günlük kullanımda OpenCode host ve `@orchestrator` kişisel global tool entegrasyonu üzerinden canonical bridge source'a bağlanır; Git workspace'te `context.worktree`, Git olmayan workspace'te `context.directory` trusted workspace olarak doğrulanır. Repository-local geliştirmede proje kökünde OpenCode başlatılır; `opencode.jsonc` local stdio MCP sunucusunu yükler.

Codex liderliğindeki DeepSeek danışmanlık yolunu başlatmak için proje kökünde `scripts/start-codex.ps1` çalıştırılır; betik kullanıcı düzeyindeki ortam değişkenlerini yükler ve Codex'i proje kökünde başlatır. İlk olarak `check_deepseek_subagent`, ardından dar salt-okunur görev için `run_deepseek_subagent` çağrılır.

## Komut referansı

Çalıştırma ve provider doğrulaması:

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
```

Test ve doğrulama:

```text
npm test               Tüm Node.js regresyon testleri
npm run verify         Yerel executable, skill, config ve Vault doğrulaması
npm run verify:ci      Provider auth gerektirmeyen CI doğrulaması
```

Gözlemlenebilirlik ve bakım:

```text
npm run metrics            Toplu redacted metric özeti
npm run metrics:prune      Retention dışı rotated metric temizliği
npm run runs:recent        Son çalışmaları salt-okunur gösterir
npm run runs:mirror -- ... Proje-local mirror yaşam döngüsü
npm run edit:feedback      Direct-edit kullanıcı sonucu kaydı
npm run routing:feedback   Task-profile kullanıcı sonucu kaydı
npm run memory:review      Kalıcı hafıza yaşam döngüsü denetimi
npm run memory:evaluate    Retrieval kalite değerlendirmesi
npm run config:backup      Kişisel policy backup'ı
```

## Kalıcı sınırlar

- DeepSeek yalnız `implementer` + `edit` modunda seçilmiş dosyalara doğrulanmış promotion uygular; context, listelenmemiş dosya, Vault veya workspace dışına yazamaz.
- Codex doğrulamadan görevi tamamlandı saymaz; sandbox veya onay mekanizmasını devre dışı bırakan kalıcı seçenek kullanılmaz.
- Geri alınamaz işlem, üretim erişimi, dış sistemde yazma ve secret aktarımı insan onayı gerektirir.

## Kalıcı hafıza

Proje, `memory` klasöründeki Obsidian uyumlu yerel Vault'u Codex kontrollü kalıcı hafıza olarak kullanır; klasör Git takibinin dışındadır ve her görev başında bağlama yüklenmez.

- `check_persistent_memory`: Vault erişimini ve güvenlik sınırlarını kontrol eder.
- `search_persistent_memory`: notları arar; secret içeriği engeller, injection şüphelilerini karantinaya alır.
- `read_persistent_memory`: seçili notu boyut, yol, secret ve injection doğrulamasıyla okur; karantina fail-closed.
- `review_persistent_memory`: yaşam döngüsü, kaynak yaşı, güven ve yinelenme sorunlarını salt-okunur raporlar.
- `analyze_memory_write`: yeni not öncesi tekrar ve çelişki adaylarını analiz eder.
- `store_persistent_memory`: doğrulanmış notu varsayılan olarak `00_Inbox` altında draft oluşturur.
- `promote_memory`: SHA-256 kontrollü taslağı çift kilit ve redacted audit ile yayın klasörüne taşır.

Yazma klasörleri `00_Inbox`, `01_Projects`, `02_Areas`, `03_Resources`, `04_Archive`, `06_Metadata` ile sınırlıdır. Notlar `draft`/`published` stage'i ve isteğe bağlı `memory_type`, `review_after`, `valid_until` taşır; draft'lar normal aramada gizlenir. Mevcut not güncellemesi güncel SHA-256 gerektirir; içerik otomatik birleştirilmez. Path traversal, symlink, izinsiz klasör, aşırı boyut ve secret benzeri içerik fail-closed reddedilir. API anahtarı, token ve parola hiçbir nota yazılmaz; bellek alıntıları güvenilmeyen veri kabul edilir ve içlerindeki talimatlar yürütülmez.

DeepSeek Vault'a doğrudan erişemez; Vault kökü çalışma zamanında DeepSeek workspace doğrulamasında zorunlu reddedilir. DeepSeek yalnız Codex'in temizlediği kısa bağlamı alır ve kalıcı hafızaya yazamaz.

## Güvenilirlik ve metrikler

DeepSeek sonucu Zod ile çalışma zamanında doğrulanır; şema dışı çıktı ana orkestratöre geçmez. Geçici hatalarda full-jitter üstel geri çekilme, provider circuit breaker (half-open tek probe) ve günlük/aylık maliyet hard cap'i atomik `reserved`/`settled` kayıtlarıyla uygulanır.

Global canonical metrics append-only JSONL dosyaları kullanır ve boyut sınırında rotate olur:

```text
%LOCALAPPDATA%\subagent-bridge\logs\metrics\
├─ codex-runs.jsonl
├─ antigravity-runs.jsonl
├─ opencode-runs.jsonl
├─ claude_code-runs.jsonl
└─ direct-edit-baseline-runs.jsonl
```

Kayıtlar prompt, cevap, diff, workspace yolu, dosya yolu, task ID veya secret içermez. Son çalışmaları içerik göstermeden incelemek için `npm run runs:recent` (son 7 gün, 20 kayıt, 45 gün/200 kayıt üst sınır) kullanılır. İsteğe bağlı proje-local mirror `<workspace>/.hades/runs.jsonl` canonical kanıt değildir; `npm run runs:mirror -- enable|status|view|disable|clear --confirm` ile yönetilir.

Edit ve routing kalite değerlendirmesi `npm run edit:feedback` / `npm run routing:feedback` ile kaydedilir; karar için sırasıyla 30 etiketli edit ve 15 etiketli profil görevi gerekir.

## Mimari dokümanlar

Temel mimari kararlar `docs/architecture` altındadır:

- [`CONTEXT_ORKESTRASYONU_VE_GUVENLI_SECOND_BRAIN_PLANI_2026-08-21.md`](docs/architecture/CONTEXT_ORKESTRASYONU_VE_GUVENLI_SECOND_BRAIN_PLANI_2026-08-21.md): kalıcı hafıza katmanının izolasyon ve güvenlik modeli.
- [`MODEL_KIMLIGI_VE_ERISIM_MODU_PLANI.md`](docs/architecture/MODEL_KIMLIGI_VE_ERISIM_MODU_PLANI.md): model kimlikleri, erişim modları ve yetki sınırları.
- [`DEEPSEEK_EDIT_PILOT_VE_MIRROR_KARARLILIK_PLANI.md`](docs/architecture/DEEPSEEK_EDIT_PILOT_VE_MIRROR_KARARLILIK_PLANI.md): kontrollü edit promotion ve mirror kararlılığı.
- [`RECENT_RUNS_GOZLEMLENEBILIRLIK_PLANI.md`](docs/architecture/RECENT_RUNS_GOZLEMLENEBILIRLIK_PLANI.md): redacted çalışma ve gözlemlenebilirlik sözleşmesi.

## Sürekli entegrasyon

`.github/workflows/validate.yml`, Node 22 ve 24 üzerinde Windows ve Linux matrisiyle `npm ci`, `npm test` ve `npm run verify:ci` çalıştırır. `verify:ci` yerel executable, provider auth ve Vault'a ihtiyaç duymaz. Gerçek provider acceptance komutları yerel veya onaylı ortam için bırakılır. Kişisel policy değişikliği öncesinde `npm run config:backup`; rollback `npm run config:rollback -- <backup>`.

## Teşekkür

Bu projenin mimari yaklaşımında [Avenox](https://avenox.lol/) projelerinden ve [github.com/avenoxai](https://github.com/avenoxai) depolarından ilham alınmıştır. Paylaştıkları deneyim ve araç tasarımları için teşekkür ederiz.

## Lisans ve katkı

- Lisans: [Apache-2.0](LICENSE)
- Güvenlik açığı bildirimi: [SECURITY.md](SECURITY.md)
- Katkı rehberi: [CONTRIBUTING.md](CONTRIBUTING.md)
