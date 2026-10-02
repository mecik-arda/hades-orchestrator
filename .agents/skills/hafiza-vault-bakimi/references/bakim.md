# Hafıza Yaşam Döngüsü Bakımı

Bu referansı yalnız notların yaşam döngüsü, süresi, duplicate veya conflict durumu inceleneceğinde kullan.

- Salt-okunur inceleme için `review_persistent_memory` kullan.
- Rapor sonucuna göre hiçbir notu otomatik silme, taşıma, birleştirme veya güncelleme. Kararı kullanıcı veya ana orkestratör verir.
- Exact duplicate adayı, normalize edilmiş gövde en az 40 karakter olduğunda ve mevcut kaydın normalize gövdesiyle aynı olduğunda oluşur.
- Same-title conflict adayı, normalize edilmiş başlık mevcut başlıkla aynı olduğunda oluşur; hedef yol ayrıca karşılaştırılır.
- Bu tespit bounded'dır: tam semantik eşdeğerlik veya Vault'un tamamı için tamlık garantisi yoktur; indeks ve okuma limitleri kapsamı sınırlar.
- Aday bulunduğunda `acknowledgeMemoryConflicts` otomatik true yapılmaz; karar verilene kadar yayımlama durur. İçeriği otomatik birleştirme veya silme.
- Mevcut not değiştirilecekse önce `read_persistent_memory` ile güncel SHA-256 al; optimistic concurrency kontrolünü koru.
- `reviewAfter` geçmiş olması notu otomatik gizleme veya silme nedeni değildir. Tarihsel incelemede süresi dolmuş notu aramak için `includeExpired` kullan.
- Yaşam döngüsü sonucu teknik audit veya içerik bütünlüğü kanıtlamıyorsa bu sınırı raporda belirt.
