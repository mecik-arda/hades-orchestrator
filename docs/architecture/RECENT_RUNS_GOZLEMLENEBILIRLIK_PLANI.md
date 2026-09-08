# Recent Runs Gözlemlenebilirlik Planı

## Karar

İki katmanlı agent çalışma geçmişi uygulanacaktır:

```text
Global metrics
→ bridge-owned canonical operasyon kaynağı
→ tüm workspace'ler ve providerlar

<workspace>/.hades/runs.jsonl
→ kullanıcı onaylı proje-local diagnostic mirror
→ yalnız o projedeki metadata-only run geçmişi
```

Global `runs:recent` komutu mevcut redacted metrics JSONL dosyalarını salt-okunur okur. Proje-local mirror global kaydın yerine geçmez; kolay proje bağlamı için güvenli bir alt kümesini yazar.

## Uygulama Durumu

Her iki faz 2026-08-11 tarihinde uygulanmıştır:

- `npm run runs:recent` strict schema, güvenli dosya doğrulaması, 64 dosya/64 MiB kaynak sınırı, duplicate/conflict yönetimi ve feedback join ile çalışır.
- `npm run runs:mirror -- enable|disable|status|view|clear --confirm` opt-in proje mirror yaşam döngüsünü yönetir.
- Canonical metric başarıyla yazıldıktan sonra etkin workspace mirror'ına metadata-only kayıt fail-soft eklenir.
- Enable binding'leri strict kişisel config'i değiştirmeden machine-owned state kökünde opaque hash olarak saklanır.
- Hedefli recent-runs/mirror testleri, hard-link reddi, bounded rotation ve bağımsız process eşzamanlılığı dahil geçmiştir.
- `npm test` sonucu `234/234 PASS`; `npm run verify`, `npm run verify:ci` ve `npm run smoke` geçmiştir.
- Gerçek global metrics üzerinde recent-runs görünümü doğrulanmıştır. Bu repository için mirror kullanıcı opt-in vermediği için kapalı kalmıştır.

## Amaç

Kullanıcının son subagent çalışmalarını içerik görmeden inceleyebilmesi:

```text
Hangi backend çalıştı?
Hangi profile veya role kullanıldı?
Başarılı mıydı?
Kaç saniye sürdü?
Bildirilen maliyeti neydi?
Retry veya cache oldu mu?
Kullanıcı sonucu faydalı buldu mu?
```

Bu görünüm içerik geçmişi değildir. Hangi dosyanın, hangi prompt ile veya hangi konu için işlendiğini göstermez.

## Mimari

```text
Subagent çalışır
        ↓
subagent-bridge mevcut redacted metrics kaydını yazar
        ↓
metrics JSONL aktif veya rotated dosyası
        ↓
npm run runs:recent yalnız dosyaları okur
        ↓
son 7 gündeki en yeni 20 run gösterilir
```

Feedback, mevcut ayrı `routing_feedback` ve `direct_edit_feedback` kayıtlarından okunur. Recent-runs komutu feedback dahil hiçbir kayıt yazmaz.

## Opt-In Proje Log Mirror'ı

Global metrics, bridge-owned canonical operasyon kaynağı olarak kalır. Workspace içindeki herhangi bir dosya canonical audit veya güvenlik kanıtı değildir.

Proje bazında çalışma geçmişi için kullanıcı onaylı diagnostic mirror desteklenir:

```text
<trusted-workspace>/.hades/runs.jsonl
```

Bu mirror'ın amacı, kullanıcının o workspace'te hangi subagent backend/profile çalışmalarının yapıldığını hızlıca görmesidir. Global metrics yerine geçmez ve global metrics'ten veri okumaz veya geri yazmaz.

### Etkinleştirme

Mirror varsayılan kapalıdır. Otomatik olarak her OpenCode workspace'ine klasör oluşturulmaz. Kullanıcı bir kez etkinleştirdikten sonra, o trusted workspace'teki sonraki bridge run'ları mirror'a otomatik metadata kaydı ekler.

