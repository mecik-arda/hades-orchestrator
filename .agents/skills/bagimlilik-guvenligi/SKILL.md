---
name: bagimlilik-guvenligi
description: Bağımlılık zafiyetlerini denetler, güncelleme riskini sınıflandırır ve güncelleme sonrası regresyonu doğrular; tekrarlanabilir kurulum, lockfile bütünlüğü ve tedarik zinciri güvenliğini korur.
---

# Bağımlılık Güvenliği

Proje bağımlılıklarının güvenlik ve sürüm durumunu denetleyen akış. Amaç, bilinen zafiyetleri görünür kılmak, güncellemeleri kontrollü yapmak ve güncelleme sonrası davranışın bozulmadığını kanıtlamaktır.

## Ne zaman kullanılır

- Yeni bağımlılık eklenmeden veya mevcut sürüm değişmeden önce.
- Zafiyet uyarısı alındığında.
- Kurulum veya kilit dosyası tutarlılığı sorgulandığında.

## Denetim adımları

- `npm audit` ve gerekiyorsa `npm audit --omit=dev` ile zafiyetleri çıkar.
- Her zafiyeti kritik, yüksek, orta ve düşük olarak sınıflandır; üretim ve geliştirme bağımlılığını ayır.
- Zafiyetin gerçekten erişilebilir bir kod yolunda kullanılıp kullanılmadığını değerlendir; yalnız geliştirme bağımlılığı olan bulguyu üretim riski gibi sunma.
- Sürüm aralıklarını ve lockfile bütünlüğünü kontrol et; tekrarlanabilir kurulum için `npm ci` tercih et.
- Doğrudan ve geçişli (transitive) bağımlılığı ayır; düzeltmenin hangi paketi etkilediğini belirt.

## Güncelleme

- Güncellemeyi küçük ve geri alınabilir tut; kırıcı değişiklik riskini önceden değerlendir.
- Güncelleme sonrası `dogrulama-kapisi` skill'indeki temel kapıyı (`npm test`, `npm run verify`, `npm run verify:ci`, `git diff --check`) çalıştır.
- Davranış değişikliği şüphesinde `dogrulama-kapisi` içindeki koşullu kapıları (`npm run smoke`, drill veya pilot) ekle.
- Bilinmeyen veya doğrulanmamış paket ekleme; gerekliyse gerekçesini ve kaynağını belirt.

## Kanıt

- Paket adı, mevcut ve önerilen sürüm, zafiyet derecesi ve önerilen eylem.
- Güncelleme sonrası test ve doğrulama sonuçları.

## Kurallar ve sınırlar

- Bağımlılık kaynağına veya registry'ye secret yazılmaz.
- Otomatik toplu güncelleme yapma; her güncelleme gerekçeli ve doğrulanmış olur.
- Doğrulanmamış zafiyet iddiası kesin bulgu olarak sunulmaz.

## Bitirme koşulu

- Zafiyetler sınıflandırılmış ve önceliklendirilmiştir.
- Uygulanan güncellemeler test ve doğrulama ile kapatılmıştır.
- Kalan riskler ve kabul edilen geçici durumlar açıkça bildirilmiştir.
