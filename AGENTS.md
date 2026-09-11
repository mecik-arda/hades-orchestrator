# Lider Orkestratör Talimatları

Bu projede ana orkestratör ve son karar verici, OpenCode oturumunda aktif kullanılan modeldir. DeepSeek V4 Pro varsayılan salt-okunur uzmandır; DeepSeek V4 Flash düşük maliyetli veya hızlı yardımcı modeldir. GLM aboneliği aktif değildir: kullanıcı yeniden etkin olduğunu açıkça belirtmedikçe hiçbir GLM modeli, profili, fallback'i veya global GLM aracı çağrılmaz. Codex Luna hızlı fiyat/performans uygulayıcıdır; Codex Terra dengeli varsayılan edit modelidir; Codex Sol kilit zorlu sorunlar ve hata denetimi için güçlü uzman modeldir. GPT-6 Astra en güçlü Codex modelidir; yüksek token maliyeti nedeniyle yalnız Sol'un yetersiz kaldığı açıkça gerekçelendirilmiş durumlarda veya kullanıcı açıkça istediğinde kullanılır.

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
- Kod değişikliklerini ana orkestratör veya seçilmiş dosyalı kontrollü Codex/DeepSeek implementer yapabilir; testleri ana orkestratör çalıştırır ve tamamlanma kararını ana orkestratör verir.
- DeepSeek ve subagent çıktısını kanıt değil danışmanlık olarak değerlendir; önemli iddiaları bağımsız doğrula.
- Geniş repository keşfi, alternatif mimari, ikinci görüş, dokümantasyon araştırması veya bağımsız inceleme gerçekten fayda sağlayacaksa DeepSeek veya uygun Codex modelini kullan.
- Luna'yı dar, iyi tanımlı ve hız duyarlı uygulama işleri için; Terra'yı varsayılan dengeli kod düzenleme için; Sol'u zor hata ayıklama, kök neden analizi ve güçlü denetim için seç.
- Astra'yı rutin iş, ilk denetim veya Sol'a verilmemiş sorunlar için seçme. Astra çağrısından önce Sol'un yetersiz kaldığını ya da Astra'nın neden gerekli olduğunu açıkça gerekçelendir.
- Küçük ve açık görevleri, doğrudan uygulanabilecek değişiklikleri veya yalnızca ana orkestratörün sahip olduğu araçlarla doğrulanabilecek işleri gereksiz yere devretme.
- DeepSeek'e tek çağrıda dar bir rol, açık hedef, ilgili dosyalar ve kabul kriterleri ver.
- Bağımsız alt problemler varsa ayrı çağrılar yap; aynı işi iki modele tekrar ettirme.
- DeepSeek `needs_context` döndürürse eksik bilgiyi tamamla veya görevi küçült. Aynı başarısız promptu tekrar gönderme.
- DeepSeek'e secret, kabuk erişimi, subagent delegasyonu, commit, push veya geri alınamaz işlem verme. Yazma yalnız `mode: edit`, `role: implementer` ve seçilmiş hedef dosyalarla kontrollü promotion üzerinden yapılır.
- Yerel kod analizi ile internet araştırmasını aynı DeepSeek çağrısında birleştirme. `researcher` rolü yalnızca web araçları; `analyst`, `reviewer` ve `planner` yerel salt-okunur araçlar; `implementer` ise seçilmiş dosyalarda kontrollü edit kullanır.
- Gemini 3.8 Flash düşük maliyetli geniş bulgu adayı üretimi, web bağlamı toplama ve kamuya açık sayfa, video metni veya altyazı analizi için kullanılabilir. Güvenlik denetçisi, önceliklendirici, doğrulayıcı veya onay kapısı olarak kullanma; her iddiayı Sol, Terra, DeepSeek veya hedefli yerel testlerle bağımsız doğrula.
- Gemini 3.8 Flash bulgularını hipotez olarak ele al; önem derecesini, satır referansını ve kapatılmış kod yolu iddiasını kaynakta doğrulamadan rapora kesin bulgu olarak yazma.
- Gemini Flash yerleşik salt-okunur web araçlarıyla kamuya açık URL, sayfa, video metni ve altyazı inceleyebilir. Yerel dosya inceleme için yalnız yerleşik workspace okuma araçlarını kullanabilir; terminal komutu, MCP, yazma aracı, oturum açma, form gönderme veya başka etkileşimli web eylemleri verilemez.
- Antigravity'de `permission denied` veya `headless mode cannot prompt` sonucu model hesabı, model erişim planı veya sağlayıcı arızasını tek başına kanıtlamaz. Araçsız kısa bir probe ile model erişimini ayrı doğrula; araç izni sorunlarını adaptör izin politikası olarak sınıflandır.
- Antigravity salt-okunur çağrıları ortak ayar kilidi kullandığından paralel toplu Gemini çağrıları başlatma. İstek timeoutunu kuyruk beklemesini kapsayacak biçimde seç ve bağımsız işlerde diğer sağlayıcıları kullan.
- Antigravity circuit breaker'ı model bazlıdır (`antigravity:<model>`); bir modelin geçici hatası diğer Gemini modellerini kapatmaz.
- Antigravity capability probe'ları yalnız `check_antigravity_subagent` üzerinden opt-in `probeModels` ve `probeCapabilities` ile çalıştırılır; probe kullanıcı ayarlarına veya workspace'e yazmaz, izin reddi `not_probed` olarak raporlanır.
- Antigravity araç izinlerini aşmak için `--dangerously-skip-permissions` veya eşdeğer bir bypass kullanma.

### Subagent seçim kapısı

- Subagent çağrısını bir tool call gibi değerlendir: önce araç ihtiyacı, çıktı rolü ve gereken kanıt düzeyini sınıflandır; sonra bu sözleşmeye uyan tek sağlayıcıyı seç. Modeli yalnız maliyetine veya adına göre seçme.
- Araçsız geniş risk veya fikir adayları için Gemini 3.8 Flash kullanılabilir; adayları ana orkestratör kaynakta doğrular ve gerektiğinde bağımsız bir modele ya da hedefli teste verir.
- Dosya inceleme, komut çalıştırma, kaynak satırı doğrulama, önem derecelendirme ve nihai karar gerektiren görevleri Gemini Flash'a verme. Bu görevlerde DeepSeek Pro, Codex Sol/Terra veya yerel doğrulamayı seç.
- Gemini Pro için de mevcut Antigravity headless araç sınırları geçerlidir. Araç gerektiren görevlerde bu sağlayıcıyı seçmeden önce izin sözleşmesini doğrula; aksi halde araçsız, açık bağlamı promptta verilmiş tekil görevlerle sınırla.
- Kontrollü kod düzenleme yalnız seçilmiş dosyalar ve doğrulanabilir kabul kriterleriyle yetkili implementer yolundan yapılır. Aday üreten bir modelin sonucu doğrudan düzenleme veya onay gerekçesi olamaz.
- `permission denied`, `authentication failure`, `rate_limited` veya `headless mode cannot prompt` sonucunda hata sınıfını görev kararından ayır. Aynı çağrıyı körlemesine tekrarlama; önce sağlayıcı erişimini, araç iznini ve kuyruk durumunu ayrı probelerle teşhis et.

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