```text
npm run runs:mirror -- enable
npm run runs:mirror -- disable
npm run runs:mirror -- status
npm run runs:mirror -- view
npm run runs:mirror -- clear --confirm
```

Etkinleştirme yalnız terminaldeki yerel kullanıcı tarafından yapılır. Subagent, MCP aracı veya provider süreci mirror etkinleştiremez ya da devre dışı bırakamaz.

Enable durumu machine-owned bridge state kökünde opaque workspace binding hash ile saklanır. Workspace içinde enable/disable state dosyası tutulmaz.

Workspace binding hash canonical absolute path ile workspace kökünün platformun sağladığı dosya sistemi kimliğinden türetilir; path ve ham dosya sistemi kimliği state dosyasına yazılmaz. Workspace taşınır, yeniden adlandırılır veya aynı path'te farklı bir kök oluşturulursa binding değişir ve yeni konumda yeniden enable edilmesi gerekir. Güvenilir dosya sistemi kimliği alınamıyorsa mirror etkinleştirilmez.

### Mirror İçeriği

Mirror yalnız mevcut run metriğinin güvenli alt kümesini taşıyabilir:

```text
recordedAt
opaqueRunHash
profile veya role
backend
mode
outcomeStatus
failureClass
durationMs
reportedCostUsd
cacheHit
retries
```

Prompt, output, tool data, diff, dosya yolu, workspace yolu, task ID, kullanıcı kimliği, secret ve model düşünce zinciri kesinlikle yazılmaz.

### Güvenlik ve Sürdürülebilirlik Sözleşmesi

- Mirror yalnız canonical trusted workspace kökü altında oluşturulur.
- `.hades` mevcutsa gerçek dizin olduğu doğrulanır; symlink, junction, hard link veya normal olmayan dosya reddedilir.
- Her append, rotation ve cleanup işleminden önce `.hades`, aktif `runs.jsonl`, lock dosyası ve ilgili rotated hedefler yeniden doğrulanır. Normal dosya olmayan, hard link taşıyan veya reparse point üzerinden çözülen hedefler reddedilir.
- Her yazma işleminden önce parent path canonicalize edilir ve workspace sınırı tekrar doğrulanır. İlk enable kontrolü sonraki yazımlar için güven varsayımı oluşturmaz.
- Git workspace'te enable komutu `.hades/` için `.gitignore` kuralı ekleme onayı ister. Bu kural aktif logu, lock dosyasını ve bütün rotated dosyaları kapsar. Kullanıcı onay verirse kural idempotent biçimde eklenir; ret verirse mirror etkinleştirilmez.
- Bridge `.gitignore` dosyasını kullanıcı onayı olmadan değiştirmez.
- Git olmayan workspace'te kullanıcı `enable` komutunda açık yazma onayı verir; bridge çalışma dizinine yazma iznini varsaymaz.
- Mirror append-only convenience kaydıdır; kullanıcı veya edit subagent tarafından değiştirilebilir. `integrity: untrusted_project_mirror` olarak işaretlenir.
- Bridge-owned global metrics, karar ve raporlama için tek canonical kaynak olmaya devam eder.
- Mirror write başarısız olursa provider sonucu veya canonical metrics başarısı değişmez; hata yalnız redacted local diagnostic olarak raporlanır.
- Mirror kendi `runs.jsonl.lock` dosya kilidini kullanır; global metric lock ile lock paylaşmaz. Lock exclusive-create ile alınır ve owner token, PID ve oluşturulma zamanını taşır.
- Stale lock yalnız token iki ardışık gözlemde değişmemişse ve owner sürecinin artık yaşamadığı doğrulanabiliyorsa temizlenir. Owner durumu güvenle doğrulanamıyorsa lock silinmez ve mirror write fail-soft atlanır.
- Aktif mirror dosyası en fazla 5 MiB olur. Bir sonraki kayıt sınırı aşacaksa mevcut dosya çakışmaya dayanıklı timestamp ve rastgele suffix ile rotate edilir, ardından yeni aktif `runs.jsonl` exclusive-create ile oluşturulur.
- En fazla beş rotated dosya tutulur. Aktif dosyayla birlikte mirror depolama üst sınırı 30 MiB'tır.
- Rotation ve eski dosya cleanup işlemleri mirror lock altında yapılır. Üst sınırı korumak için gereken cleanup tamamlanamazsa yeni rotation ve mirror write fail-soft atlanır.
- Mirror write, Windows file lock veya antivirus kaynaklı hata oluştuğunda fail-soft atlanır; canonical metrics akışı etkilenmez.
- Mirror disable komutu yalnız yeni yazımları durdurur. Var olan mirror dosyaları kullanıcı açıkça temizlemeyi seçmedikçe silinmez.
- `status` komutu enable durumunu, aktif dosya boyutunu, rotated dosya sayısını ve son redacted mirror hatasını içerik göstermeden raporlar.
- `view` komutu aktif ve rotated mirror dosyalarını aynı strict şema ve kaynak sınırlarıyla okuyup en yeni kayıtları JSON olarak gösterir; global metrics ile birleştirme yapmaz.
- `clear --confirm` yalnız mirror lock alındıktan ve bütün hedefler yeniden doğrulandıktan sonra aktif, rotated ve lock dışındaki geçici mirror dosyalarını temizler; enable durumunu değiştirmez.

