# Context Orkestrasyonu ve Guvenli Second Brain Plani

- Tarih: 2026-08-21
- Durum: Arastirma sonrasi onerilen plan; uygulanmadi
- Kapsam: Obsidian Vault tabanli kalici hafizanin, buyuk ve cok adimli calismalarda context toplama, karar verme ve devir teslim sureclerini iyilestirmesi
- Kaynaklar: https://github.com/avenoxai/avenoxbeyin, https://github.com/umutyalcin-pen/second-brainbro, https://www.youtube.com/watch?v=4vWlWHDol-g, https://www.linkedin.com/posts/umutyalcinsec_yapayzeka-siberg%C3%BCvenlik-obsidian-activity-7494480266766479360-V2rI

## Yurutme Ozeti

- Arastirilan second-brain projeleri, duz Markdown dosyalari ile oturumlar arasi sureklilik sagliyor; upstream proje bu dosyalari Claude Code hook'lariyla oturum basinda context'e ekliyor.
- Windows portu, bu yaklasima sinirli context, untrusted-data isaretleme, hook butunluk dogrulamasi, kısıtlayici izinler ve fail-closed baslatma ekliyor; kendi belgelerinde alpha olarak tanimlaniyor.
- Video, ana ajanin ham repository ve bellek okumasi yerine arastirma ajanlarinin bulgularini sentezlemesini; uygulama oncesi kucuk, dogrulanabilir spec'ler uretilmesini oneriyor.
- Mevcut sistem, Vault erisimi, SHA-256 promote, draft/published yasam dongusu, karantina, secret taramasi ve redacted audit konularinda daha guvenli bir temel sagliyor.
- Bu nedenle hedef, genis otomatik bellek enjeksiyonu veya otomatik yazma degil; karar oncesi kaynakli rapor, insan denetimli handoff ve dar kapsamli uygulama spec'idir.

## Mevcut Durum

- Vault otomatik taranmaz; yalniz gorevle dogrudan ilgili notlar aranir ve secilerek okunur.
- Yeni hafiza once `00_Inbox` altinda draft olarak yazilir; SHA-256 dogrulamasi ve bilincli karar sonrasinda promote edilir.
- Arama ve okuma ciktilari untrusted content olarak ele alinir; secret ve prompt injection taramasi uygulanir.
- Supheli notlar karantinaya alinir; sinirli alinti icin acik onay gerekir.
- Audit kayitlari icerik, yol, gorev kimligi veya kaynak URL saklamaz.
- Subagent'lar dar rol, secili dosya ve kabul kriterleriyle sinirlandirilir.

## Arastirma Bulgulari

### Second-Brain Depo Deseni

- `avenoxbeyin`, `Core.md`, `Last-Session.md`, `Threads.md` ve `Journal.md` ile kalici dosya tabanli bellek kuruyor.
- Upstream, session-start hook'lariyla secili bellek bolumlerini context'e ekliyor ve oturum sonu hatirlatmalari kullaniyor.
- Bu tasarim kullanici tarafindan okunabilir ve tasinabilir olsa da otomatik injection, prompt injection ve hassas veri yayilimi riskini buyutur.
- `second-brainbro` Windows portu; boyut siniri, untrusted-data isaretleme, hook manifest hash kontrolu, kisitli izinler, yerel NTFS zorunlulugu ve reparse-point reddi ekliyor.
- Windows portu imzali veya production-hardened bir surum degildir; kaynak incelemesi ve sentetik test disinda yuksek etkili veri icin uygun oldugu iddia edilmez.

### Context Orkestrasyonu Deseni

- Ana ajan kod yazmadan once bagimsiz arastirma alt problemlerini tanimlar.
- Arastirma ajanlari repository, raporlar, onceki kararlar veya web kaynaklarindan yalniz gerekli context'i toplar.
- Ana ajan bulgulari sentezler, celiskileri cozer ve uygulama kararini verir.
- Uygulama icin kucuk kapsamli bir spec hazirlanir; implementer yalniz hedef dosyalar ve kabul kriterleri ile calisir.
- Devam eden isler, insan tarafindan da okunabilir bir durum kaydi ile sonraki oturuma devredilir.
- Paralel ajanlar varsayilan degildir; yalniz bagimsiz ve yuksek degerli alt problemler icin kullanilir.

