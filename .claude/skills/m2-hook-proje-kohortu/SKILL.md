---
name: m2-hook-proje-kohortu
description: Yeni memory-hook oturumu veya hook kurulumu için proje cohort davranışı istendiğinde project_alpha, project_beta ve unassigned değerlerini kurulum kapsamına göre açıklar; exact realpath registry kurallarını uygular ve cohort'u outcome ya da yetki saymaz.
---

# M2 Hook Project Cohort

Bu skill yeni memory-hook session'larında cohort metadata'sının nasıl çözüldüğünü veya hook kurulumunun nasıl yapılacağını açıklar. Cohort değerleri `project_alpha`, `project_beta` ve `unassigned` ile sınırlıdır.

## Ne zaman kullanılır

- Yeni bir hook session'ında project cohort çözümlemesi sorulduğunda.
- Hook'un proje veya global kurulum kapsamı, `--cohort` seçimi ya da registry davranışı sorulduğunda.
- Kullanıcı açıkça hook kurulumunu istediğinde.

## Cohort çözümleme kuralları

- Proje kurulumu `--project-root=<root>` ile belirlenir. `--cohort` verilmezse proje hook'u sabit `unassigned` olur; registry çözümlemesi bu değeri named cohort'a yükseltmez.
- Named proje cohort'u için `--cohort=project_alpha` veya `--cohort=project_beta` açıkça verilmelidir. Kurulum root'u ve istemci hedefi registry girdisiyle doğrulanmalıdır.
- Global kurulumda statik named cohort reddedilir. `--cohort` atlanırsa global hook gerçek çalışma zamanı bağlamını registry ile dinamik çözümler. Açık `--cohort=unassigned` bu dinamik çözümlemeyi kapatır.
- Registry yalnız yerel `~/.config/subagent-bridge/memory-hook-cohorts.json` dosyasından veya mutlak `SUBAGENT_MEMORY_HOOK_COHORT_REGISTRY` override'ından gelir; registry Git'e eklenmez.
- Eşleşme yalnız kayıtlı kökün tam canonical `realpath` eşitliğiyle yapılır. Parent/child, yol öneki, benzer ad, URL veya serbest metin eşleşmesi yapılmaz.
- OpenCode'da `directory` ve `worktree` adaylarının tümü aynı kayıtlı cohort'a eşleşmelidir. Herhangi bir aday eşleşmezse veya adaylar farklı cohort'lara giderse sonuç `unassigned` olur. Codex/Claude global bağlamında gerçek hook `cwd` değeri exact registry eşleşmesinde kullanılır.
- İlk başarılı session metriğine yazılan cohort değişmez. Eski cohort alanı olmayan kayıtlar `legacy_unattributed` kalır; geçmişe cohort atama yapılmaz.
- Registry yokluğu veya `unassigned` cohort, gerçek session kaydı/disposition/outcome doğrulanmışsa M2 eligibility ya da feedback kaydını engellemez. Cohort sonucunu uygunluk kararından ayrı raporla.

## Mevcut session cohort'u `unassigned` ise

1. Aggregate metrikten proje tahmini yapma. Kullanıcı exact session ID verdiyse önce aynı canonical metrics kaynağında `client + sessionIdHash` ile `memory_hook_session` kaydını salt-okunur eşleştir; ham ID, hash veya root/path yazdırma. Aggregate özet tek session'ı tek başına kanıtlamaz.
2. Metrikte saklanan `projectCohort` cohort'un session oluştuğu andaki sonucudur. Kullanıcının sohbet içinde proje adını belirtmesi mevcut event'i yeniden sınıflandırmaz.
3. OpenCode project hook kurulumunda `--cohort` atlanmışsa installer `unassigned` değerini plugin'e sabitler; sonradan registry eklemek bu sabit değeri named cohort'a yükseltmez.
4. OpenCode global/dinamik hook'ta `--cohort` verilmezse registry exact `realpath` eşleşmesiyle `directory` ve `worktree` değerlerinin ikisini de çözmelidir. Registry yok/bozuksa, adaylardan biri eşleşmiyorsa veya cohort'lar farklıysa sonuç `unassigned` olur.
5. Session anındaki gerçek plugin/kurulum girdisi artık yoksa hangi yolun `unassigned` ürettiğini kesinleştirme; kanıtlanan session sonucu ile olası kurulum nedenlerini ayrı yaz.
6. Düzeltme varsa gelecekteki session'ların kurulum/registry ayarını ele alır. Mevcut `memory_hook_session` event'ini değiştirme; `hook:feedback` veya historical attribution cohort onarma aracı değildir.

## Kurulum sonrası doğrulama

- Registry eklemek veya OpenCode'u yeniden başlatmak tek başına yeni session'a bağlam enjekte edildiğini kanıtlamaz. Yeni gerçek `client + sessionIdHash` kaydını ve ölçülmüş süreyi doğrula; cohort'un yapılandırılan named değer olduğunu session metriğinden kontrol et.
- Cohort yalnız yeni session kaydına yazılır. Önceki session `unassigned` ise olduğu gibi kalır; registry değişikliği veya restart ile geriye dönük düzeltme yapma.
- OpenCode'da `recordMemoryHookSession` çağrısı `projectCohort` almıyorsa köprü varsayılanı `unassigned` olur. Düzeltmede hem eklentiye resolved project cohort'u verildiğini hem de callback'te `projectCohort` değerinin session kayıt fonksiyonuna geçirildiğini doğrula.
- Kurulum izni verildiğinde bile mevcut hedef eklenti dosyasını `--force` ile ezme. Installer mevcut farklı eklentiyi reddeder; mevcut içeriği incele ve yalnız onaylanan cohort değişikliğini kontrollü biçimde birleştir.

## Kurulum

Yalnız kullanıcı açıkça kurulum istediğinde kurulum komutunu kullan. `--apply` kalıcı hook/config yazımı yapar; açık yazma isteği ve doğru proje/global kapsamı olmadan ekleme. Project named install örneği:

```text
npm run hook:install -- --client=<opencode|codex|claude> --project-root=<canonical-root> --cohort=<project_alpha|project_beta> --apply
```

Global dinamik kurulumda `--project-root` ve named `--cohort` verme. Global `unassigned` istenirse açık `--cohort=unassigned` kullan. Kurulum sonucunda gerçek hedef ve kapsamı doğrula. Claude kurulum çıktısı elle birleştirilecek snippet olabilir; hedef ayara otomatik yazdığını varsayma. Codex hook güven onayı ve OpenCode plugin etkinleştirme/yeniden başlatma gerekliliklerini kullanıcıya bildir.

## Sınırlar

- Cohort raporlama metadatasıdır; kullanıcı outcome'u, eligibility veya erişim yetkisi değildir.
- Ham root/path, worktree, `cwd`, repo URL'si veya bunların hash'ini rapora, prompt'a ya da loga yazma. Gerekirse yalnız `project_alpha`, `project_beta` veya `unassigned` sonucunu bildir.
- Registry içeriğini oluşturma/değiştirme veya kullanıcı köklerini tahmin etme. Named eşleşme kanıtlanamıyorsa `unassigned`/belirsiz durumu koru.
- Yeni session'dan sonraki cohort değişikliğini mevcut kayda uygulama ve attribution conflict'i canonical kaydı değiştirerek düzeltme.
- `m2-hook-sonuc-geri-bildirimi` veya `m2-hook-oturum-uygunlugu` sorumluluğunu üstlenme.
