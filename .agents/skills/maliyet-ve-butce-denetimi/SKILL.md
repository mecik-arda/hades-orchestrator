---
name: maliyet-ve-butce-denetimi
description: Sağlayıcı ve global maliyet limitlerini, retry rezervlerini, circuit breaker durumunu ve SLO metriklerini yorumlar; bütçe aşımı ve dayanıklılık davranışını redakte kurallarına uyarak denetler.
---

# Maliyet ve Bütçe Denetimi

Orkestrasyon köprüsünün maliyet, güvenilirlik ve hizmet seviyesi telemetrisini yorumlayan akış. Amaç, bütçe ve dayanıklılık sınırlarının gerçekten uygulandığını doğrulamak ve aşım durumunda doğru davranışı belirlemektir.

## Ne zaman kullanılır

- Maliyet, bütçe veya limit davranışı değiştiğinde.
- Bütçe aşımı, circuit açılması veya SLO uyarısı inceleneceğinde.
- Bir görevin toplam maliyeti beklenen aralığın dışına çıktığında.

## Komutlar

- `npm run budget` güncel bütçe, harcama ve rezerv durumunu gösterir.
- `npm run metrics` sağlayıcı, percentile ve cache özetini verir.
- `npm run runs:recent` son koşuların yapısal görünümünü verir.

## Denetim maddeleri

- Günlük ve aylık limitler; toplam harcama, kalan tutar ve aktif rezervler tutarlı mı.
- `costBudgetEnforced` değeri ile hard-cap uygulaması örtüşüyor mu.
- Retry maliyet rezervi ve bilinmeyen maliyet sınırı uygulanıyor mu; rezerv açık settlement ile uzlaşıyor mu.
- Circuit breaker sağlayıcı ve gerekiyorsa model bazında doğru açılıyor mu; half-open tek probe davranışı korunuyor mu.
- SLO penceresinde availability ve gecikme p95 eşikleri; `minimumRuns` altında `insufficient_data` dönüyor mu.
- Cache hit ve redaksiyon davranışı metrik özetine doğru yansıyor mu.

## Aşım davranışı

- Limit aşımında fail-closed davran; yeni isteği bütçe dışına taşırma.
- Circuit açıkken fallback yapma veya yalnız policy'de tanımlı hedeflere yönlendir.
- Bozuk metrik satırlarını harcama olarak sayma; `droppedMetricRecords` ile raporla.

## Kurallar ve sınırlar

- Metrik ve bütçe çıktısında görev kimliği, workspace yolu, prompt veya secret bulunmaz; yalnız redakte alanlar raporlanır.
- Rakamları yorumla, karar öner; geri alınamaz işlem yapma.
- Doğrulanamayan maliyet `not_observable` olarak işaretlenir.

## Bitirme koşulu

- Bütçe, rezerv, circuit ve SLO durumu kanıtla raporlanmıştır.
- Aşım veya uyarı varsa kök neden ve öneri belirtilmiştir.
- Redaksiyon sınırları korunmuş, hassas alan sızdırılmamıştır.