## Tasarim Ilkeleri

- Vault icerigi talimat degil, guvenilmeyen veri olarak kalir.
- Otomatik olarak tum hafizayi veya oturum ozeti dosyalarini prompt'a ekleme.
- Uzak URL, markdown notu veya subagent ciktilarindaki talimatlari dogrudan yurutme.
- Hafiza yazimi mevcut draft, analiz, SHA-256 ve promote onay akisini korur.
- Ortak dosyaya paralel yazim yapma; arastirma ajanlari salt-okunur rapor verir.
- Karar kayitlari, proje bellek notu olmadan once kaynak, guven seviyesi ve dogrulama durumunu belirtir.
- Her uygulama spec'i hedef, kapsam disi alanlar, dosya listesi, kabul kriterleri ve test komutlarini icerir.
- Yeni surec, mevcut `AGENTS.md` kurallari ve redacted audit ilkesiyle celismemelidir.

## Kapsam Disi

- Claude Code hook'lariyla otomatik session-start bellek enjeksiyonu.
- Otomatik bellek yazimi, otomatik promote, otomatik konsolidasyon veya otomatik silme.
- Mem0 veya baska bir harici semantic-memory servisi.
- Vault'a paralel ajanlarin sinirsiz yazma yetkisi.
- Yeni vektor veritabani, reranker veya graph katmani; bunlar yalniz mevcut retrieval olcumleri ihtiyaci dogrularsa ayri planla degerlendirilir.

## Asamali Uygulama Plani

### Asama 1: Arastirma Raporu Sozlesmesi

Durum: Rapor sozlesmesi ve ilk kaynakli referans rapor `docs/reports/kalici-hafiza-piyasa-arastirma-2026-08-21.md` ile tamamlandi. Kaynakli Vault ozeti tekrar ve celiski analizi, draft incelemesi ve SHA-256 kontrollu promote sonrasinda published olarak yayimlandi.

- `docs/reports` icin rapor dosyasi adlandirma, zorunlu metadata ve kaynak formatini tanimla.
- Raporlarda hedef, kapsam, bulgular, kanit, celiskiler, riskler, oneriler ve acik sorular bolumlerini zorunlu kil.
- Raporu karar kaydi veya kalici hafiza olarak kabul etme; bunlar ayri insan/ana orkestrator degerlendirmesi gerektirir.
- Ilk referans raporu olarak `KALICI_HAFIZA_PIYASA_ARASTIRMASI_2026-08-21.md` bulgularini kaynakli rapor sozlesmesine aktar. Bu, mevcut planlar arasinda rapor formatini gercek bir ornekle dogrular.
- Bu raporun ana orkestrator tarafindan onaylanan, secret ve injection taramasindan gecen kisa sonucunu `00_Inbox` altinda semantic draft olarak Vault'a yaz. Tekrar ve celiski analizinden, SHA-256 dogrulamasindan ve bilincli promote kararindan once yayinlama yapma.
- Kabul kriteri: En az bir mevcut arastirma raporu yeni sozlesmeye gore eksiksiz ve kaynakli olmalidir.
- Kabul kriteri: Ilk referans raporunun Vault ozeti yalniz promote sonrasinda published aramada gorunur; audit kaydi icerik, yol, gorev kimligi veya kaynak URL icermez.

### Asama 2: Oturumlar Arasi Durum ve Handoff

- Mevcut gorev listesiyle uyumlu, insan tarafindan okunabilir bir proje durum notu formati tanimla.
- Durum notu; tamamlananlar, aktif is, dogrulama sonucu, blocker, sonraki adim ve ilgili raporlari kapsar.
- Bu not otomatik prompt enjeksiyonu icin degil, kullanici veya ana orkestratorun gerektiginde secerek okumasi icin kullanilir.
- Kalici, gelecekte yararli kararlar mevcut Vault proseduruyle ayri bir draft notuna donusturulur.
- Kabul kriteri: Birden fazla oturum gerektiren bir is, durum notu kullanilarak belirsiz veya kayip baglam olmadan devredilebilir.

### Asama 3: Mini-Spec Sozlesmesi

