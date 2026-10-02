---
name: dogrulama-kapisi
description: Kod, yapılandırma, skill veya MCP değişikliğinin zorunlu doğrulamalarını seçer; başarısız kontrolden sonra tamamlanma bildirilmesini engeller.
---

# Doğrulama Kapısı

## Kontrol seçimi

Projenin `AGENTS.md` doğrulama kuralları kaynak kabul edilir. Birden çok değişiklik türü varsa gereken kontrollerin birleşimini bir kez çalıştır; her dosya için aynı turu tekrarlama.

- JavaScript: `npm test`.
- Orkestrasyon veya yapılandırma: `npm run verify` ve `npm run verify:ci`.
- MCP araç şeması veya açıklaması: `npm run smoke`; davranış etkisine göre test ve verify kapıları da uygulanır.
- DeepSeek köprü davranışı: kontrollü `npm run pilot`.
- Sağlayıcı hata/dayanıklılık davranışı: `npm run drill`.
- Skill içeriği veya senkronu: `npm run verify`, `npm run verify:ci`; global kopyalar değiştiyse `npm run skills:check-global -- --strict`.
- Yalnız rapor veya dokümantasyon: kaynak/bağlantı ve kapsam kontrolü; tam runtime test turu zorunlu değildir.
- Rule attestation resource davranışı: `npm test`, `npm run smoke`, `npm run verify`, `npm run verify:ci`. Attestation kapsamındaki kural dosyası değişirse manifest uyumunu `smoke` ile kontrol et.
- Her dosya değişikliği: `git diff --check`; yeni dosyalarda içerik ve biçimi ayrıca incele.

Public staging'de yerel Vault bekleyen `verify` yerine uygulanabilir `verify:ci` kullan; bunu doğrulama sınırı olarak bildir. Canlı erişim veya ücretli pilot yalnız görev kapsamında kullanıcı niyeti varsa çalıştırılır; statik doğrulamayı canlı model erişimi diye sunma.

## Hata ve tekrar

- Bağımlı kontrolleri sırayla yürüt. Bağımsız kontroller çakışan state/ayar kullanmıyorsa paralel olabilir.
- Başarısızlığı izin, şema, ağ, timeout veya regresyon olarak ayır. Kök nedeni düzeltmeden aynı komutu kör tekrarlama; güvenlik/izin hatasında bypass kullanma.
- Düzeltme sonrası etkilenen testleri ve zorunlu kapıları çalıştır. Yeni değişiklik, başarısızlık veya çözülmemiş risk yoksa geçmiş kontrolleri tekrar etme.

## Tamamlanma

Komutları ve sonuçlarını bildir; başarısız veya çalıştırılamayan zorunlu kontrol varsa işi doğrulanmış sayma. Test sayısı yalnız gerçek çıktıda varsa verilir. Prompt, secret, Vault içeriği ve kişisel yollar rapora taşınmaz.