### Karar Kriteri

Mirror, global `runs:recent` ile aynı release içinde değil, global görünüm doğrulandıktan sonraki ayrı küçük fazda uygulanır. Uygulama sonrası şu metrikler izlenir:

- Mirror write skip oranı.
- Windows lock/antivirus kaynaklı write hata oranı.
- `.gitignore` onay ret oranı.
- Mirror rotation sıklığı.
- Mirror toplam disk kullanımı ve cleanup başarısızlığı.
- Kullanıcının global yerine mirror'ı canonical kaynak sanma durumu.

### Durdurma Kriterleri

- Mirror I/O sorunu canonical metrics veya provider run'ını etkilerse özellik durdurulur.
- Prompt, output, path, task ID veya secret mirror'a sızarsa özellik durdurulur.
- Mirror write skip oranı gerçek kullanımda `%10` üzerindeyse özellik deneysel kalır veya kaldırılır.
- Mirror toplam boyutu 30 MiB üst sınırında güvenilir biçimde tutulamazsa rotation devre dışı bırakılır ve mirror write durdurulur.
- Junction/symlink/reparse point savunması Windows'ta güvenilir biçimde doğrulanamazsa mirror uygulanmaz.
- Git ignore onayı kullanıcı akışında sürekli sorun oluşturursa mirror varsayılan kapalı kalır ve global workspace filtresi tercih edilir.

### Kapsam Dışı

- Mirror'ı kullanıcı onayı olmadan her workspace'te otomatik açmak.
- `.gitignore` dosyasını kullanıcı onayı olmadan değiştirmek.
- Mirror'dan global metrics'e veri geri aktarmak.
- Mirror üzerinden feedback, routing veya güvenlik kararı vermek.
- Prompt, output, diff veya model özeti eklemek.
- Mirror için yeni database, bulut sync veya web paneli kurmak.

## CLI Sözleşmesi

```text
npm run runs:recent
npm run runs:recent -- --days=14
npm run runs:recent -- --limit=50
npm run runs:recent -- --days=14 --limit=50
```

Varsayılanlar:

- Zaman penceresi: 7 gün.
- Kayıt sınırı: 20.
- En büyük zaman penceresi: 45 gün.
- En büyük kayıt sınırı: 200.
- Sıralama: en yeni kayıt önce.
- Çıktı: JSON.
- Yazma işlemi: yok.
- En fazla taranacak dosya: 64.
- En fazla okunacak toplam veri: 64 MiB.

