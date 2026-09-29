---
name: m2-hook-metrik-incelemesi
description: Kullanıcı M2 memory-hook metriklerini yorumlamak istediğinde canonical global özet, byProjectCohort, conflict ve historicalAttribution görünümlerini salt okunur biçimde ayırır; global decisionReady semantiğini korur ve hiçbir kayıt yazmaz.
---

# M2 Hook Metrics Review

Memory-hook M2 ölçümünü salt okunur inceler. Canonical global feedback ölçümünü cohort tanılamasından ve supplementary tarihsel attribution'dan ayrı tutar.

## Ne zaman kullanılır

- Kullanıcı M2 memory-hook özetini, outcome dağılımını veya karar hazır olma durumunu yorumlamayı istediğinde.
- `byProjectCohort`, attribution conflict veya `historicalAttribution` görünümünü ayrı açıklamak istediğinde.

## İnceleme akışı

1. Salt-okunur toplu özeti aktif canonical Orkestrasyon bridge runtime'ından al. Başka bir proje deposundaysan, oradaki `npm run metrics` komutunun aynı bridge/runtime'a ait olduğunu doğrulamadan çalıştırma. Tekil event içeriklerini veya hassas metrik kaynaklarını gereksiz yere açma.
2. `memoryHookPilot` içindeki canonical global labeled/outcome/rate alanlarını mevcut global ölçüm olarak yorumla.
3. `decisionReady` için mevcut davranışı koru: en az 15 uygun etiket veya pilot penceresinin dolmuş olması. Cohort ya da historical görünüm için yeni readiness/eşik türetme.
4. Canonical `memoryHookPilot.labeledSessions`, `outcomes` ve oranları global feedback event'lerini sayar; outcome kovalarının toplamı canonical labeled count ile tutarlı olmalıdır. Her canonical feedback etiketi global toplamda bir kez sayılır.
5. `byProjectCohort` canonical session'ların cohort'a göre betimleyici bölümüdür; bu sayılar global toplama eklenecek yeni etiketler değildir. `unassigned` session'ın cohort bilgisinin çözülemediğini gösterir, kaydın global outcome sayımından çıkarıldığı anlamına gelmez. `legacy_unattributed`, `unassigned` ve `attribution_conflict` kovalarını birbirine karıştırma; diagnostic conflict sayaçlarını global labeled count'a ekleme.
6. `historicalAttribution` mevcut/legacy etiketlere eklenen supplementary proje atıf görünümüdür; yeni feedback event'i değildir. `attributedLabeledSessions` ve tarihsel cohort outcome'larını global `labeledSessions` veya `byProjectCohort` sayılarına tekrar ekleme. Her ikisini ayrı göster.
7. Kullanıcı belirli bir session ile proje/cohort bağını sorarsa toplu özetle yetinme; session ID hash'i ve client ile exact salt-okunur eşleşme yap. Cohort'u yalnız kaydedilmiş session metadata/izinli historical basis destekliyorsa söyle; kullanıcı sohbetindeki proje adı tek başına mevcut cohort'u değiştirmez.
8. Sonuçta incelemenin kapsamını ve varsa eksik/çelişkili metriği belirt; belirsizliği kesin iddiaya dönüştürme.

Belirli bir session için kullanıcı tam gerçek session ID verdiyse, toplu özetle yetinme: normalize edilmiş ID'nin SHA-256 değeri ve istemciyi `memory_hook_session`, disposition ve feedback kayıtlarıyla salt-okunur eşleştir. Raw ID/hash'i yanıta veya loga yazma. Host ID'yi göstermiyor ve bu konuşmada da ID yoksa, kullanıcı oturum-özel eşleşme istediyse tam ID'yi bir kez iste; ID başka konuşmada verilmişse bu konuşmanın geçmişini göremediğini açıkla. ID sağlanmazsa yalnız oturum eşleşmesini `doğrulanamadı` bırak, toplu metrik incelemesini tamamla ve tekrar isteme. Global `decisionReady: false`, tek session'ı kaydetmeyi veya incelemeyi engellemez; yalnız toplu pilot kararının henüz hazır olmadığını gösterir. Cohort registry'si eksikse cohort'u `unassigned`/`doğrulanamadı` olarak ayır; bunu session eligibility'siyle karıştırma.

## Sınırlar

- Hiçbir disposition, feedback veya historical attribution kaydetmez; hiçbir hook kurmaz ve dosya/registry değiştirmez.
- Outcome, session uygunluğu veya kullanıcı niyeti çıkarmaz.
- Cohort bazlı eşik, karar skoru ya da farklı `decisionReady` yorumu üretmez.
- Ham session ID, path, prompt, transcript, kullanıcı kimliği, registry girdisi veya secret'ı çıktı/log içine taşımaz.
- Cohort adları proje metadatasıdır; dışarı paylaşılan raporu anonim diye nitelendirme.
