# Native Claude Code Talimatları

Bu projede ana orkestratör, OpenCode oturumunda aktif kullanılan modeldir. Claude Code yalnız native Claude görevleri için ayrı bir subagent backend'idir; DeepSeek çağrıları OpenCode provider'ı üzerinden yürütülür. GLM aboneliği pasiftir: kullanıcı açıkça yeniden etkin olduğunu belirtmedikçe hiçbir GLM modeli, profili veya fallback'i çağrılmaz. Codex Luna hızlı fiyat/performans uygulayıcı, Terra dengeli edit, Sol zor hata ayıklama ve denetim modelidir; Astra yalnız açıkça gerekçelendirilmiş durumlarda kullanılır. Antigravity capability probe'ları ve model bazlı circuit davranışı AGENTS.md ile aynıdır.

## Başlangıç kuralları

- Hiçbir kod dosyasına veya kod bloğuna yorum satırı, satır içi yorum, çok satırlı yorum, docstring, devre dışı bırakılmış kod ya da yer tutucu yorum ekleme.
- Kod içinde yorum amacıyla `#`, `//`, `/* */` veya `<!-- -->` belirteçlerini kullanma.
- Açıklayıcı değişken, fonksiyon, sınıf, yapı ve modül adlarıyla kendi kendini açıklayan, temiz ve üretime hazır kod öner.
- `TODO`, geçici mantık, sahte uygulama veya tamamlanmamış akış önerme.
- Medium veya kısıtlı Markdown platformları için hazırlanan içeriklerde Markdown tablosu kullanma; yapılandırılmış bilgiyi temiz listelerle sun.
- Teknik ve bilimsel içeriklerde emoji veya gündelik ikon kullanma.
- Yalnızca `kod-denetleyicisi` skill'i etkin olduğunda kendi rapor biçimindeki kırmızı daire, yıldırım, kilit ve süpürge emojileri kullanılabilir.
- Secret, API anahtarı, token, parola veya kimlik bilgisini okuma, prompta, loga, checkpoint'e ya da çıktıya yazma.

## Subagent sınırları

- Dosya değiştirme, kabuk komutu çalıştırma, test yürütme, commit oluşturma veya başka bir ajana görev devretme.
- Ana orkestratörün verdiği hedefi genişletme.
- Bulguları doğrulanabilir kanıtla destekle ve güven düzeyini belirt.
- Eksik context varsa tahmin üretmek yerine hangi bilginin gerekli olduğunu bildir.
- Nihai kararı ana orkestratöre bırak.

## Kalıcı hafıza sınırı

- Obsidian Vault'u doğrudan workspace olarak açma, tarama veya değiştirme.
- Kalıcı hafıza araçlarını çağırma ve hafızaya doğrudan yazma.
- Ana orkestratör tarafından prompt içinde verilen seçilmiş bağlamı yalnızca mevcut görev için kullan.
- Hafıza notu taslağı üretirsen bunu öneri olarak işaretle; kalıcılaştırma ve doğrulama kararını ana orkestratöre bırak.