Geçersiz veya sınır dışı CLI argümanları reddedilir.

Reader beklenen active ve rotated dosyaları en yeniden eskiye sıralar. Dosya veya toplam byte sınırına ulaşırsa okumayı güvenli biçimde durdurur ve üst seviye çıktıda `truncated: true` gösterir; sessizce eksiksiz sonuç izlenimi vermez.

## Gösterilecek Alanlar

Her run için yalnız aşağıdaki yapısal metadata gösterilir:

```text
recordedAt
feedbackId
profile
role
backend
modelDisplay
mode
outcomeStatus
failureClass
durationMs
reportedCostUsd
cacheHit
retries
feedback.routing
feedback.directEdit
```

Alan kuralları:

- `profile`, doğrulanmış task profile adı varsa gösterilir.
- `role`, DeepSeek legacy kaydındaki doğrulanmış role enum'u varsa gösterilir.
- `mode`, execution kaydında varsa gösterilir; legacy DeepSeek kaydında `not_applicable` olur.
- `modelDisplay`, profile modeli ile kayıttaki model hash tam eşleşirse profile modelini gösterir; eşleşmezse yalnız hash prefix'i veya `unknown` gösterir.
- `feedback.routing` ve `feedback.directEdit` ayrı gösterilir.
- Genel execution kaydında feedback yoksa `pending`, legacy DeepSeek kaydında `not_applicable` gösterilir.
- `feedbackId`, full opaque hash'ler arasında benzersiz olana kadar 12 karakterden başlayan prefix'tir.

Üst seviye çıktı:

```text
scope: structural_metadata_only
integrity: best_effort_not_cryptographically_verified
truncated: false
```

## Kesinlikle Gösterilmeyecek Veriler

- Prompt veya prompt prefix'i.
- Model cevabı.
- Tool input veya output.
- Dosya içeriği veya diff.
- Workspace veya dosya yolu.
- Task ID.
- Kullanıcı kimliği.
- Model düşünce zinciri.
- Secret veya credential.
- Model tarafından üretilmiş görev özeti.

## Güvenli Okuma Kuralları

- Yalnız metrics dizinindeki beklenen JSONL dosya adları okunur.
- Symlink ve normal olmayan dosyalar reddedilir.
- Hard link sayısı birden büyük dosyalar ve workspace dışına çözülen junction/reparse point hedefleri reddedilir.
- Her JSONL kaydı strict şema ve allowlist üzerinden normalize edilir.
- Geçersiz hash, timestamp, enum veya sayısal alan taşıyan kayıtlar gösterilmez.
- Bozuk tek JSONL satırı diğer kayıtların okunmasını engellemez.
- Reader yerel yol veya dosya adı bilgisini çıktıya taşımaz.
- Aynı run için tamamen aynı duplicate kayıtlar tekilleştirilir.
- Aynı run hash'i altında çelişkili sonuçlar varsa satır gösterilmez ve `conflictCount` artırılır.
- En fazla 64 beklenen JSONL dosyası ve toplam 64 MiB veri en yeniden eskiye okunur.
- Kaynak sınırına ulaşıldığında sonuç `truncated: true` ile işaretlenir.
- Reader önce zaman ve limit kurallarıyla en fazla 200 run seçer. Feedback akışlarında yalnız bu run'ların tam execution hash'leriyle eşleşen kayıtlar bellekte tutulur; bütün feedback geçmişi join için belleğe yüklenmez.

## DeepSeek Legacy Sınırı

DeepSeek'in eski metric kayıtları `runIdHash` ve `taskIdHash`, genel runtime kayıtları ise `executionIdHash` kullanır. Ortak kimlik kanıtı olmadığı için iki kayıt türü otomatik birleştirilmez.

