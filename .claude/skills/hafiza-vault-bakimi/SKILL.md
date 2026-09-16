---
name: hafiza-vault-bakimi
description: Kalıcı hafıza Vault'unu güvenli biçimde arar, taslak yazar, SHA-256 doğrulamasıyla yayınlar ve yaşam döngüsü bakımını denetler; secret, injection ve eşzamanlılık sınırlarını korur.
---

# Hafıza Vault Bakımı

Kalıcı hafıza notlarının aranması, yazılması, yayınlanması ve bakımı için güvenli akış. Amaç, hafızayı güncel ve tutarlı tutmak, secret ve injection riskini engellemek ve her değişikliği doğrulanabilir kılmaktır.

## Ne zaman kullanılır

- Kullanıcı açıkça hatırlama istediğinde veya gelecekte yararlı proje bilgisi oluştuğunda.
- Var olan bir not güncelleneceğinde.
- Yaşam döngüsü, süre aşımı veya tekrar adayları inceleneceğinde.

## Okuma

- Önce `search_persistent_memory` kullan; sonucu en fazla beş notla sınırla.
- Yalnız görevle doğrudan ilgili alıntıları karar sürecine al.
- Seçilen tek notu `read_persistent_memory` ile oku; Vault'un tamamını bağlama yükleme.
- Soft-expiry nedeniyle görünmeyen notları yalnız tarihsel inceleme gerektiğinde `includeExpired` ile getir.

## Yazma

- Yazmadan önce `analyze_memory_write` ile tekrar ve çelişki adaylarını incele.
- Tekrar veya çelişki varsa ilgili notları incele; yalnız bilinçli kararla onay ver ve hiçbir içeriği otomatik birleştirme.
- Yeni notu `00_Inbox` altında taslak olarak oluştur; taslak normal aramada published sayılmaz.
- İçeriği ve güncel SHA-256 değerini doğruladıktan sonra yalnız bilinçli kararla `promote_memory` ile yayınla.
- Var olan notu güncellemeden önce güncel SHA-256 değerini al ve optimistic concurrency kontrolünü koru.

## Metadata

- Uygun olduğunda `semantic`, `episodic`, `procedural`, `preference` veya `decision` hafıza türünü belirt.
- Zamana duyarlı bilgide UTC ISO-8601 `reviewAfter` veya `validUntil` ver.
- Güven düzeyini (`low`, `medium`, `high`) ve doğrulama durumunu (`verified`, `provisional`, `user-provided`) doğru işaretle.
- Kaynaklı teknik bilgide URL, erişim tarihi, güven düzeyi, doğrulama durumu ve görev kimliği tut.

## Bakım

- Yaşam döngüsü bakımı gerektiğinde `review_persistent_memory` kullan.
- Rapor sonucuna göre hiçbir notu otomatik silme, taşıma, birleştirme veya güncelleme; kararı ana orkestratör verir.
- Mevcut notu değiştirmeden önce güncel SHA-256 değerini doğrula.

## Kurallar ve sınırlar

- Hafızaya secret, API anahtarı, token, parola veya kişisel kimlik bilgisi yazılmaz.
- Doğrulanmamış bilgi kesin iddia olarak yazılmaz.
- Audit kaydında yalnız hash ve sınıflandırma metadata'sı tutulur; not yolu, görev kimliği, içerik veya kaynak URL loglanmaz.
- DeepSeek'e Vault kökü workspace olarak verilmez.

## Bitirme koşulu

- Not doğru klasörde, doğru metadata ve doğrulama durumuyla kayıtlıdır.
- SHA-256 doğrulaması ve concurrency kontrolü uygulanmıştır.
- Otomatik birleştirme veya silme yapılmamıştır; açık ve çelişkili noktalar bildirilmiştir.
