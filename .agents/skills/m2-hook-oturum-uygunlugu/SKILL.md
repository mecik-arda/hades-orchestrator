---
name: m2-hook-oturum-uygunlugu
description: Kullanıcı gerçek bir memory-hook oturumu için disposition sınıflandırması istediğinde gerçek session kaydını ve istemci/session bağını doğrular, uygun disposition'ı hook:classify ile kaydeder; kullanıcı outcome'u atamaz ve eksik kanıttan oturum üretmez.
---

# M2 Hook Session Eligibility

Gerçek bir memory-hook session'ının M2 ölçümüne uygun olup olmadığını sınıflandır. Bu skill Vault notu yazmaz ve YOLO/COCO görüntü etiketlerini incelemez.

## Ne zaman kullanılır

- Kullanıcı belirli bir gerçek memory-hook session'ını sınıflandırmayı veya `hook:classify` işlemini açıkça istediğinde.
- Bir feedback kaydından önce session disposition'ını doğrulamak gerektiğinde.

## Kanıt ve sınıflandırma

1. Altyapı durumunu ve bu oturuma özel kanıtı ayrı değerlendir. Hook kurulumunun/etkinliğinin doğrulanması, bu oturumda enjeksiyon veya kayıt olduğunu tek başına kanıtlamaz.
2. Aynı M2 metrik kaynağında gerçek `memory_hook_session` kaydını, istemciyi ve ölçülmüş `durationMs` değerini doğrula. Salt-okunur `npm run metrics` özeti yalnız toplu altyapı görünümüdür; tek session kanıtı yerine geçmez.
3. Kullanıcının bu konuşmada daha önce verdiği tam session ID'yi yeniden kullan; aynı ID'yi tekrar isteme. OpenCode'u yeniden başlatmak tek başına ID'nin değiştiğini veya hook bağlamının enjekte edildiğini kanıtlamaz. Verilen ID için kayıt yoksa eşleşmediğini bildir; yeni oturumu incelemek gerekiyorsa yeni ID'yi yalnız bir kez iste.
4. Kullanıcı tam session ID verdiyse aktif canonical Orkestrasyon bridge metrik kaynağında normalize edilmiş ID'nin SHA-256 değeri ve istemciyle salt-okunur eşleştirme yap. OpenCode için `client=opencode` şarttır. Raw ID/hash'i çıktıya, loga veya dosyaya yazma. ID bu konuşmada yoksa yalnız kullanıcı oturum-özel inceleme istediğinde bir kez sor; ID başka bir konuşmada verildiyse o konuşmanın geçmişine erişimin olmadığını açıkla. ID hâlâ yoksa eşleşmeyi `doğrulanamadı` bırak; ID tahmin etme.
5. Eşleşen `memory_hook_session` ve ölçülmüş süre oturuma ait hook callback kaydını doğrular. Metrik özetindeki `decisionReady: false` tek oturum disposition'ı veya feedback kaydını engellemez; bu yalnızca toplu pilot karar eşiğidir.
6. Mevcut disposition'ı aynı `client + sessionIdHash` için oku. Kayıt yoksa uygunluğu kanıttan değerlendir; disposition zaten varsa yenisini yazmaya çalışma.
7. Yalnız kanıtın desteklediği bir disposition seç:
   - `eligible_real_user`: gerçek kullanıcı session'ı ve gerçek hook bağlamı doğrulanmış.
   - `ineligible_instrumentation`: session teknik, araç veya test enstrümantasyonuna ait.
   - `ineligible_synthetic`: session sentetik ya da üretim dışı.
   - `ineligible_duplicate`: aynı session kaydının yinelenmiş kopyası.
   - `indeterminate_legacy`: eldeki kanıt uygunluğu belirlemeye yetmiyor.
8. `eligible_real_user` kanıtlanamıyorsa bu değeri seçme. Eksik, eski veya belirsiz kanıtta `indeterminate_legacy` kullan.
9. Kullanıcı açıkça disposition kaydı istediyse şu komutu gerçek değerlerle çalıştır:

```text
npm run hook:classify -- <disposition> --client=<opencode|codex|claude|generic> --session-id=<real-session-id>
```

`--session-id` zorunludur. İstemciyi tahmin etme; script'in varsayılan `generic` davranışına bel bağlamak yerine gerçek istemciyi belirt. `--reason=<reason>` yalnız kısa, doğrulanmış ve hassas olmayan gerekçe varsa eklenebilir.

## Sınırlar

- Bu skill yalnız disposition kaydeder; `useful`, `partial` veya `not_useful` outcome'u seçmez ve feedback yazmaz.
- Proje/iş sonucu, commit, plan, sohbetin genel niteliği veya başka session'ın sonucu M2 eligibility kanıtı değildir.
- Session'da gerçek `memory_hook_session` ve ölçülmüş süre varsa cohort `unassigned` olsa bile bu tek başına eligibility'yi engellemez. Cohort çözümleme ve kurulum teşhisi `m2-hook-proje-kohortu` kapsamındadır.
- Kullanıcının belirttiği proje adı cohort ataması için yeterli değildir; existing event'in `projectCohort` değerini değiştirme veya cohort'u disposition/outcome ile karıştırma.
- Session ID, session süresi veya session kaydı yoksa retroaktif değer, sentetik session ya da tahmini istemci oluşturma. Kaydı nitel gözlem olarak bırak.
- Host bağlamı session ID sağlamıyor diye, kullanıcı bu konuşmada geçerli tam ID verdiyse salt-okunur eşleştirmeyi atlama. Eksik ID'yi en fazla bir kez iste; verilmezse mevcut kanıtla tamamla ve oturuma özel eşleşmeyi doğrulanamadı bırak.
- Başka session'a erişimin varmış gibi davranma. Gerçek ID ve metrik kaydı yoksa sınıflandırma yapma.
- Kanıtı, session ID'yi veya metrik içeriğini prompt, rapor ya da kalıcı notlarda tekrar etme; sonuçta yalnız disposition ve redakte edilmiş işlem durumunu bildir.
- Kullanıcı kayıt istemediyse yalnız kanıta dayalı sınıflandırma önerisini ver; kayıt komutunu çalıştırma.
- Sonuçta altyapı durumunu, belirli oturumun kayıt/enjeksiyon/süre kanıtını ve disposition durumunu ayrı raporla. Cohort'u ayrıca metadata olarak bildir; `unassigned` veya registry yokluğu eligibility engeli değildir.
