# DeepSeek Edit Pilotu Ve Mirror Kararlılık Planı

## Amaç

Her subagent provider'ında ortak `read_only` ve `edit` erişim modları hedefi içinde, DeepSeek edit yetkisini ana repository'ye açmadan önce disposable workspace üzerinde güvenlik pilotu tasarlamak ve `RUNS-10` mirror eşzamanlılık testindeki başarısızlıkların kök nedenini görünür hale getirmek.

Bu planın pilot ve ilk production rollout fazları uygulanmıştır. Pilot yüzeyi ana workspace'i değiştirmez; production edit yalnız kontrollü promotion sözleşmesiyle çalışır.

DeepSeek Pro ile yapılan ilk salt-okunur tasarım incelemesinde eksik olduğu belirlenen disposable workspace, diff aktarımı ve pilot sonuç redaction mekanizmalarının ilk pilot sürümü uygulanmıştır. Bu mekanizmalar production edit izni sayılmaz ve adversarial kabul kapısını kaldırmaz.

## Uygulama Durumu

2026-08-11 tarihinde aşağıdaki fazlar uygulanmıştır:

- `RUNS-10` child süreçleri mirror `{ written, reason }` sonucunu parent'a aktarır ve test modül yolu `import.meta.url` ile CWD bağımsız çözülür.
- Metric lock token, PID, iki aşamalı sahiplik okuması ve process canlılık doğrulaması kullanır.
- Bridge-owned disposable workspace servisi seçilmiş dosyaları boyut, traversal, link, hard-link, binary, hassas dosya ve secret kontrolleriyle geçici alana kopyalar.
- Her pilot ayrı container içindeki `workspace` dizininde çalışır; sibling escape tespit edilir ve container tamamen temizlenir.
- `run_deepseek_edit_pilot` MCP aracı ve `deepseek-edit` OpenCode agent'ı eklendi.
- Pilot OpenCodeAdapter içindeki bridge-owned pilot caller'ı kullanır; production DeepSeek edit aynı adapter içinde ayrı `deepseek_edit` caller'ıyla kontrollü promotion yapar.
- Edit pilotu tek provider denemesi kullanır; timeout veya belirsiz mutation durumunda retry yapmaz.
- Pilot değişen dosyaları ve unified diff'i döndürür; secret benzeri çıktı fail-closed reddedilir.
- Gerçek DeepSeek Pro pilotu disposable kopyada yeni bir fonksiyon eklemiş, ana kaynak dosyası değişmemiş ve cleanup tamamlanmıştır.
- Güncel regresyon `264/264 PASS` sonucundadır.

Production edit karar kapısı unit/adversarial testler, gerçek DeepSeek Pro promotion kabulü ve bağımsız Gemini güvenlik incelemesi sonrasında açılmıştır. Repository template ve aktif kişisel config içinde OpenCode `allowedModes` artık `read_only` ve `edit` değerlerini kabul eder. Varsayılan mod `read_only` kalır.

## Ortak Subagent Yetki Hedefi

Tüm provider'lar aynı subagent sözleşmesinde iki erişim modu sunar:

- `read_only`: Salt-okunur agent, edit ve dolaylı yazma araçları reddedilir.
- `edit`: Provider'a özgü edit agent, trusted workspace sınırı ve edit retry koruması kullanılır.

`accessMode` çağrı sonucu içinde görünür kalır. `defaultMode` her provider için `read_only` olur. Provider'ın `edit` modu teknik olarak entegre edilse bile, `allowedModes` ancak gerçek acceptance ve adversarial testlerden sonra açılır.

Mevcut rollout durumu:

- Codex: `read_only` ve `edit` etkin.
- Antigravity: `read_only` ve `edit` etkin.
- Native Claude Code: iki mod mimaride desteklenir; edit provider auth ve acceptance bekler.
- Bağımsız OpenCode provider: iki mod adapter ve edit agent düzeyinde desteklenir; policy acceptance bekler.
- DeepSeek: aynı OpenCode subagent mimarisinde `read_only` ve kontrollü `edit` dalları etkindir.

