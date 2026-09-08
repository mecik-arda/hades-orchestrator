# Hades Orchestrator

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

Paket `hades-orchestrator@2.1.0`, çalışma zamanı Node.js 20.9+ ve ESM’dir; CI Node.js 22/24 kullanır. Kanonik kayıt `%LOCALAPPDATA%\subagent-bridge\logs\metrics`, isteğe bağlı görünüm `<workspace>/.hades/runs.jsonl` altındadır. Güncel regresyon `313/313 PASS`; `npm run verify`, `npm run verify:ci` ve `npm run smoke` başarılıdır.

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
HOST / ORCHESTRATOR MODEL != SUBAGENT BACKEND
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

Antigravity/Gemini Pro ve Flash, Codex, DeepSeek V4 Pro/Flash ve GLM 5.2 doğrulanmıştır. GLM 5.2 HighSpeed abonelik yetkisi bekler; OpenCode bağımsız backend’i yapılandırmaya, Claude Code auth’a, Kimi/Qwen katalog girdisine bağlıdır.

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

Güncel dondurulmuş regresyon tabanı `313/313 PASS`’tir; zamanlamaya duyarlı ağır doğrulamalar aynı makinede sıralı çalıştırılmalıdır.

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
