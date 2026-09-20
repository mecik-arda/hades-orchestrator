# Ortak Başlangıç Kuralları

- Hiçbir kod dosyasına veya kod bloğuna yorum satırı, satır içi yorum, çok satırlı yorum, docstring, devre dışı bırakılmış kod ya da yer tutucu yorum ekleme.
- Kod içinde yorum amacıyla `#`, `//`, `/* */` veya `<!-- -->` belirteçlerini kullanma.
- Açıklayıcı değişken, fonksiyon, sınıf, yapı ve modül adlarıyla kendi kendini açıklayan, temiz ve üretime hazır kod yaz.
- `TODO`, geçici mantık, sahte uygulama veya tamamlanmamış akış bırakma. Çalışan ve eksiksiz mantık üret.
- Medium veya kısıtlı Markdown platformları için hazırlanan içeriklerde Markdown tablosu kullanma; yapılandırılmış bilgiyi temiz listelerle sun.
- Teknik ve bilimsel içeriklerde emoji veya gündelik ikon kullanma.
- Yalnızca `kod-denetleyicisi` skill'i etkin olduğunda kendi rapor biçimindeki kırmızı daire, yıldırım, kilit ve süpürge emojileri kullanılabilir.
- Secret, API anahtarı, token, parola veya kimlik bilgisini kaynak koda, prompta, loga, checkpoint'e ya da kullanıcı çıktısına yazma.
- Yalnızca görevin kapsamındaki dosyaları değiştir ve kullanıcıya ait ilgisiz değişiklikleri koru.
- Değişiklikten önce ilgili dosyaları ve proje talimatlarını oku.
- Görevi tamamlamadan önce uygun testleri ve doğrulamaları çalıştır.
- Test edilemeyen bir davranışı doğrulanmış gibi raporlama.
- Geri alınamaz işlem, üretim erişimi, secret aktarımı, toplu silme, dış sisteme mesaj veya ödeme için insan onayı iste.

## M2 Hook Geri Bildirimi

- Hook geri bildirimi proje veya görev başarısını değil, gerçek bağlam enjeksiyonu yapılan tek bir session'ın `useful`, `partial` veya `not_useful` sonucunu ölçer.
- Başka session etiketlenebilir; ancak gerçek `memory_hook_session` kaydı, doğru istemci ve gerçek session ID zorunludur.
- Önce `hook:classify` ile `eligible_real_user`, sonra `hook:feedback` ile sonuç kaydedilir; `--session-id` olmadan komut çalıştırılmaz.
- Session kaydı yoksa retroaktif ID, süre, uygunluk veya sentetik session üretilmez; gözlem M2 sayacına alınmaz.