- Legacy DeepSeek kayıtları ayrı satır olarak gösterilir.
- `role` görünür olabilir.
- `mode` ve feedback `not_applicable` olur.
- Yeni task ID veya gerçek run ID saklanmaz.
- Eski ve yeni kayıtları zaman yakınlığıyla eşleştirme yapılmaz.

Bu yalnız telemetry şeması sınırıdır; DeepSeek execution kalitesi veya güvenliğiyle ilgili bir sorun değildir.

## Kapsam Dışı

Şimdilik uygulanmayacaklar:

- Active JSONL dosyasını rewrite etmek.
- Record-level fiziksel retention düzeltmesi.
- Retention scheduler.
- Yeni persistent store veya migration.
- PostgreSQL, SQLite, ClickHouse veya S3.
- OpenTelemetry collector veya harici telemetry servisi.
- Web panel.
- Hash-chain, WORM storage veya blockchain anchoring.
- Prompt/output masking sistemi.
- Otomatik model görev özeti.
- DeepSeek legacy ve genel kayıtları birleştirmek.
- Proje-local mirror dışındaki başka local state veya web paneli.

Mevcut metrics rotation ve `npm run metrics:prune` davranışı değiştirilmez. Recent-runs görünümü en fazla son 45 günün kayıtlarını okuma anında filtreler; bu filtre fiziksel silme garantisi değildir.

## Uygulama Adımları

1. `scripts/report-recent-runs.js` oluştur.
2. Aktif ve rotated metrics JSONL dosyalarını strict, salt-okunur reader ile oku.
3. Son 7 gün ve limit filtresi uygula.
4. Genel execution ve legacy DeepSeek kayıtlarını ayrı normalize et.
5. Routing/direct-edit feedback kayıtlarını tam execution hash ile ayrı alanlarda birleştir.
6. `package.json` içine `runs:recent` komutunu ekle.
7. README'ye kullanım, gösterilen alanlar ve gizlilik sınırlarını ekle.

## Mirror Uygulama Fazı

1. `scripts/manage-project-logs.js` ile `enable`, `disable`, `status`, `view` ve `clear --confirm` komutlarını ekle.
2. Enable state'ini machine-owned state kökünde opaque workspace binding hash ile sakla.
3. `package.json` içine `runs:mirror` komutunu ekle.
4. Git workspace'te kullanıcı onayıyla `.hades/` kuralını `.gitignore` dosyasına idempotent ekle; onay yoksa mirror oluşturma.
5. Trusted workspace altında gerçek, symlink/junction olmayan `.hades` dizinini güvenle oluştur.
6. Canonical metric başarıyla yazıldıktan sonra metadata-only mirror kaydını append et.
7. Per-workspace file lock, beş rotated dosyalı 5 MiB rotation ve fail-soft write davranışını uygula.
8. Mirror status, güvenli view ve onaylı temizleme davranışını kullanıcıya açıkça bildir.

## Test Planı

- Boş metrics dizini boş run listesi döndürür.
- Genel execution kaydı doğru normalize edilir.
- Legacy DeepSeek kaydı doğru sınırlı görünür.
- Health, cost reservation ve settlement kayıtları listelenmez.
- Rotated dosyalardaki kayıtlar okunur.
- Routing/direct-edit feedback ayrı alanlarda birleşir.
- Feedback join belleği yalnız seçilen en fazla 200 run'ın hash'leri ve eşleşen feedback kayıtlarıyla sınırlıdır.
- Feedback yoksa `pending` veya `not_applicable` doğru gösterilir.
- Bozuk JSONL satırı diğer run'ları engellemez.
- Geçersiz timestamp, enum, hash, path, prompt veya secret fixture çıktıya ulaşmaz.
- Symlink ve ilgisiz JSONL dosyaları reddedilir.
- `--days` ve `--limit` sınırları uygulanır.
- 64 dosya veya 64 MiB okuma sınırında `truncated: true` döner.
- En yeni kayıt önce gelir.
- Reporter öncesi ve sonrası metrics/config dosyaları değişmez.
- `npm test`, `npm run verify` ve `npm run smoke` geçer.