## Mevcut Durum

- DeepSeek `run_deepseek_subagent` canonical aracı varsayılan olarak salt-okunur kalır ve açık `mode: edit` kabul eder.
- OpenCode provider policy'si DeepSeek için `read_only` ve `edit` kabul eder.
- DeepSeek workspace doğrulaması allowed roots, denied roots ve Vault reddini uygular.
- Runtime delegation depth sınırını ve structured output doğrulamasını uygular.
- `RUNS-10` bir kez başarısız olmuş, izole tekrarında ve sonraki tam regresyonda geçmiştir.
- Mirror yazımı best-effort'tur; yazma hatası structured `written: false` sonucu olarak dönebilir.
- `withMetricLock` stale reaper'ı sahiplik doğrulaması olmadan eski metric lock dosyasını silebilir; bu, mirror testinden bağımsız bir üretim güvenilirliği inceleme konusudur.

## Pilot Ön Koşulları

DeepSeek `edit` access mode'u eklenmeden önce aşağıdaki tasarım kararları yazılı ve test edilebilir olmalıdır:

- Bridge-owned disposable workspace yaşam döngüsü: oluşturma, canonicalization, izolasyon, cleanup ve cleanup başarısızlığı raporlama.
- Disposable root konumu ve allowed-root sözleşmesi.
- Symlink, junction ve path traversal saldırılarına karşı workspace guard davranışı.
- Diff formatı, saklama süresi, erişim yolu ve Codex'in diff'i okuma sözleşmesi.
- Sonuç içeriğinde secret benzeri veri tespiti, redaction davranışı ve güvenlik olayı sınıflandırması.
- Timeout veya iptal sonrası orphan process tespiti ve workspace cleanup sırası.
- Pilot araç adı, Zod input şeması, hata sözleşmesi ve mevcut `run_deepseek_subagent` aracından kesin ayrımı.

## Entegrasyon Kararı

DeepSeek edit için farklı bir provider adapter veya yeni bir CLI entegrasyonu oluşturulmaz. Mevcut `OpenCodeAdapter` iki erişim modu için yeniden kullanılır; adapter zaten okuma, yazma, model seçimi, timeout, cancellation ve edit mutation retry korumasını destekler.

Canonical hedef akış:

```text
run_deepseek_subagent
├─ accessMode: read_only
│  └─ OpenCodeAdapter → deepseek-readonly
└─ accessMode: edit
   └─ OpenCodeAdapter → deepseek-edit
```

Geçiş döneminde edit dalı ayrı ve açık isimli bir pilot tool ile sunulabilir. Nihai sözleşmede DeepSeek, diğer provider'lar gibi aynı subagent çağrısında `accessMode` ile seçim yapar. Pilot tool production edit izni anlamına gelmez.

## Yapılandırma Hedefi

Repository template ve aktif kişisel `agents.json` için nihai OpenCode policy hedefi:

```json
{
  "defaultMode": "read_only",
  "allowedModes": ["read_only", "edit"],
  "deepSeekReadOnlyAgent": "deepseek-readonly",
  "editAgent": "deepseek-edit"
}
```

`allowedModes` içine `edit`, pilot acceptance ve bağımsız güvenlik incelemesi tamamlandıktan sonra eklenmiştir. `defaultMode` `read_only` kalır.

OpenCode agent ayrımı:

- `deepseek-readonly`: read, glob, grep ve list izinli; edit, bash, task ve question yasak.
- `deepseek-edit`: read, glob, grep, list ve edit izinli; bash, task ve question başlangıçta yasak.
- Test çalıştırma ihtiyacı serbest `bash` açılarak çözülmez. Gerekirse ayrı command allowlist veya Codex doğrulama aşaması kullanılır.

`deepseek-edit` agent tanımı repository-local OpenCode config'e eklenirken, global ve farklı workspace çağrılarında agent'ın hangi trusted config kaynağından yükleneceği ayrıca doğrulanır.

## Kod Değişikliği Kapsamı

