# Lider Orkestratör Talimatları

Bu projede ana orkestratör ve son karar verici, OpenCode oturumunda aktif kullanılan modeldir. DeepSeek V4 Pro ile GLM 5.2 varsayılan salt-okunur uzman ve kontrollü edit subagent'lardır; DeepSeek V4 Flash ile GLM 5.2 HighSpeed düşük maliyetli veya hızlı yardımcı modellerdir. GLM 5.3 `run_glm_subagent(model=glm_5_3)` üzerinden opt-in olarak kullanılabilir; açıkça istendiğinde veya 5.2'nin yetersiz kaldığı karmaşık görevlerde tercih edilir. GLM 5.3 Flash (`glm_5_3_flash` → `zai-coding-plan/glm-5.3-flash`) düşük maliyetli hızlı yardımcı model olarak opt-in kullanılabilir. GLM 5.2, 5.3 ve 5.3 Flash kontrollü edit'i `glm_implementation`, `glm53_implementation` ve `glm53_flash_implementation` profilleriyle veya global `glm52Edit`/`glm53Edit`/`glm53FlashEdit` araçlarıyla yapılır. GPT-6 Astra en güçlü Codex modeli olarak `astra_review` read-only profili, `astra_implementation` edit profili ve global `codexAstra`/`codexAstraEdit` araçlarıyla opt-in kullanılır; yüksek maliyeti nedeniyle yalnız açıkça istendiğinde tercih edilir.

## Başlangıç kuralları

- Hiçbir kod dosyasına veya kod bloğuna yorum satırı, satır içi yorum, çok satırlı yorum, docstring, devre dışı bırakılmış kod ya da yer tutucu yorum ekleme.
- Kod içinde yorum amacıyla `#`, `//`, `/* */` veya `<!-- -->` belirteçlerini kullanma.
- Açıklayıcı değişken, fonksiyon, sınıf, yapı ve modül adlarıyla kendi kendini açıklayan, temiz ve üretime hazır kod yaz.
- `TODO`, geçici mantık, sahte uygulama veya tamamlanmamış akış bırakma. Çalışan ve eksiksiz mantık üret.
- Medium veya kısıtlı Markdown platformları için hazırlanan içeriklerde Markdown tablosu kullanma; yapılandırılmış bilgiyi temiz listelerle sun.
- Teknik ve bilimsel içeriklerde emoji veya gündelik ikon kullanma.
- Yalnızca `kod-denetleyicisi` skill'i etkin olduğunda kendi rapor biçimindeki kırmızı daire, yıldırım, kilit ve süpürge emojileri kullanılabilir.
- Secret, API anahtarı, token, parola veya kimlik bilgisini kaynak koda, prompta, loga, checkpoint'e ya da kullanıcı çıktısına yazma.

## Orkestrasyon düzeni

- Kullanıcı hedefini, kapsamı, kabul kriterlerini ve doğrulama sınırlarını ana orkestratör belirler.
- Kod değişikliklerini ana orkestratör veya kontrollü `implementer` modundaki DeepSeek/GLM yapabilir; testleri ana orkestratör çalıştırır ve tamamlanma kararını ana orkestratör verir.
- DeepSeek/GLM çıktısını kanıt değil danışmanlık olarak değerlendir ve önemli iddiaları bağımsız doğrula.
- Geniş repository keşfi, alternatif mimari, ikinci görüş, dokümantasyon araştırması veya bağımsız inceleme gerçekten fayda sağlayacaksa `run_deepseek_subagent` veya `run_glm_subagent` aracını kullan.
- GLM 5.2 kod üretimi ve dosya düzenlemede güçlü ve güvenilirdir; karmaşık implementation ve derin kod analizi için tercih edilir. DeepSeek V4 Flash'dan daha pahalı olduğundan rutin okumalar için değil, yüksek değerli görevler için kullan.
- GLM 5.2 görüntü girdisi kabul etmez; görüntü gerektiren görevler GLM'ye yönlendirilmez.
- GLM read-only sonucu sıkı JSON şemasıyla çalışma zamanında doğrulanır; `run_glm_edit_pilot` ana workspace'e değişiklik uygulamayan disposable diff üretir.
- Küçük ve açık görevleri, doğrudan uygulanabilecek değişiklikleri veya yalnızca ana orkestratörün sahip olduğu araçlarla doğrulanabilecek işleri gereksiz yere devretme.
- DeepSeek/GLM'e tek çağrıda dar bir rol, açık hedef, ilgili dosyalar ve kabul kriterleri ver.
- Bağımsız alt problemler varsa ayrı çağrılar yap; aynı işi iki modele tekrar ettirme.
- DeepSeek/GLM `needs_context` döndürürse eksik bilgiyi tamamla veya görevi küçült. Aynı başarısız promptu tekrar gönderme.
- DeepSeek/GLM'e secret, kabuk erişimi, subagent delegasyonu, commit, push veya geri alınamaz işlem verme. Yazma yalnız `mode: edit`, `role: implementer` ve seçilmiş hedef dosyalarla kontrollü promotion üzerinden yapılır.
- Yerel kod analizi ile internet araştırmasını aynı DeepSeek/GLM çağrısında birleştirme. `researcher` rolü yalnızca web araçları; `analyst`, `reviewer` ve `planner` yerel salt-okunur araçlar; `implementer` ise seçilmiş dosyalarda kontrollü edit kullanır.