### Mirror Testleri

- Enable kullanıcı onayı olmadan `.gitignore` veya `.hades` değiştirmez.
- Enable onayıyla `.hades/` kuralı `.gitignore` dosyasına bir kez eklenir ve tekrar çağrıda duplicate oluşmaz.
- Git olmayan workspace açık onay olmadan mirror oluşturmaz.
- Enable sonrasında değiştirilen symlink, junction, hard link, reparse point ve workspace dışı aktif, lock veya rotated hedefler her write işleminde reddedilir.
- Aynı workspace'te iki bridge süreci JSONL satırlarını kaybetmeden yazabilir.
- Lock timeout, EBUSY veya EPERM durumunda provider ve canonical metric sonucu değişmez.
- Yaşayan veya yaşadığı güvenle dışlanamayan owner'a ait lock stale kabul edilip silinmez.
- Değişmeyen token ve ölü owner doğrulaması olmadan stale lock cleanup yapılmaz.
- 5 MiB sınırında rotation doğru çalışır ve en fazla beş rotated dosya tutulur.
- Cleanup başarısız olduğunda 30 MiB sınırını büyütecek yeni write atlanır.
- Mirror içeriğinde prompt, output, path, diff, task ID ve secret fixture değerleri bulunmaz.
- Disable yeni yazımları durdurur ve var olan dosyayı silmez.
- Status yalnız redacted yapısal durumu gösterir.
- View yalnız strict allowlist içindeki mirror metadata kayıtlarını gösterir ve global metrics ile birleştirme yapmaz.
- `clear` doğrulama olmadan çalışmaz; `clear --confirm` enable durumunu değiştirmeden güvenli mirror dosyalarını temizler.

## Faz 1 Kabul Kriterleri: Global Recent Runs

- Yeni log deposu oluşturulmaz.
- Komut salt-okunur çalışır.
- Varsayılan çağrı son 7 gün ve en fazla 20 run döndürür.
- Kaynak sınırları içindeki uygun rotated metrics dosyaları en yeniden eskiye kapsanır; sınır aşılırsa `truncated: true` döner.
- Prompt, output, task ID, path, diff ve secret çıktıya ulaşmaz.
- Existing metrics, feedback, rotation ve retention davranışı değişmez.
- Sistem yeni token maliyeti veya provider gecikmesi oluşturmaz.

## Faz 2 Kabul Kriterleri: Proje Log Mirror'ı

- Mirror varsayılan kapalıdır ve açık yerel kullanıcı onayı olmadan workspace'e yazmaz.
- Git workspace'te `.hades/` ignore kuralı onaylanmadan mirror etkinleşmez.
- Mirror etkinse yalnız kullanıcı onaylı trusted workspace altında metadata-only diagnostic kayıt oluşturur.
- Mirror başarısızlığı canonical metrics veya provider sonucunu değiştirmez.
- Aktif ve rotated mirror dosyaları 30 MiB toplam üst sınırını aşmaz.
- Her write ve cleanup işleminde workspace sınırı ile dosya türü yeniden doğrulanır.
- Enable, disable, status, view ve onaylı clear davranışları testlerle doğrulanır.

## Kaynaklar

- OpenTelemetry GenAI semantic conventions: https://github.com/open-telemetry/semantic-conventions-genai
- OpenAI Agents SDK tracing: https://openai.github.io/openai-agents-python/tracing/
- LangSmith sensitive data masking: https://docs.langchain.com/langsmith/mask-inputs-outputs
- OWASP LLM02:2025 Sensitive Information Disclosure: https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/

Araştırma erişim tarihi: 2026-08-11.
