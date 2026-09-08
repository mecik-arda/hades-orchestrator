SUBAGENT MODEL KİMLİĞİ VE İKİLİ YETKİ MODU HEDEFİ

Araştırma sonucu: Bu hedef projeye uygulanabilir. Altyapının önemli kısmı şimdiden read_only ve edit modlarını destekliyor. Ancak her modele edit yetkisi varsayılan olarak verilmemeli; provider bazında doğrulandıktan sonra policy ile açılmalı.

UYGULAMA DURUMU - 2026-08-11

Faz 1 tamamlandı. requestedModel, nullable resolvedModel ve accessMode normalize edilmiş sonuç sözleşmesine eklendi. Antigravity ve OpenCode yapılandırılmış tam modeli, Claude yapısal modelUsage bilgisini raporlar. Codex default kesin model olarak gösterilmez. DeepSeek checkpoint public alias ile çözülen modeli ayrı alanlarda taşır. Health görünümü mode policy ve yapılandırılmış model eşlemelerini döndürür.

Faz 2 tamamlandı. defaultMode ve allowedModes şeması, legacy mode migration'ı ve provider başlamadan fail-closed runtime enforcement uygulandı. Repository şablonu ve aktif kişisel agents.json backup alınarak yeni policy'ye geçirildi.

Faz 3 mevcut güvenlik kapılarıyla tamamlandı. Codex read_only ve edit, Antigravity plan ve accept-edits modlarını explicit kullanır. Claude prompt sözleşmesi accessMode'a göre üretilir. OpenCode read-only ve edit agent ayrımı explicit hale getirildi; provider policy OpenCode/DeepSeek ve GLM edit çağrılarını kabul eder. GLM 5.2 aynı controlled-edit sözleşmesiyle eklenmiştir.

Faz 4 beklemededir. Native Claude edit acceptance provider authentication gerektirir.

Güncel otomatik regresyon: 264/264 PASS. Gerçek provider edit güvenlik kabulleri aşağıdaki zorunlu test matrisinden bağımsız olarak atlanmış sayılmaz.

1. GERÇEK MODEL KİMLİĞİ

Her subagent çağrısında genel model ailesi yerine ayrıntılı model kimliği gösterilecek.

Örnekler:

Gemini Pro yerine gemini-3.1-pro-high
Gemini Flash yerine gemini-3.8-flash-high
Claude Sonnet yerine claude-sonnet-4-6 veya provider'ın gerçekten kullandığı tam model
DeepSeek Pro yerine deepseek/deepseek-v4-pro
DeepSeek Flash yerine deepseek/deepseek-v4-flash
Codex için gpt-5.6-sol, gpt-5.6-terra veya gpt-5.6-luna

İstenen model ile gerçekten kullanılan model ayrı alanlarda tutulacak:

requestedModel
resolvedModel

Ana orkestratör ve çağrılan subagent şu yapısal bilgileri bilecek:

backend
requestedModel
resolvedModel
role
accessMode

Modelin kendi beyanı güvenlik kanıtı sayılmayacak. Canonical bilgi bridge ve adapter tarafından üretilecek.

Codex çağrısında default kullanılırsa bu değer tam model kimliği sayılmayacak. Mümkünse explicit model kullanılacak veya gerçek runtime modeli ayrıca doğrulanacak.

Claude Code alias kullanırsa sonucun modelUsage alanından gerçek model kimliği çıkarılacak.

2. ROLE VE ACCESS MODE AYRIMI

İki yetki seviyesi role olarak adlandırılmayacak. Projede role, görevin uzmanlık türünü; accessMode ise dosya yetkisini gösterecek.

Örnek:

role: reviewer
accessMode: read_only

role: implementer
accessMode: edit

Desteklenen görev rolleri gerektiğinde şunları içerebilir:

analyst
reviewer
researcher
planner
implementer

Desteklenen erişim modları yalnız şunlar olacak:

read_only
edit

3. READ_ONLY MODU

Read_only modunda subagent:

Dosya okuyabilir.
Glob ve içerik araması yapabilir.
İzin verilen salt-okunur komutları kullanabilir.
Görev researcher ise internet araştırması yapabilir.
Dosya oluşturamaz, düzenleyemez veya silemez.
Shell, patch, dolaylı script veya prompt injection yoluyla yazma yapamaz.
Workspace dışına erişemez.

Yerel repository analizi ile internet araştırması DeepSeek tarafında aynı çağrıda birleştirilmeyecek. Researcher yalnız web, diğer roller yalnız yerel salt-okunur araçları kullanacak.

4. EDIT MODU

Edit modunda subagent:

Yalnız trusted workspace içinde dosya oluşturabilir ve düzenleyebilir.
Workspace dışına, korunan köklere, Vault'a, secret dosyalarına veya kullanıcı özel dizinlerine yazamaz.
Gerekli testleri çalıştırabilir ancak shell izinleri provider bazında allowlist ile sınırlandırılır.
Timeout, process exit veya belirsiz mutation durumunda otomatik retry yapamaz.
Başka bir subagent çağıramaz.
Commit, push veya geri alınamaz işlem yapamaz; bunlar Codex ve kullanıcı kontrolünde kalır.
Nihai doğrulama ve tamamlanma kararı her zaman ana Codex orkestratörüne aittir.

5. PROVIDER BAZLI HEDEF DURUM

