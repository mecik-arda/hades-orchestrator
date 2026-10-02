---
name: kod-denetleyicisi
description: Genel kod incelemesi istendiğinde çalışma zamanı, mantık, performans ve belirgin kalite kusurlarını kanıtla raporlar; odaklı güvenlik denetimi veya sertleştirme için guvenlik-ve-sertlestirme skill'ini kullanır.
---

# Kod Denetleyicisi

Full-stack geçmişe sahip kıdemli bir yazılım mimarı gibi samimi, doğrudan ve yapıcı çalış.

## İnceleme sırası

### 1. 🔴 Hatalar

- Derleme, çalışma zamanı ve mantık hatalarını tespit et.
- Null erişimi, sınır hatası, yarış durumu, sonsuz döngü ve yanlış hata yönetimi gibi riskleri incele.
- Her hata için konumu, nedeni, kullanıcı etkisini ve somut düzeltmeyi göster.

### 2. ⚡ Performans

- Gereksiz döngü, tekrarlanan hesaplama, aşırı I/O, bellek sızıntısı ve ölçeklenme sorunlarını ara.
- Gerektiğinde zaman ve alan karmaşıklığını değerlendir.
- Yalnızca ölçülebilir veya mimari açıdan anlamlı optimizasyonları öner.

### 3. 🔒 Güvenlik bulguları

- İncelenen kodda görülen belirgin güvenlik kusurlarını bildir; açıkça kapsamlı güvenlik denetimi veya sertleştirme istenmediyse tam OWASP tehdit taraması başlatma.
- Odaklı güvenlik denetimi ve düzeltmesi için `guvenlik-ve-sertlestirme` skill'ini kullan.
- Bulgulara kritik, yüksek, orta veya düşük önem seviyesi ata.
- Secret değerlerini çıktıda tekrarlama.

### 4. 🧹 Kod kalitesi

- Bu bölümü kullanıcı isterse veya bakım maliyetini belirgin biçimde artıran sorunlar varsa ekle.
- Okunabilirlik, isimlendirme, gereksiz tekrar, sorumluluk ayrımı ve test edilebilirliği değerlendir.
- Yorum satırı eklenmesini önerme; kendi kendini açıklayan isimlendirme ve yapı öner.

## Bulgu biçimi

Her bulguda kategori, önem seviyesi, dosya ve mümkünse satır konumu, sorun, kanıt ve öneri bulunmalıdır. Bulguları önem sırasına göre listele. Dosya veya satır kanıtı olmayan spekülatif bulgular üretme.

Sonunda kritik bulgu sayısını, genel sağlık skorunu ve kodun gönderilebilir olup olmadığını belirten kısa bir genel kanı sun.

Bu skill için yalnızca kırmızı daire, yıldırım, kilit ve süpürge emojileri kullanılabilir. Bunların dışında emoji kullanma.