Nihai ortak DeepSeek çağrısında aşağıdaki değişiklikler gerekir:

1. `runDeepSeek` public şemasına `accessMode: read_only | edit` eklenir; varsayılan `read_only` olur.
2. `createDeepSeekRuntimeRequest` sabit `mode: read_only` yerine doğrulanmış access mode'u kullanır.
3. Read-only ve edit için ayrı, çelişmeyen prompt sözleşmeleri üretilir.
4. `OpenCodeAdapter`, read-only çağrıda `deepseek-readonly`, edit çağrıda `deepseek-edit` seçer.
5. DeepSeek checkpoint gerçek `accessMode` değerini kaydeder.
6. Edit sonucu değişen dosyaları ve redacted diff özetini taşıyan ayrı strict şemadan geçer.
7. Edit çağrısında `maxAttempts: 1`, schema repair kapalı ve provider fallback kapalı olur.
8. Mevcut read-only DeepSeek structured-output ve checkpoint davranışı geriye uyumlu kalır.

## DeepSeek Edit Pilot Sözleşmesi

DeepSeek edit, genel subagent erişim modeli içindeki `accessMode: edit` dalıdır. Mevcut `run_deepseek_subagent` varsayılan olarak read-only kalır ve mode verilmeden yapılan çağrıların davranışı değişmez. Edit yüzeyi ayrı ve açık isimli bir pilot aracı olarak başlayabilir, ancak ayrı bir ürün veya provider değildir.

- Her çağrı yalnız bridge tarafından oluşturulan disposable workspace'te çalışır.
- Disposable workspace, ana repository ve Vault dışında, bridge-owned geçici kök altında canonicalize edilmiş bir dizindir.
- Kullanıcıdan gelen workspace yolu pilot execution workspace'i seçemez.
- Ana repository'ye otomatik patch, dosya kopyalama, commit veya merge yapılmaz.
- Sonuç, yalnız redacted execution sonucu ve Codex tarafından ayrıca okunabilecek diff özeti olarak döner.
- Tek yürütmede yalnız bir DeepSeek provider çağrısı yapılır; provider fallback ve otomatik mutation retry kapalıdır.
- Timeout, iptal, süreç hatası, şema hatası veya cleanup hatasında pilot başarısız sayılır.
- Pilot runtime girişi `maxAttempts: 1`, `maxSchemaRepairAttempts: 0` ve boş fallback hedefleriyle çalışır.
- Diff unified diff olarak üretilir; ana repository'ye uygulanmaz ve yalnız bridge-owned disposable workspace bağlamında okunabilir.
- Provider sonucu kullanıcıya veya Codex'e dönmeden önce secret benzeri değerler için taranır; eşleşme fail-closed security sonucu üretir.

## Yasak Yetkiler

- Ana repository, Vault, kullanıcı profili veya allowed disposable kök dışına okuma ve yazma.
- Serbest shell, command interpreter, ağ erişimi ve environment secret erişimi.
- Subagent delegasyonu, commit, push, publish veya harici sistem mutasyonu.
- Ana repository'ye otomatik diff uygulama.

## Zorunlu Kabul Testleri

1. Ana repository yolu pilot workspace olarak reddedilir.
2. Vault ve tüm alt dizinleri reddedilir.
3. Disposable olmayan allowed-root dizini reddedilir.
4. Pilot workspace içinde izinli dosya oluşturma ve mevcut dosyayı düzenleme başarılı olur.
5. Workspace dışına doğrudan ve path traversal ile yazma reddedilir.
6. Prompt injection ile shell, ağ veya dosya dışı yazma denemesi reddedilir.
7. Secret benzeri environment değeri provider'a aktarılmaz ve sonuçta görünmez.
8. Delegation depth ihlali provider başlamadan reddedilir.
9. Timeout veya iptal sonrası process tree sonlanır ve disposable workspace temizlenir.
10. Geçersiz structured output fail-closed döner ve ana repository değişmeden kalır.
11. Edit hatası `mutation_state_unknown` olduğunda otomatik retry yapılmaz.
12. Test sonunda orphan process, stale lock ve disposable workspace kalmaz.
13. Symlink veya junction üzerinden disposable root dışına yazma reddedilir.
14. Diff, disposable workspace dışındaki dosya yolunu içermez; ana repository değişmeden kalır.
15. Secret benzeri provider çıktısı redakte edilir ve normal sonuç olarak döndürülmez.