Codex:

read_only ve edit kullanılabilir.
read_only için read-only sandbox, edit için workspace-write sandbox korunacak.
danger-full-access ve approval bypass kullanılmayacak.

Gemini ve Claude Sonnet üzerinden Antigravity:

read_only ve edit teknik olarak kullanılabilir.
read_only için plan modu, write_file deny ve sandbox birlikte kullanılacak.
edit için explicit accept-edits modu, sandbox ve workspace sınırı kullanılacak.
--dangerously-skip-permissions kullanılmayacak.

Native Claude Code:

read_only ve edit teknik olarak kullanılabilir.
read_only için permission-mode plan kullanılacak.
edit için permission-mode acceptEdits kullanılacak.
Edit çağrısının promptu kendisini salt-okunur olarak tanımlamayacak.
Gerçek edit acceptance testi ancak Claude auth geçerli olduktan sonra yapılacak.

OpenCode ve DeepSeek:

OpenCode teknik olarak read_only ve edit agent tanımlayabilir.
Read_only agent edit, bash, task ve external directory yetkilerini reddedecek.
Edit agent yalnız trusted workspace içinde açıkça tanımlanmış araçları kullanacak.
Mevcut run_deepseek_subagent her zaman read_only kalacak.
DeepSeek edit gerekiyorsa ayrı bir araç veya ayrı bir task profile olarak, varsayılan kapalı ve pilot statüsünde eklenecek.

6. MERKEZİ POLICY

Mevcut agents.json içindeki tek mode alanı güvenlik enforcement'ı olarak yeterli değil. Bunun yerine her provider için şu ayrım kullanılacak:

defaultMode
allowedModes

Örnek:

defaultMode: read_only
allowedModes: [read_only, edit]

Runtime, istenen accessMode allowedModes içinde değilse çağrıyı provider başlamadan fail-closed reddedecek.

Global tool, MCP public tool, task profile ve adapter aynı canonical policy kararını kullanacak. Yalnız frontend seviyesindeki kısıtlama yeterli sayılmayacak.

Edit modu varsayılan olarak açılmayacak. Her provider gerçek acceptance ve adversarial testlerden sonra allowedModes listesine edit eklenerek etkinleştirilecek.

7. UYGULAMA SIRASI

Faz 1:

requestedModel ve resolvedModel alanlarını ekle.
Tam model kimliğini MCP sonucu, health görünümü ve redacted metrics ile uyumlu hale getir.
Codex default ve Claude alias durumlarını kesinleştir.

Faz 2:

defaultMode ve allowedModes policy şemasını ekle.
Runtime enforcement uygula.
Mevcut agents.json mode alanı için kontrollü migration yap.

Faz 3:

Codex read_only ve edit davranışını yeniden doğrula.
Antigravity edit çağrısını explicit accept-edits yap.
Claude promptunu accessMode'a göre üret.
OpenCode için explicit read-only ve edit agent tanımla.

Faz 4:

Claude auth düzeltildikten sonra native Claude edit acceptance çalıştır.
DeepSeek edit için disposable workspace üzerinde ayrı pilot yap.
Güvenlik testleri geçmeden DeepSeek edit modunu günlük kullanıma açma.

8. ZORUNLU KABUL TESTLERİ

Her provider ve model için:

Read-only dosya okuma başarılı olmalı.
Read-only doğrudan yazma reddedilmeli.
Prompt injection ile yazma reddedilmeli.
Shell veya dolaylı script ile yazma reddedilmeli.
Edit workspace içinde dosya oluşturabilmeli.
Edit mevcut dosyayı değiştirebilmeli.
Edit workspace dışına yazamamalı.
Protected path ve Vault erişimi reddedilmeli.
Edit timeout sonrasında otomatik retry yapılmamalı.
Mode policy dışındaki istek provider başlamadan reddedilmeli.
İstenen ve gerçekleşen model kimliği sonuçta açıkça görünmeli.
Fallback olursa gerçekten çalışan backend ve model raporlanmalı.
Subagent başka bir subagent çağıramamalı.
Test sonunda orphan process ve izinsiz dosya değişikliği kalmamalı.

9. NİHAİ KARAR

Gerçek model adlarının görünmesi düşük riskli ve doğrudan uygulanabilir.

Her modelin read_only ve edit modunu destekleyebileceği ortak mimari mantıklıdır.

Her modelin edit modunun otomatik açık olması güvenli değildir.

Read_only varsayılan kalacak. Edit yetkisi provider bazında allowedModes policy'si, gerçek sandbox doğrulaması ve acceptance testleri sonrasında açılacak.

DeepSeek edit yetkisi mevcut salt-okunur güvenlik politikasını değiştirdiği için ayrı karar kapısı ve ayrı pilot gerektirir.

Araştırma ve karar tarihi: 2026-08-11

Resmi kaynaklar:

https://developers.openai.com/codex/developer-commands/
https://developers.openai.com/codex/sandboxing/
https://code.claude.com/docs/en/permissions
https://code.claude.com/docs/en/model-config
https://opencode.ai/docs/permissions/
https://opencode.ai/docs/agents/
https://opencode.ai/docs/models/
https://opencode.ai/docs/cli/
https://antigravity.google/docs/cli/modes
https://antigravity.google/docs/cli/permissions
https://antigravity.google/docs/cli/headless
