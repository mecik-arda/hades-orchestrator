---
name: proje-kesif-planlama
description: Yeni bir projeye veya büyük bir göreve başlamadan önce Gemini 3.8 Flash ve DeepSeek Flash'ı kapasitelerine göre birlikte, uygun salt-okunur rota varsa GPT Luna ile kısa araştırma yaparak keşif yürütür, doğrulanabilir plan belgesini GPT Luna edit ile seçili tek dosyaya yazdırır ve planı Sol denetiminden geçirir.
---

# Proje Keşif ve Planlama

Yeni bir projeye, büyük bir özelliğe veya belirsiz kapsamlı bir göreve kod yazmadan önce çalıştırılan keşif ve planlama akışı. Amaç, düşük maliyetli hızlı modellerle geniş keşif yapmak, bulguları bağımsız doğrulamak, uygulanabilir bir plan üretmek ve planı güçlü bir denetimden geçirmektir.

## Ne zaman kullanılır

- Kullanıcı yeni bir proje, yeni bir ürün veya geniş kapsamlı bir geliştirme istediğinde.
- Kapsam, mimari, teknoloji seçimi veya kabul kriterleri belirsizken.
- Kod yazmaya başlamadan önce araştırma ve plan onayı gerektiğinde.

Küçük, kapsamı net ve doğrudan uygulanabilir görevlerde bu skill kullanılmaz.

## Rol ve model eşlemesi

- Gemini 3.8 Flash: geniş web ve bağlam keşfi, kamuya açık sayfa ve doküman taraması, aday bulgu üretimi. Araç: `run_antigravity_subagent(model=gemini_flash_3_8)`, salt okunur. Prompt'u kısa tut ve uzun bağlamı parçalara böl. Aynı daraltılmış dış araştırma alt sorusunda `timeout` olarak sınıflandırılmış iki ardışık Gemini Flash sonucu alınırsa ikinci denemeden önce promptu küçült; toplam süre ve maliyet bütçesi uygunsa ve Gemini Pro rotası ile salt-okunur yetenekler doğrulanmışsa araştırmayı Gemini Pro'ya yükselt ve sınırlama olarak kaydet. İzin, kimlik doğrulama, rate-limit ve araç politikası hataları timeout sayılmaz.
- DeepSeek Flash: yerel repository analizi, yapılandırılmış bulgular, sınır ve risk tespiti. Araç: `run_deepseek_subagent(model=deepseek_flash, mode=read_only)`.
- GPT Luna: iki rol. (a) Opsiyonel hızlı araştırma: dar ve iyi tanımlı sorular, salt okunur; araç `run_codex_subagent(model=gpt-5.6-luna)`. Salt-okunur rota yoksa bu adımı atla ve sınırlama olarak kaydet. (b) Plan belgesi yazımı: kontrollü edit; araç `codexLunaEdit`, yalnız seçili tek plan dosyası ve açık kabul kriterleriyle.
- Sol: plan denetimi ve nihai teknik değerlendirme. Araç: `run_codex_subagent(model=gpt-5.6-sol)`, salt okunur.

Çağrılardan önce erişilebilirliği `check_subagent_bridge` ve ilgili `check_*` aracıyla doğrula; rota yoksa adımı atla ve sınırlamayı kaydet.

Gemini 3.8 Flash ve DeepSeek Flash birbirinin alternatifi değildir; keşif aşamasında birlikte çalıştırılır ve her biri kendi kapasitesine göre kullanılır. Gemini 3.8 Flash dış ve kamuya açık bağlamı toplar; DeepSeek Flash yerel repository gerçeğini ve yapılandırılmış bulguları üretir. İkisinin çıktısı tek planda birleştirilir; birinin diğerinin yerine geçmesi veya yalnız biriyle keşfin bitirilmesi beklenmez.

GLM aboneliği pasif olduğundan hiçbir GLM modeli, profili veya fallback'i çağrılmaz.

## Aşamalar

### 1. Keşif