## Açma Kararı

DeepSeek edit yalnız aşağıdaki koşullar birlikte sağlanırsa değerlendirilir:

- Zorunlu kabul testleri Windows CI ve yerel ortamda tekrarlanabilir biçimde geçer.
- Provider adapter'ın gerçek edit araç sınırı doğrulanır; prompt beyanı tek başına kanıt sayılmaz.
- Ana repository'ye aktarımın otomatik olmadığı ve Codex ile kullanıcı onayı gerektirdiği korunur.
- Adversarial test seti önceden tanımlanır: prompt injection, path traversal, symlink veya junction escape, shell escape, environment injection ve output parsing saldırıları.
- Bağımsız güvenlik incelemesi, önceden tanımlı adversarial test setinin tamamı için kanıt üretir.

İlk rollout koşulları sağlanmış ve `opencode.allowedModes` içine `edit` eklenmiştir. Yeni bir kritik veya yüksek güvenlik bulgusunda edit policy kapatılır ve son doğrulanmış agents backup'ına dönülür.

## RUNS-10 Kararlılık İncelemesi

Test, sekiz bağımsız child process'in aynı project mirror'a kayıt yazmasını ve tam sekiz kaydın okunmasını doğrular. Kilit protokolü satır ekleme ve rotation akışını serialize eder; doğrulanmış sürekli bir lost-update üretim hatası yoktur.

Ancak test aşağıdaki gözlemlenebilirlik boşluklarına sahiptir:

- Child process'ler mirror `written` ve `reason` sonucunu parent'a iletmez.
- Test child stdout'unu yok sayar; `written: false` durumu exit code ile ayırt edilemeyebilir.
- Kilit edinim deadline'ları 5 saniye ile sabittir ve Windows yükü altında aşılabilir.
- Test modül yolu process CWD'sine bağlıdır.

## RUNS-10 Önerilen Düzeltmeler

1. Child sonucu stdout üzerinden `{ written, reason }` olarak parent'a aktarılır.
2. Parent, `runCount === 8` kontrolünden önce tüm child yazımlarının başarılı olduğunu doğrular.
3. Test modül yolu `import.meta.url` tabanlı çözülür.
4. Retry olmadan tekrarlı stres koşusu, satır kaybı ve lock starvation için ana doğrulama olur.
5. Yeni bir temp köküyle tek retry yalnız geçici I/O veya lock hatası sınıfını doğrulayan ayrı testte kullanılır.
6. Aynı temp kökünde retry yapılmaz; metric append idempotent değildir.
7. İlk deneme başarısı, retry sayısı ve hata sınıfı test raporunda görünür olur.
8. Lock timeout'un test için enjekte edilmesi değerlendirilir; production varsayılanı kanıt olmadan değiştirilmez.

## Üretim Kilit Sertleştirme Kararı

`withMetricLock` stale reaper'ı canlı kilit silme riski bakımından ayrıca incelenmelidir. Değişiklik yapılacaksa token ownership, iki aşamalı sahiplik okuması ve process canlılık doğrulamasıyla yapılır. Stale lock temizliğinin çalıştığını ve canlı sahibin lock'unun silinmediğini kanıtlayan ayrı acceptance testleri gerekir. Bu çalışma, test gözlemlenebilirliği düzeltmesinden bağımsızdır.

## Doğrulama

- DeepSeek pilot kodu eklendiğinde `npm test`, `npm run verify`, `npm run verify:ci` ve `npm run smoke` çalıştırılır.
- `RUNS-10` değişikliğinde hedefli `node --test tests/recent-runs.test.js` ve tam `npm test` çalıştırılır.
- Windows CI üzerinde tekrarlı eşzamanlılık çalışması değerlendirilir.
