---
name: model-saglayici-ekleme
description: Orkestrasyon köprüsüne yeni bir model veya sağlayıcı eklerken kimlik doğrulama, config, allowlist, adapter, MCP şeması, health, test ve canlı pilot adımlarını eksiksiz ve fail-closed biçimde yürütür.
---

# Model ve Sağlayıcı Ekleme

Yeni bir model veya sağlayıcıyı orkestrasyon köprüsüne uçtan uca ekleme ve doğrulama akışı. Amaç, modeli tüm yüzeylerde tutarlı biçimde açmak, uydurma veya desteklenmeyen kimliği sağlayıcıya gitmeden reddetmek ve eklemeyi kanıtla kapatmaktır.

## Ne zaman kullanılır

- Yeni bir model, alias veya sağlayıcı eklendiğinde.
- Mevcut bir model kimliği, allowlist veya varsayılan model değiştiğinde.
- Bir model sağlayıcıda kullanılamıyorsa ve doğru davranışın ne olduğu belirlenecekken.

## Adımlar

### 1. Kimliği doğrula

- Sağlayıcı dokümanı yalnız aday kaynaktır; canonical kimliği yerel katalog (`opencode models`) veya kontrollü canlı probe ile doğrula.
- Araştırma çıktısından gelen kimliği kesin kabul etme; katalogda veya canlı çağrıda doğrulanmayan kimlik uydurma sayılır ve eklenmez.
- Legacy, emekli veya yönlendirilen kimlikleri açıkça ayır; hangisinin canonical olduğunu yaz.

### 2. Config

- Proje şablonu `config/policy.json` ve kişisel çalışma zamanı `~/.config/subagent-bridge/config.json` birlikte güncellenir.
- Varsayılan model ve alias alanlarını tutarlı tut; eski kimliği uyumluluk gerekiyorsa ayrı tut.

### 3. Allowlist

- `config/agents.json` ve kişisel `agents.json` içindeki ilgili sağlayıcı `allowedModels` listesine canonical kimliği ekle.
- Legacy kimliği yalnız geriye uyumluluk için, gerekçesiyle koru.

### 4. Kod eşlemesi

- Sağlayıcı resolver'ı (ör. `deepseek.js`, `glm.js`, `catalog-provider.js`) alias çözümünü kapsar.
- Adapter model haritası ve gerekiyorsa router hedef yönlendirmesi güncellenir.
- Aynı resolver'ın read-only ve edit yollarında kullanıldığını doğrula.

### 5. MCP yüzeyi

- `tools.js` içindeki ilgili `skills`/`model` enum'ları kapalı değerlerle güncellenir; üst sınırlar buna göre artırılır.
- `server.js` araç başlık ve açıklamaları canonical eşlemeyi ve sürümü bildirir.
- Public args'a bridge-owned alan eklenmez.

### 6. Health

- Sağlayıcıya karşılık gelen health aracı (ör. `check_deepseek_subagent`, `check_glm_subagent`, `check_subagent_bridge`) alias, canonical kimlik ve `*Available` alanlarını doğru raporlar.
- Sağlayıcıda bulunmayan model `available: false` kalır ve çağrı fail-closed davranır.

### 7. Testler

- Resolver canonical çözümü ve uydurma kimliğin reddi.
- Allowlist kapısı: yükleme sınırında listelenmeyen model reddedilir.
- MCP şeması: geçerli alias kabul, uydurma alias ve uydurma tam kimlik reddi.
- Health alanlarının canonical kimlikle birlikte değişmesi.

### 8. Canlı doğrulama

- Kontrollü read-only pilot ve gerekiyorsa edit pilotu çalıştır.
- Health çıktısını ve gerçek `resolvedModel` değerini kaydet.
- Edit pilotunda ana workspace değişmediğini ölçülebilir biçimde doğrula: pilot öncesi ve sonrası hedef dosyanın hash'ini veya `git status` çıktısını karşılaştır.

## Kurallar ve sınırlar

- Sağlayıcıya secret, kabuk erişimi, subagent delegasyonu, commit veya geri alınamaz işlem verilmez.
- Doğrulanmamış veya katalogda bulunmayan kimlik eklenmez; gerekiyorsa yalnız yapılandırılmış ve unavailable olarak eklenir.
- Sessiz davranış değişikliği yaratma; kimlik veya varsayılan değiştiyse etkisini açıkça belirt.

## Bitirme koşulu

- Model tüm yüzeylerde tutarlı ve allowlist ile uyumludur.
- Uydurma kimlik hiçbir katmanda kabul edilmez.
- Health doğru raporlar; testler, doğrulamalar ve canlı pilot geçmiştir.
