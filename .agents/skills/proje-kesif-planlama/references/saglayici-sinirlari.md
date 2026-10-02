# Sağlayıcı ve Rol Sınırları

Yalnız seçilen rotanın bölümünü kullan. Sağlayıcı tercihi araç sözleşmesi, görev ve gereken kanıta bağlıdır.

## Yerel inceleme

- DeepSeek Pro derin yerel analiz, Flash dar ve hızlı yerel analiz için seçilebilir. Önce `check_deepseek_subagent` ile erişimi kontrol et. `analyst`, `reviewer`, `planner` yalnız yerel salt-okunur araçları kullanır; web araştırması aynı çağrıya eklenmez.
- Codex salt-okunur inceleme için `run_codex_subagent` kullanır. Zor incelemede `gpt-6.1-sol`, dar hızlı işte `gpt-6-luna` seçilebilir. Kontrollü plan yazımı `codexLuna6Edit` veya uygun edit profiliyle yalnız seçili tek dosyada yapılır.
- Secret, subagent delegasyonu, commit, push veya geri alınamaz işlem verilmez. DeepSeek'e kabuk/test yürütme yetkisi ve Vault workspace'i verilmez.

## Gemini web ve aday üretimi

- Gemini 3.8 Flash kamuya açık web kaynakları veya araçsız aday üretimi için kullanılabilir; yerel dosya arama, shell, MCP, önem derecelendirme ve nihai doğrulama görevi verilmez.
- Web araştırması öncesi `check_antigravity_subagent` ile `probeModels: ["gemini_flash_3_8"]`, `probeCapabilities: ["modelAccess", "webRead"]` kullan. Web erişimi yoksa sonucu web araştırması sayma.
- Her dış iddia için URL, yayıncı/başlık, görünür tarih ve destekleyen kısa alıntı iste. Ana orkestratör kaynakları doğrudan açıp doğrular.
- Antigravity çağrıları ortak ayar kilidi nedeniyle seri yürütülür; timeout kuyruk beklemesini kapsar. İzinleri bypass etme.

## Space Bunny

- Yalnız kullanıcı açıkça seçtiğinde web araştırması için kullan. `check_space_bunny_subagent` katalog ve sıfır fiyatı doğrular; auth veya canlı erişimi kanıtlamaz.
- `run_space_bunny_subagent` researcher/read_only/webResearch=true rotası boş OS-temp workspace'te yalnız web araçları kullanır. Repo, Vault, shell veya yerel alıntı verilmez.
- Kaynakları ana orkestratör doğrular. Varsayılan, otomatik fallback veya onay kapısı yapma; canlı canary ayrı kullanıcı onayı gerektirir.

## Hata ve fallback

- Retry yalnız policy bütçelerindeki geçici hata sınıfları içindir. Auth, izin, güvenlik, araç politikası ve açık circuit hatalarında aynı çağrıyı kör tekrarlama. `needs_context` için bağlamı tamamla veya görevi daralt.
- Timeout sonrası kullanıcı istemedikçe timeoutu yükselterek aynı görevi tekrar gönderme. Kapsamı küçültmek yeni bir görevdir; önce başarısızlığı ve eksik kanıtı kaydet.
- DeepSeek yerel incelemesi çalışmazsa ana orkestratör yerel kaynakları inceleyebilir. Gemini'den aday almak gerçekten yararlıysa yalnız seçilmiş, secret içermeyen kısa alıntılar ver; workspace veya web görevi ekleme. Önce modelAccess ve toolFreeResponse problarını doğrula. Sonuç yerel incelemenin yerine geçmez.
- Kullanıcının istediği sağlayıcı incelemesini başka rota veya kendi incelemenle yapılmış sayma. Kullanıcı açıkça fallback istemedikçe named-provider görevi başarısızlığıyla raporlanır.