- Önce hedefi, kapsamı, kısıtları ve açık soruları yazılı hale getir.
- Araştırmayı bağımsız alt sorulara böl; aynı işi iki modele tekrar ettirme.
- Gemini 3.8 Flash'a yalnız web ve bağlam toplama görevi ver; dosya inceleme, komut çalıştırma, kaynak satırı doğrulama veya karar verme görevi verme.
- DeepSeek Flash ile yerel repository yapısını, mevcut desenleri, bağımlılıkları ve teknik kısıtları incele.
- Gemini 3.8 Flash ve DeepSeek Flash'ı aynı keşif aşamasında birlikte çalıştır ve ikisini birbirinin alternatifi gibi kullanma; farklı sağlayıcılar olduklarından eşzamanlı başlatılabilirler.
- Luna varsa hızlı ve dar soruları yanıtla; rota yoksa adımı atla ve sınırlama olarak kaydet.
- Antigravity çağrıları ortak ayar kilidi kullandığından Gemini çağrılarını seri çalıştır; paralel toplu Gemini çağrısı başlatma.
- Uzun bağlam gerektiren dış araştırmayı küçük parçalara böl; rol eşlemesindeki timeout yükseltme kuralını uygula ve yükseltmeyi planda belirt.
- Bir rota yoksa veya art arda başarısız olursa keşfi kilitleme; adımı atla, sınırlamayı kaydet ve kalan kanıtlarla ilerle.
- Her subagent çağrısına tek rol, açık hedef, ilgili dosyalar ve kabul kriterleri ver.

### 2. Doğrulama ve sentez

- Subagent çıktısını kanıt değil danışmanlık olarak değerlendir.
- Gemini 3.8 Flash bulgularını hipotez kabul et; önem derecesini, kaynak iddiasını ve kapsam iddiasını kaynakta veya yerel doğrulamayla teyit etmeden plana kesin bilgi olarak yazma.
- Çelişen bulguları açıkça işaretle; doğrulanamayan noktayı "doğrulanamadı" olarak kaydet.
- Bulguları hedef, kapsam, kabul kriterleri, doğrulama sınırları, iş kırılımı, kilometre taşları, riskler ve açık sorular başlıklarıyla plana dönüştür.
- Her iddiayı kaynağa, dosyaya veya ölçüme bağla.

### 3. Plan

- Planı yazılı ve uygulanabilir hale getir; her iş kalemini doğrulanabilir kabul kriteriyle eşleştir.
- Öncelik sırası, bağımlılıklar ve geri alınabilirlik notlarını ekle.
- Plan belgesini `codexLunaEdit` ile seçili tek dosyaya yazdır: hedef dosya yolunu (ör. `belgeler/plan/<tarih>-<konu>.md` veya `docs/plans/<tarih>-<konu>.md`), doğrulanmış plan içeriğini ve kabul kriterlerini ver.
- Edit öncesi çalışma ağacı durumunu kaydet ve hedef yolu canonical olarak çöz; workspace dışı yol, symlink kaçışı veya `..` geçişini reddet.
- Edit sonrası değişen yolları başlangıç durumuyla karşılaştır; değişiklik kümesi yalnız seçilen plan dosyasını içermelidir. Kapsam ihlalinde değişikliği kabul etme, yetkiyi genişletme; seçilen dosyanın diff'ini ve zorunlu başlıkları denetle.
- Tek plan dosyası oluşturma, kullanıcı plan yazımını açıkça istediğinde izinlidir; aksi halde orkestratör onayına tabidir. Çoklu dosya değişikliği kapsam ihlalidir ve fail-closed reddedilir.
- Kullanıcı açıkça istemediyse, yazma yetkisi yoksa veya Luna edit rotası yoksa planı konuşma çıktısı olarak sun ve planı yazma adımını sınırlama olarak kaydet. Plan yazımı araştırma mutasyonu değil, ayrı yetkilendirilmiş teslim işlemidir.
- Secret, kimlik bilgisi ve kişisel veri plan metnine yazılmaz.

### 4. Sol denetimi

