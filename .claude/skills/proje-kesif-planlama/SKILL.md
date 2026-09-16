---
name: proje-kesif-planlama
description: Yeni bir projeye veya büyük bir göreve başlamadan önce Gemini 3.8 Flash ve DeepSeek Flash'ı kapasitelerine göre birlikte, GPT Luna ile kısa araştırma yaparak keşif yürütür, bulguları doğrulanabilir bir proje planına dönüştürür ve planı Sol denetiminden geçirir.
---

# Proje Keşif ve Planlama

Yeni bir projeye, büyük bir özelliğe veya belirsiz kapsamlı bir göreve kod yazmadan önce çalıştırılan keşif ve planlama akışı. Amaç, düşük maliyetli hızlı modellerle geniş keşif yapmak, bulguları bağımsız doğrulamak, uygulanabilir bir plan üretmek ve planı güçlü bir denetimden geçirmektir.

## Ne zaman kullanılır

- Kullanıcı yeni bir proje, yeni bir ürün veya geniş kapsamlı bir geliştirme istediğinde.
- Kapsam, mimari, teknoloji seçimi veya kabul kriterleri belirsizken.
- Kod yazmaya başlamadan önce araştırma ve plan onayı gerektiğinde.

Küçük, kapsamı net ve doğrudan uygulanabilir görevlerde bu skill kullanılmaz.

## Rol ve model eşlemesi

- Gemini 3.8 Flash: geniş web ve bağlam keşfi, kamuya açık sayfa ve doküman taraması, aday bulgu üretimi. Araç: `run_antigravity_subagent(model=gemini_flash_3_8)`, salt okunur.
- DeepSeek Flash: yerel repository analizi, yapılandırılmış bulgular, sınır ve risk tespiti. Araç: `run_deepseek_subagent(model=deepseek_flash, mode=read_only)`.
- GPT Luna: hızlı fiyat/performans keşfi, dar ve iyi tanımlı araştırma soruları, ikinci hızlı görüş. Araç: `run_codex_subagent(model=gpt-5.6-luna)`, salt okunur.
- Sol: plan denetimi ve nihai teknik değerlendirme. Araç: `run_codex_subagent(model=gpt-5.6-sol)`, salt okunur.

Gemini 3.8 Flash ve DeepSeek Flash birbirinin alternatifi değildir; keşif aşamasında birlikte çalıştırılır ve her biri kendi kapasitesine göre kullanılır. Gemini 3.8 Flash dış ve kamuya açık bağlamı toplar; DeepSeek Flash yerel repository gerçeğini ve yapılandırılmış bulguları üretir. İkisinin çıktısı tek planda birleştirilir; birinin diğerinin yerine geçmesi veya yalnız biriyle keşfin bitirilmesi beklenmez.

GLM aboneliği pasif olduğundan hiçbir GLM modeli, profili veya fallback'i çağrılmaz.

## Aşamalar

### 1. Keşif

- Önce hedefi, kapsamı, kısıtları ve açık soruları yazılı hale getir.
- Araştırmayı bağımsız alt sorulara böl; aynı işi iki modele tekrar ettirme.
- Gemini 3.8 Flash'a yalnız web ve bağlam toplama görevi ver; dosya inceleme, komut çalıştırma, kaynak satırı doğrulama veya karar verme görevi verme.
- DeepSeek Flash ile yerel repository yapısını, mevcut desenleri, bağımlılıkları ve teknik kısıtları incele.
- Gemini 3.8 Flash ve DeepSeek Flash'ı aynı keşif aşamasında birlikte çalıştır ve ikisini birbirinin alternatifi gibi kullanma; farklı sağlayıcılar olduklarından eşzamanlı başlatılabilirler.
- Luna ile hızlı ve dar soruları yanıtla; sonuçları fiyat/performans ve hız açısından karşılaştır.
- Antigravity çağrıları ortak ayar kilidi kullandığından Gemini çağrılarını seri çalıştır; paralel toplu Gemini çağrısı başlatma.
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
- Secret, kimlik bilgisi ve kişisel veri plan metnine yazılmaz.

### 4. Sol denetimi

- Planı `run_codex_subagent(model=gpt-5.6-sol)` çağrısıyla salt okunur denetlet.
- Sol'a planı, kararları, varsayımları ve doğrulanamayan noktaları eksiksiz ver; dosya erişimi yoksa ilgili içeriği prompt içinde sağla.
- Sol bulgularını kritik, orta ve düşük olarak ayır; kritik ve orta bulguları planı güncelleyerek kapat.
- Sol çıktısı danışmanlıktır; nihai kararı ana orkestratör verir ve gerekli iddiaları bağımsız doğrular.

## Kurallar ve sınırlar

- Keşif ve planlama salt okunurdur; bu aşamada repository değiştirilmez.
- Subagent çağrılarına secret, kabuk erişimi, subagent delegasyonu, commit veya geri alınamaz işlem verilmez.
- DeepSeek'e Vault kökü veya kişisel veri workspace olarak verilmez.
- Yerel kod analizi ile internet araştırması aynı çağrıda birleştirilmez.
- Gemini 3.8 Flash ve DeepSeek Flash birbirinin alternatifi değil, tamamlayıcısıdır; keşif ikisi birlikte yürütülerek tamamlanır.
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
- Sol denetim özeti ve kapatılan bulgular

## Bitirme koşulu

- Keşif bulguları kaynağa veya yerel doğrulamaya bağlıdır.
- Plan kabul kriterleriyle ve doğrulama yöntemleriyle eşleşir.
- Sol denetimi tamamlanmış, kritik ve orta bulgular kapatılmıştır.
- Açık ve doğrulanamayan noktalar kullanıcıya açıkça bildirilmiştir.
