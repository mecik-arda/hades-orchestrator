---
name: m2-hook-sonuc-geri-bildirimi
description: Kullanıcı belirli eligible memory-hook session'ı için useful, partial veya not_useful sonucunu açıkça seçip kaydetmek istediğinde önce aynı client/session disposition'ını doğrular ve hook:feedback kullanır; outcome'u çıkarmaz.
---

# M2 Hook Outcome Feedback

Bu skill, kullanıcının belirli bir gerçek memory-hook session'ı için açıkça seçtiği outcome'u kaydeder. Sonuç proje veya genel çalışma başarısını değil, yalnız o session'da enjekte edilen hook bağlamına verilen kullanıcı sonucunu temsil eder.

## Ne zaman kullanılır

- Kullanıcı belirli bir session için `useful`, `partial` veya `not_useful` sonucunu açıkça belirttiğinde ve kaydedilmesini istediğinde.
- Feedback öncesi eligibility/disposition doğrulaması gerektiğinde; bu durumda `m2-hook-oturum-uygunlugu` adımını uygula.

## Kayıt akışı

1. Outcome'un kullanıcı tarafından o session için açıkça seçildiğini doğrula. Yalnız şu değerler kabul edilir: `useful`, `partial`, `not_useful`.
2. Gerçek `memory_hook_session` kaydını, aynı istemciyi ve tam gerçek session ID'yi doğrula. Host ID'yi sağlamasa bile kullanıcı tam gerçek ID'yi verdiyse aktif canonical Orkestrasyon bridge metrik kaynağında normalize edilmiş ID'nin SHA-256 değeri ve istemciyle salt-okunur eşleştirme yap; raw ID/hash'i çıktı veya loga yazma. Host ve bu konuşma ID sağlamıyorsa, kullanıcı oturum-özel kayıt isteğinde bulunduğunda ID'yi bir kez iste. ID başka konuşmada verilmişse bu konuşmanın geçmişini göremediğini açıkla. ID hâlâ yoksa `doğrulanamadı` bildir ve feedback yazmadan dur; tekrar isteme.
3. Aynı `client + session-id` çifti için `eligible_real_user` disposition'ını doğrula. Uygunluk henüz sınıflandırılmamışsa ve kullanıcı sınıflandırma/kayıt zinciri istediyse önce:

```text
npm run hook:classify -- eligible_real_user --client=<opencode|codex|claude|generic> --session-id=<real-session-id>
```

Yalnız gerçek kullanıcı session'ı ve hook bağlamı kanıtlanıyorsa `eligible_real_user` kaydet. Kanıt yoksa veya disposition uygun değilse feedback adımına geçme.
4. Açıkça seçilen sonucu aynı istemci ve session ID ile kaydet:

```text
npm run hook:feedback -- <useful|partial|not_useful> --client=<opencode|codex|claude|generic> --session-id=<real-session-id>
```

`--session-id` zorunludur. Gerçek istemciyi belirt; `generic` yalnız kaynak gerçekten generic ise kullan.
5. Komut dönüşünün kaydı kabul ettiğini doğrula. Hata, duplicate veya çelişki halinde tekrar tekrar yazma; redakte hata sınıfını bildir ve dur.

## Sınırlar

- Sessizlik, memnuniyet, proje tamamlanması, commit başarısı, plan onayı veya model performansından outcome çıkarma.
- Kullanıcının yalnız iş/proje hakkındaki olumlu ya da olumsuz ifadesini otomatik olarak M2 session outcome sayma; session'da enjekte edilen hook bağlamını kastettiği açık olmalıdır.
- Kullanıcının belirtmediği outcome'u seçme veya önceki session'dan kopyalama.
- Eligibility, client, ID veya feedback/outcome eşleşmesi belirsizse yazmadan dur.
- `useful`/`partial`/`not_useful` feedback aynı session için global canonical label'a bir kez eklenir; session `unassigned` olsa da bu label global toplamda yer alır. Feedback kaydı cohort'u atamaz veya değiştirmez.
- Historical project attribution ek outcome event'i değildir; canonical feedback sayısına ikinci kez ekleme ve yeni session'ın cohort'unu bu yolla düzeltme.
- Session ID'yi tekrar tekrar talep etme. Bir kez istemiş ve alamamışsan eksik kanıtı bildir; outcome seçimini veya kayıt isteğini yeni bir session ID talebi döngüsüne çevirme.
- Toplu `decisionReady: false` değeri, tam session için gerçek kayıt, ölçülmüş süre ve `eligible_real_user` disposition doğrulanmışsa tek session feedback'ini engellemez. Cohort registry'si de bu akış için önkoşul değildir.
- Ham session ID, prompt, transcript, yol, kullanıcı kimliği veya metrik içeriğini loglama ya da sonuca ekleme.
- Cohort yalnız metadata'dır; outcome, eligibility veya yetkilendirme yerine geçmez.
- Kullanıcı etiket dağılımı veya proje görünümünü sorarsa `m2-hook-metrik-incelemesi` canonical toplam ile cohort/historical ek görünümlerini ayrı açıklar; aynı outcome'u ikinci kez saymaz.