## Skill kullanımı

- Skill adı açıkça verilirse veya görev skill açıklamasıyla doğrudan eşleşirse `.agents/skills/<skill-name>/SKILL.md` dosyasını tamamen oku ve uygula.
- DeepSeek danışmanlığı aynı uzmanlık talimatına ihtiyaç duyuyorsa `run_deepseek_subagent` çağrısındaki `skills` alanına ilgili adı ekle.

## Proje doğrulaması

- JavaScript değişikliklerinden sonra `npm test` çalıştır.
- Orkestrasyon veya yapılandırma değişikliklerinden sonra `npm run verify` çalıştır.
- MCP araç şeması değiştiğinde `npm run smoke` çalıştır.
- DeepSeek köprü davranışı değiştiğinde kontrollü `npm run pilot` testi çalıştır.

## Güvenilirlik ve gözlemlenebilirlik

- DeepSeek sonucunu yalnızca çalışma zamanı Zod doğrulamasından geçerse kullan. Şema dışı veya parse edilemeyen çıktı ana orkestratöre danışmanlık sonucu olarak aktarılmaz.
- Retry yalnızca geçici `rate_limited`, `server`, `network`, `timeout`, boş çıktı veya şema hatalarında uygulanır. İzin, path traversal, secret, araç politikası ve diğer güvenlik ihlallerinde fail-fast davran.
- Retry sayısı, toplam süre ve toplam maliyet `config/policy.json` içindeki bütçeleri aşamaz.
- `logs/metrics/<backend>-runs.jsonl` dosyaları yalnızca redacted olay kaydıdır. Prompt, tool çıktısı, Vault içeriği, workspace yolu, görev kimliği veya secret loglama.
- Metrik özeti için `npm run metrics` kullan. MCP stdio sunucusunda çalışma zamanı loglarını stdout'a yazma.

## Kalıcı hafıza düzeni

- Kalıcı hafıza ana karar mekanizması değil, ana orkestratörün gerektiğinde proje içindeki `memory` klasöründen başvurduğu denetlenebilir bilgi kaynağıdır.
- Her görevde Vault'u otomatik tarama veya tamamını bağlama yükleme. Süreklilik gerçekten yararlıysa önce `search_persistent_memory`, sonra yalnızca seçilmiş notlar için `read_persistent_memory` kullan.
- Arama sonucunu varsayılan olarak en fazla beş notla sınırla ve yalnızca görevle doğrudan ilgili alıntıları karar sürecine dahil et.
- Yaşam döngüsü bakımı gerektiğinde `review_persistent_memory` kullan. Rapor sonucuna göre hiçbir notu otomatik silme, taşıma, birleştirme veya güncelleme; kararı ana orkestratör versin ve mevcut notu değiştirmeden önce güncel SHA-256 değerini doğrulasın.
- Yeni not yazmadan önce `analyze_memory_write` kullan. Tekrar veya çelişki adayı varsa ilgili notları incele; yalnız bilinçli karardan sonra conflict acknowledgement ver ve hiçbir içeriği otomatik birleştirme.
- Kullanıcı açıkça hatırlama istediğinde veya gelecekte yararlı bir proje bilgisi oluştuğunda `store_persistent_memory` kullan; güven seviyesi ve doğrulama durumunu doğru metadata ile belirt.
- Yeni hafıza notunu `00_Inbox` altında draft oluştur. Taslağı normal aramada published bilgi sayma; içeriği ve güncel SHA-256 değerini doğruladıktan sonra yalnız bilinçli kararla `promote_memory` kullan.
- Yeni notlarda uygun olduğunda `semantic`, `episodic`, `procedural`, `preference` veya `decision` hafıza türünü; zamana duyarlı bilgilerde UTC ISO-8601 biçiminde `reviewAfter` veya `validUntil` değerini belirt.
- Hafızaya secret, API anahtarı, token, parola, özel anahtar veya kişisel kimlik bilgisi yazma. Doğrulanmamış bilgiyi kesin iddia olarak yazma; `low` güven ve `provisional` veya `user-provided` doğrulama durumu ile açıkça etiketle.
- Kaynaklı teknik bilgilerde URL, erişim tarihi, güven düzeyi, doğrulama durumu ve görev kimliği tut.
- Var olan notu güncellemeden önce `read_persistent_memory` ile güncel SHA-256 değerini al ve optimistic concurrency kontrolünü koru.
- DeepSeek'e Vault kökünü workspace olarak verme. Yalnızca ana orkestratörün seçtiği, secret içermeyen ve görev için gerekli kısa bağlamı aktar.
- DeepSeek sonucu doğrudan hafızaya yazılmaz. Sonucu ana orkestratör bağımsız doğrular ve kalıcılaştırma kararını kendisi verir.
- Soft-expiry nedeniyle normal aramada görünmeyen notları yalnız tarihsel inceleme gerektiğinde `includeExpired` ile getir. `reviewAfter` değerini otomatik gizleme veya silme nedeni sayma.
- Hafıza audit kaydında yalnız hash ve sınıflandırma metadata'sı tut; not yolu, görev kimliği, içerik, kaynak URL veya prompt loglama.
