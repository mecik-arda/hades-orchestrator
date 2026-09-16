---
name: dogrulama-kapisi
description: Kod, orkestrasyon, yapılandırma veya MCP şeması değiştiğinde doğru test ve doğrulama komutlarını doğru sırayla çalıştırır, başarısızlığı fail-closed değerlendirir ve tamamlanma kararını kanıta bağlar.
---

# Doğrulama Kapısı

Bir değişiklikten sonra hangi doğrulamanın çalıştırılacağını, hangi sırayla çalışacağını ve sonucun nasıl yorumlanacağını tanımlayan kalite kapısı. Amaç, doğrulanmamış işi tamamlanmış saymamak ve başarısızlığı sessizce geçmemektir.

## Ne zaman kullanılır

- Her kod, yapılandırma veya şema değişikliğinden sonra.
- Bir görev tamamlandı olarak bildirilmeden önce.
- Bir doğrulama başarısız olduğunda kök nedeni ayırmak için.

## Temel kapı

Her değişiklikte çalıştırılır:

- `npm test`
- `npm run verify`
- `npm run verify:ci`
- `git diff --check`

## Değişikliğe bağlı koşullu kapılar

- `npm run smoke` — MCP araç şeması veya açıklaması değiştiyse zorunlu.
- `npm run drill` — sağlayıcı hata ve dayanıklılık davranışı değiştiyse.
- Kontrollü `npm run pilot` — köprü veya DeepSeek davranışı değiştiyse.

## Değişikliğe göre kapsam

- JavaScript değişikliği: `npm test`.
- Orkestrasyon veya yapılandırma: `npm run verify` ve `npm run verify:ci`.
- MCP araç şeması: `npm run smoke`.
- Köprü davranışı: kontrollü pilot.
- Skill kaydı veya senkronu: `verify` çıktısında `synchronized: true`.

## Başarısızlık davranışı

- Fail-closed davran; başarısız doğrulamayı geçmiş sayma.
- Aynı başarısız komutu kör tekrar etme; hata sınıfını (izin, şema, ağ, zaman aşımı) ayır.
- Şema veya izin hatasında yeniden deneme yapma; kök nedeni kaynağında bul.
- Bağımlı veya sıralı komutları seri çalıştır.

## Raporlama

- Çalıştırılan komutu, çıktı özetini ve test sayısını kanıt olarak ver.
- Yerel ortam gerektiren doğrulamaları (Vault, auth) ve CI kapsamı farkını açıkça belirt.
- Doğrulanamayan noktayı "doğrulanamadı" olarak işaretle.

## Kurallar ve sınırlar

- Doğrulama sırasında repository değiştirilmez.
- Doğrulama komutlarına secret veya dış sistem erişimi verilmez.
- Başarısız doğrulama varken tamamlanma bildirilmez.

## Bitirme koşulu

- Değişiklik türüne uyan tüm doğrulamalar geçmiştir.
- Test sayısı ve doğrulama çıktıları kanıt olarak kaydedilmiştir.
- Başarısız veya atlanan adım varsa gerekçesi açıkça bildirilmiştir.
