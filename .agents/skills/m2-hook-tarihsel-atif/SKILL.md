---
name: m2-hook-tarihsel-atif
description: Kullanıcı ilk M2 rollout'unda önceden onaylanmış belirli bir legacy OpenCode session'ı için tarihsel atıf istediğinde kaynak kanıtını, tam ID/hash bağını ve kapalı attribution üçlüsünü doğrular; yalnız append-only historical görünüm kullanır.
---

# M2 Hook Historical Attribution

Bu istisnai skill, canonical M2 cohort alanına geriye dönük yazmadan önceden onaylanmış üç OpenCode legacy session'ını ayrı `historicalAttribution` görünümüne bağlar. Genel migration veya yeni tarihsel hedefleri onaylama yolu değildir.

## Tetikleme ve ilk rollout sınırı

Yalnız kullanıcı tekil tarihsel atıf işlemini açıkça istediğinde değerlendir. İlk rollout kapsamı şunlarla sınırlıdır:

- Daha önce açıkça kullanıcı tarafından teyit edilmiş bir Project Beta OpenCode `not_useful` session'ı; `user_confirmed` basis'i.
- Kaynak plan önceden onaylı cohort planı (özel kaynak deposunda) içinde zaman/süreyle tanımlanmış iki Project Alpha OpenCode session'ı; `session_metadata_verified` basis'i. Birinin outcome'u `partial`, diğerininki `not_useful`.

Başka legacy session, gelecekteki session veya bu hedeflerle birebir bağı kurulamayan session yetkili değildir. Yeni hedef ayrı plan revizyonu, kanıt ve açık kullanıcı kararı gerektirir. Session kimliklerini bu skill dosyasına, plana, loga veya çıktıya kopyalama.

Bu skill yeni bir session'ın `unassigned` cohort'unu onarmak veya mevcut `memory_hook_session` event'ini proje cohort'una çevirmek için kullanılamaz. Yeni session için cohort kurulum/registry teşhisi `m2-hook-proje-kohortu` kapsamındadır; tarihsel atıf yalnız yukarıdaki kapalı legacy hedefleri içindir.

Tam session ID bu konuşmada ve güvenilir host bağlamında yoksa, kullanıcı açık tarihsel atıf istediyse ID'yi bir kez iste. ID başka bir konuşmada verilmişse o konuşmanın geçmişini göremediğini açıkla. ID sağlanmıyorsa yazmasız dur ve yeniden sorma; expected hash veya başka kimlik bilgisi isteme.

## Zorunlu kanıt zinciri

1. İşlem yazma yapacağından kullanıcının açık isteğini ve tam olarak hangi onaylı hedefi kastettiğini doğrula.
2. Project Alpha hedefinde adayın kaynak plandaki belirli zaman/süreyle birebir eşleşmesini ve mevcut `historicalAttribution` kaydıyla tutarlı olduğunu doğrula. OpenCode session ID hash'i `client=opencode` metrik kaydının `sessionIdHash` değeriyle birebir eşleşmelidir.
3. Project Alpha `session_metadata_verified` için OpenCode `directory`, `worktree` ve kayıtlı `project_directory` değerlerinin her biri Project Alpha canonical root ile ayrı ayrı tam `realpath` eşleşmesi göstermelidir. Alan eksik, farklı, belirsiz veya doğrulanamazsa dur.
4. Project Beta hedefinde kanıt önceden var olan açık kullanıcı teyididir. Project Alpha path metadata koşulunu bu hedef için isteme veya iddia etme.
5. Hedefi, outcome'u, `client=opencode` değerini, `eligible_real_user` disposition'ını, mevcut feedback'i, legacy/no-canonical-`projectCohort` durumunu ve önceki tarihsel atıf/conflict durumunu doğrula.
6. Yalnız şu kapalı `(cohort, basis, outcome)` üçlülerini kabul et:
   - `(project_beta, user_confirmed, not_useful)`
   - `(project_alpha, session_metadata_verified, partial)`
   - `(project_alpha, session_metadata_verified, not_useful)`
7. CLI bu üçlüyü genel olarak doğrular, ancak ilk rollout'taki belirli üç session için teknik allowlist uygulamaz. Bu nedenle hedefin kaynak kanıtına birebir bağını kuramıyorsan CLI'yi çalıştırma. Genel CLI kurallarına uyan unrelated legacy session için de yazmasız ret zorunludur.

## Komut ve doğrulama

Tüm önkoşullar kanıtlandıktan, kullanıcı açıkça kayıt istediğinde ve orchestrator trusted bağlamından tek kullanımlık beklenen hash sağlandığında şu tek-session komutunu kullan:

```text
npm run hook:attribute-history -- --session-id=<full-session-id> --confirm-session-id=<same-full-session-id> --cohort=<project_beta|project_alpha> --basis=<user_confirmed|session_metadata_verified>
```

CLI `client=opencode` değerini sabit kullanır. `SUBAGENT_MEMORY_HOOK_EXPECTED_SESSION_HASH` yalnız orchestrator'ın güvenilir invocation bağlamında sağlanır; kullanıcıdan hash isteme, hash'i argümana/koda/loga yazma veya kendin uydurma. Tam session ID iki parametrede normalize edilip aynı olmalıdır. Tek bir işlemde tam dört argüman bulunmalıdır.

Başarılı yeni kayıt yalnız append-only supplementary attribution event'i üretir. Tam aynı event idempotent olabilir; bu halde yeni event oluştuğunu söyleme. Beklenmeyen sonuç, mismatch veya ret halinde yeniden deneme yapmadan dur. Hiçbir durumda session/disposition/feedback satırlarını güncelleme veya canonical cohort ekleme.

## Sınırlar

- Bu skill normal cohort atama, outcome seçme, eligibility belirleme ya da toplu migration yapmaz.
- Yalnız üç hedef, sabit `opencode` istemcisi ve kapalı üçlü matrisi geçerlidir. Başka istemci, outcome, cohort, basis veya session reddedilir.
- Kaynak M2 planı/önceden teyit, session kimliği/metric hash, gerçek metadata veya trusted hash mevcut değilse yazma yoktur. Oturum süresi/ID/metadata'yı geriye dönük tahmin etme.
- Session ID veya kanıtı tekrar tekrar isteme; tek bir istekte sağlanmayan değerler işlemi yazmasız durdurur.
- Ham session ID, path, prompt, transcript, kullanıcı kimliği, registry içeriği ve beklenen hash hiçbir log, rapor, prompt veya kalıcı nota eklenmez.
- Historical attribution yalnız ek rapordur; canonical `byProjectCohort`, global M2 toplamları, `pilotStartAt` veya `decisionReady` hesabını değiştirmez.
