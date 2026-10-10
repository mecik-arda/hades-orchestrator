---
name: subagent-orkestrasyonu
description: Subagent, alt ajan ve multi-agent batch yönlendirme, koordinasyon veya doğrulama işlerinde kullanılır.
---

# Subagent Orkestrasyonu

## Amaç

Bu skill, tekrar eden subagent seçimi ve çoklu-ajan koordinasyonunda ana orkestratörün karar kapılarını uygular. Hedefi, yetkiyi, kabul kriterlerini ve nihai kararı ana orkestratörde tutar. Küçük ve doğrudan yapılabilir görevlerde alt ajan çağrısı gerektirmez.

## Dispatch öncesi

1. İşi çıktı rolüne ve gereken kanıt düzeyine göre sınıflandır: yerel analiz, web araştırması, bağımsız inceleme, planlama veya kontrollü edit.
2. Kullanıcı hedefini, okunacak/değiştirilecek kapsamı, kabul kriterlerini, erişim modunu ve bitiş koşulunu belirle. Alt ajana yalnız görev için gereken bağlamı ver.
3. Sağlayıcıyı görev araçlarına göre seç; model adını tek başına seçim ölçütü sayma. Sağlık veya katalogda görünen model, çağrının o modelle yürüdüğünü kanıtlamaz.
4. Çağrılabilir araç şemasını incele. Model yalnız gerçek bir `model` alanı, profile veya sabit model kullanan araçla seçilir; prompt içindeki model adı routing parametresi değildir.

## Model ve araç yönlendirmesi

- Bu kurulumda model belirtilmeyen Codex çağrısının varsayılanı `gpt-6.1-sol`'dur. MCP `run_codex_subagent` açık model alır; `sol61_review` profili GPT-6.1-Sol'u seçer. Global OpenCode araçlarında `codex` varsayılan GPT-6.1-Sol, `codexSol61` açık GPT-6.1-Sol, `codexSol6` ise GPT-6-Sol seçimidir. Bu adların mevcut oturumda yüklü olduğunu çağrıdan önce doğrula.
- Başarılı çağrıda `requestedModel`, `resolvedModel`, provider/backend ve erişim modu metadata'sını kontrol et. İstenen ve çözümlenen model farklıysa sonucu istenen modelin çıktısı gibi kullanma; mismatch'i bildir ve gerektiğinde dur.
- `codexSol6` gibi sabit model aracına promptta GPT-6.1 yazmak modeli değiştirmez. Model seçimi için aracı veya tool argümanını düzelt; Bridge adapter'ının modeli bozduğunu kanıt olmadan varsayma.
- GPT-6.1-Sol erişilemiyorsa yalnız politika ve kullanıcı tercihinin izin verdiği açık fallback'i kullan; fallback sonucunu asıl modelin sonucu diye etiketleme.
- GLM aboneliği kullanıcı tarafından yeniden etkinleştirilmedikçe GLM aracı, modeli veya fallback'i çağırma. Astra'yı rutin ilk seçenek yapma; Sol'un yetersiz kaldığı gerekçelendirilmedikçe veya kullanıcı istemedikçe kullanma.

## Rol ve erişim seçimi

- Yerel kaynak analizi için salt-okunur `analyst`, `reviewer` veya `planner` rolü kullan; web araştırması için yalnız web araçları olan `researcher` rolünü seç.
- Gemini 3.8 Flash'ı araçsız aday/hipotez üretimi veya izin verilen kamuya açık web içeriği için kullan. Kaynak incelemesi, doğrulama, önem derecesi kararı veya nihai onay kapısı yapma; iddiaları ana orkestratör kaynakta ya da uygun bağımsız inceleme/testte doğrulasın.
- DeepSeek'e tek çağrıda dar ve kanıtlanabilir rol ver. Skill gerekiyorsa yalnız allowlist'te olanı `skills` alanına ekle; çalışma ağacını erişilebilir workspace olarak yalnız görev gerektiriyorsa seç.
- Edit yalnız yetkili `implementer` rotasında, seçilmiş dosyalar ve ölçülebilir kabul kriterleriyle yapılır. Ana orkestratör diff'i ve testleri doğrular; alt ajana commit, push veya sınırsız workspace yetkisi verme.
- OpenCode/Antigravity paylaşılan ayar kilidi kullanıyorsa aynı sağlayıcıya eşzamanlı istek başlatma. Hata sınıflarını model/erişim/izin/kuyruk problemlerinden ayır ve izin hatasında bypass deneme.

## Çoklu ajan ve batch

- Paralellik yalnız bağımsız alt problemler gerçekten hız veya kapsama kazandırıyorsa kullan; aynı işi farklı modellere tekrarlatma.
- DAG'da her task'a tek rol, açık dosya sahipliği, bağımlılıklar, paylaşılan kaynak claim'leri, kabul kriterleri ve durdurma koşulları ver. Çakışan edit sahipliğini böl veya işi sıralı yürüt.
- `prepare_parallel_batch` yalnız plan üretir. Önizlemeyi kullanıcıya göster; ayrı ve açık kullanıcı onayı olmadan `start_parallel_batch` çağırma. Plan hash'ini koru.
- Başlatılmış batch'i `get_parallel_batch` ile terminal duruma kadar izle; `unknown` tamamlanmış sayılmaz. İptal için açık cancel aracı kullan. Birleşik edit diff'ini onaydan önce oku; approval ve controlled promotion sınırlarını atlama.
- Batch/edit gate'i kapalıysa yapılandırma veya probe sonucuyla kapalı durumu aşma. Live-edit, remote-write veya provider sandbox kanıtını varsayma.

## Sonuç doğrulama ve raporlama

- Worker özetini yapılandırılmış sonuç şeması, kaynak referansları ve kabul kriterlerine göre değerlendir. Önemli model/route, dosya veya hata iddiasını mevcut kod, tool metadata'sı veya hedefli testle doğrula.
- Auth, model erişimi, izin, rate limit, timeout ve schema hatalarını ayrı sınıflandır. Geçici hata sınıflarında bile retry bütçesi/politikasına uy; güvenlik veya yetki hatasında tekrar deneme.
- Kullanıcıya hangi araç/modelin gerçekten çalıştığını, doğrulanan sonucu, kalan belirsizliği ve başarısız/çalıştırılmamış kontrolü kısa biçimde bildir.
- Prompt, secret, session ID, tam transcript veya iç reasoning'i loglama/raporlama. Bridge maliyet metriğini provider faturası gibi sunma.