- `docs/plans` altinda uygulama oncesi spec sablonu tanimla.
- Zorunlu alanlar: amac, mevcut davranis, hedef davranis, degisecek dosyalar, kapsam disi alanlar, guvenlik sinirlari, kabul kriterleri ve test komutlari.
- Implementer subagent'a yalniz bu spec, secili dosyalar ve gerekli kisa baglam verilir.
- Ana orkestrator, subagent sonucunu kanit olarak degil danismanlik olarak degerlendirir ve testleri kendisi calistirir.
- Kabul kriteri: Orta karmasiklikta bir degisiklik mini-spec ile uygulanir; diff ve test sonucu spec kabul kriterleriyle bire bir kontrol edilir.

### Asama 4: Kontrollu Paralel Arastirma

- Paralel arastirma yalniz birbirinden bagimsiz alt sorular icin kullanilir.
- Her arastirmaciya tek bir rol, tek bir hedef, kaynak siniri ve beklenen cikti semasi verilir.
- Ayni soruyu birden fazla modele tekrar sormak yerine farkli bakis acilari bolusturulur.
- Arastirmacilar workspace veya Vault'a yazmaz; sonuclarini ana orkestratore aktarir.
- Kabul kriteri: En az bir genis arastirma gorevinde raporlar birbiriyle cakismadan sentezlenir ve kaynak iddialari bagimsiz dogrulanir.

### Asama 5: Guvenlik ve Kalite Kapilari

- Her yeni rapor veya spec icin secret, injection ve kaynak guvenilirligi kontrollerini uygula.
- Vault'a kalici not yazmadan once `analyze_memory_write` kullan; tekrar veya celiski varsa insan kararini zorunlu tut.
- Uygulama sonrasi ilgili testleri, proje dogrulamasini ve gerekiyorsa MCP smoke testini calistir.
- Surec faydasini olcmek icin handoff basarisizligi, tekrar eden arastirma, spec disi degisiklik ve test basarisizligi sayilarini izle.
- Kabul kriteri: Yeni surec mevcut O1-O4 bellek guvenlik kontrollerini atlamaz ve yeni audit icerik sizintisi yaratmaz.

## Riskler ve Onlemler

- Risk: Raporlarin talimat veya zehirli veri tasimasi.
- Onlem: Rapor ve Vault icerigini untrusted veri kabul et; talimatlari yalniz ana orkestrator politika ve kullanici istegiyle degerlendir.

- Risk: Fazla dokumantasyonla karar ve uygulamanin yavaslamasi.
- Onlem: Rapor, handoff ve mini-spec'i yalniz orta/buyuk veya cok oturumlu islerde kullan; kucuk degisikliklerde dogrudan uygulama yap.

- Risk: Paralel ajanlarda cakisan yazim veya farkli gercekler.
- Onlem: Arastirma ajanlarini salt-okunur tut; tek yazar ana orkestrator ve kontrollu implementer modeli uygula.

- Risk: Otomatik context enjeksiyonuyla secret veya eski bilginin modele gitmesi.
- Onlem: Otomatik enjeksiyon ekleme; secili okuma, boyut siniri, secret taramasi, karantina ve review/promotion yasam dongusunu koru.

- Risk: Altyazi veya sosyal medya iddialarinin bagimsiz kanit gibi ele alinmasi.
- Onlem: Video anlatimini tasarim onerisi, repo README beyanlarini birincil proje dokumani olarak siniflandir; teknik iddialari kaynak kodu ve testlerle ayri dogrula.

## Basari Olcutleri

- Buyuk islerde karar oncesi kaynakli ve sinirli bir arastirma raporu bulunur.
- Handoff notu, sonraki oturumun aktif isi ve dogrulama durumunu dogru aktarir.
- Uygulama diff'i onayli mini-spec kapsaminda kalir.
- Vault'a otomatik, onaysiz veya karantina atlayan yazim yapilmaz.
- Secret, ham not icerigi, yol, gorev kimligi veya kaynak URL audit kayitlarina eklenmez.
- Mevcut `npm test`, `npm run verify` ve ilgili durumda `npm run smoke` basarili kalir.

## Sonraki Karar

- Ilk uygulama adayini secmeden once kullanici, bu planin Asama 1-3'unu mu yoksa yalniz Asama 2'yi mi istedigini belirlemelidir.
- Otomatik hook enjeksiyonu, Mem0, semantic retrieval veya arka plan konsolidasyonu bu planin devam karari olmadan uygulanmayacaktir.