- Planı `run_codex_subagent(model=gpt-5.6-sol)` çağrısıyla salt okunur denetlet.
- Sol'a planı, kararları, varsayımları ve doğrulanamayan noktaları eksiksiz ver; dosya erişimi yoksa ilgili içeriği prompt içinde sağla.
- Sol bulgularını kritik, orta ve düşük olarak ayır; her kritik ve orta bulguyu şu üç yoldan biriyle kapat: plan revizyonuyla gider ve yeniden doğrula, kanıtlı gerekçeyle kabul etme, ya da açık risk olarak kullanıcı kararına bırak (bu durumda plan uygulamaya hazır sayılmaz).
- Plan belgesi yazıldıysa revizyonu `codexLunaEdit` ile aynı seçili dosyada uygula; revizyondan önce araç erişimini ve yazma yetkisini yeniden doğrula; rota kullanılamıyorsa revizyonu konuşma çıktısı olarak ver.
- Sol çıktısı danışmanlıktır; nihai kararı ana orkestratör verir ve gerekli iddiaları bağımsız doğrular.

## Doğrulama protokolü

- Dış iddiaları kaynak URL ile teyit et; erişilemeyen veya doğrulanamayan kaynağı "doğrulanamadı" işaretle.
- Yerel iddiaları dosya yolu ve mümkünse satır numarasıyla destekle; kilit iddiaları grep veya okuma ile doğrula.
- Kaynaklı ve doğrulanamayan bulguları planda ayrı göster.
- Sayısal veya mimari iddiayı ölçüme ya da koda bağlamadan kesin ifade kullanma.

## Kurallar ve sınırlar

- Araştırma ve subagent çağrıları salt okunurdur; repository araştırma sırasında değiştirilmez. Plan belgesi yalnız kullanıcı açıkça istediğinde ve oturum yazma yetkisine sahipse `codexLunaEdit` ile seçili tek dosyaya yazılır; aksi durumda plan konuşma çıktısı olarak sunulur.
- Subagent çağrılarına secret, kabuk erişimi, subagent delegasyonu, commit veya geri alınamaz işlem verilmez.
- Araştırma için yazma yetkili subagent varyantı kullanılmaz; edit yalnız plan belgesi teslimi için ve seçili tek dosyada kullanılır.
- Luna edit çağrısı plan belgesi dışında hiçbir dosyayı değiştirmez; kod, yapılandırma veya çoklu dosya edit kapsamına girmez.
- Bir subagent rotası yoksa veya art arda başarısız olursa keşfi kilitleme; adımı atla, sınırlamayı kaydet ve planı kalan kanıtlarla tamamla.
- DeepSeek'e Vault kökü veya kişisel veri workspace olarak verilmez.
- Yerel kod analizi ile internet araştırması aynı çağrıda birleştirilmez.
- Gemini 3.8 Flash ve DeepSeek Flash birbirinin alternatifi değil, tamamlayıcısıdır; normal durumda keşif ikisi birlikte yürütülür, erişilemeyen rota sınırlama kaydıyla atlanabilir.
- Doğrulanmamış bilgi plana kesin iddia olarak yazılmaz.
- Plan, Sol denetiminden geçmeden uygulamaya başlanmaz.

## Çıktı biçimi

Plan en az şu başlıkları içerir:

- Hedef ve kapsam
- Hedef dışı bırakılanlar
- Kabul kriterleri ve doğrulama yöntemi
- Mimari ve teknoloji kararları (gerekçeleriyle)
- İş kırılımı ve kilometre taşları
- Riskler ve azaltma önlemleri
- Doğrulanamayan veya açık noktalar
- Sınırlamalar ve atlanan adımlar (yükseltilen veya çalıştırılamayan rotalar)
- Kaynaklar (doğrulanan ve doğrulanamayan)
- Sol denetim özeti ve kapatılan bulgular

## Bitirme koşulu

- Keşif bulguları kaynağa veya yerel doğrulamaya bağlıdır.
- Plan kabul kriterleriyle ve doğrulama yöntemleriyle eşleşir.
- Sol denetimi tamamlanmış; kritik ve orta bulgular giderilip yeniden doğrulanmış, kanıtla reddedilmiş veya açık risk olarak kullanıcıya bırakılmıştır.
- Açık ve doğrulanamayan noktalar kullanıcıya açıkça bildirilmiştir.
- Atlanan veya başarısız adımlar sınırlama olarak açıkça kaydedilmiştir.
- Plan belgesi `codexLunaEdit` ile yazıldıysa dosya mevcut, zorunlu başlıkları içeriyor ve edit öncesi/sonrası değişen yol karşılaştırmasıyla yalnız seçili dosya değişmiştir; `git diff --check` yalnız biçim kontrolü sağlar ve kapsam denetiminin yerine geçmez.
