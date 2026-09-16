---
name: mcp-sozlesme-denetimi
description: MCP araç şemalarını ve sözleşmelerini denetler; strict şema, kapalı enum, limit tutarlılığı, bridge-owned alan sızıntısı, açıklama uyumu ve handler dönüş biçimini kanıta dayalı olarak kontrol eder.
---

# MCP Sözleşme Denetimi

Orkestrasyon köprüsünün MCP araç yüzeyini denetleyen akış. Amaç, public sözleşmeyi dar ve tutarlı tutmak, iç alanların dışarıdan enjekte edilmesini engellemek ve şema değişikliklerinin testlerle kapsanmasını sağlamaktır.

## Ne zaman kullanılır

- Yeni bir MCP aracı eklendiğinde veya mevcut araç değiştiğinde.
- Bir enum, limit veya açıklama güncellendiğinde.
- Public args ile iç alanların karıştığı şüphesi olduğunda.

## Denetim maddeleri

- Her kayıtlı araç için `inputSchema` strict mi; tanımsız alan reddediliyor mu.
- Enum değerleri kapalı ve güncel mi; alias adları küçük harf ve tek tire kuralına uyuyor mu.
- Sayısal limitler (min, max, süre, dizi üst sınırı) tutarlı mı ve kod tarafıyla eşleşiyor mu.
- Bridge-owned alanlar (backend, workspace, caller, delegationDepth, modePolicy, metricBackend) public args'tan enjekte edilemiyor mu.
- Public args iç alanları ezemiyor mu; handler yalnız doğrulanmış alanları runtime'a aktarıyor mu.
- Araç açıklaması ile şema uyumlu mu; açıklama gerçek davranışı ve canonical kimlikleri yansıtıyor mu.
- Handler dönüşü tutarlı mı: hata durumunda `isError: true`, `content` metni ve `structuredContent` aynı sonucu mu taşıyor.
- Read-only ve edit araçlarında mod kısıtı ve dosya zorunluluğu doğru mu.

## Şema değişince

- `npm run smoke` çalıştırılır.
- İlgili şema testleri (public args reddi, enum kabul/red) güncellenir veya eklenir.
- Enum veya limit değiştiyse `tools.js` ve `server.js` birlikte güncellenir.

## Kanıt

- Hangi araç, hangi alan, hangi dosya ve satır; ihlal varsa somut düzeltme.
- Bulguları kritik, orta ve düşük olarak önceliklendir.

## Kurallar ve sınırlar

- Denetim salt okunurdur; şema dosyası bu skill içinde değiştirilmez.
- Secret veya gerçek çağrı çıktısı rapora yazılmaz.
- Doğrulanmamış iddia kesin bulgu olarak sunulmaz.

## Bitirme koşulu

- Tüm araç şemaları strict ve tutarlıdır; bridge-owned alan sızıntısı yoktur.
- Şema değişiklikleri test ve smoke ile kapsanmıştır.
- Açık kalan riskler önceliklendirilerek bildirilmiştir.
