# Güvenlik

Bu proje çoklu model yürütücülerini (Codex, Antigravity, OpenCode tabanlı sağlayıcılar) koordine eden bir köprüdür. İzin sınırları ve sandbox davranışı güvenlik sınırı olarak kabul edilir; bunları gevşeten değişiklikler güvenlik açığı sayılır.

Redakte telemetri de güvenlik sınırıdır: execution metrikleri explicit allowlist ile yazılır; prompt, araç çıktısı, URL, workspace yolu, execution ID, task ID ve secret kaydedilmez.

## Güvenlik açığı bildirimi

Herkese açık bir güvenlik açığı bulursanız bunu public issue veya PR ile bildirmeyin. E-posta veya GitHub Security Advisory üzerinden iletin. Raporunuzda şunları belirtin:

- Etkilenen sürüm ve ortam.
- Açığı yeniden üretmek için minimum adımlar.
- Etki değerlendirmesi (izin genişlemesi, secret ifşası, yürütme kaçağı vb.).

Bildirimler öncelikli incelenir; düzeltme ve sürüm notu sonrası ayrıntı paylaşılır.

## Kapsam dışı ve gizlilik

- `~/.config/subagent-bridge`, `%LOCALAPPDATA%\subagent-bridge` ve `.gemini` altındaki kişisel yapılandırma, log ve hafıza içerikleri bu deponun dışındadır; bunlara ait "bulgu" raporları işleme alınmaz.
- API anahtarı, token veya oturum bilgisi içeren kayıtlar güvenlik açığı değildir; derhal döndürülmeli ve sızıntı kaynağı bildirilmelidir.
