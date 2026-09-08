# Katkı rehberi

Katkılar açıktır. Başlamadan önce mimari dokümanları ve güvenlik modelini okuyun: `docs/architecture` ve `SECURITY.md`.

## Geliştirme ortamı

Gereksinimler:

- Node.js 22 veya 24.
- Sağlayıcı çalıştırmak için ilgili CLI (codex, agy vb.) ve kimlik doğrulama; yalnız birim testleri için gerekmez.
- Kişisel yapılandırma `~/.config/subagent-bridge` altındadır; repodaki `config/*.json` dosyaları şablondur.

Kurulum ve doğrulama:

```powershell
npm ci
npm test
npm run verify:ci
```

## Değişiklik kuralları

- Her değişiklik için davranışı kanıtlayan bir test ekleyin veya güncelleyin; test olmadan kabul edilmez.
- Read-only izin kapsamını, sandbox davranışını, retry politikasını veya provider yönlendirmesini değiştiren katkılar güvenlik sınırına dokunur; gerekçe PR açıklamasında verilmeli ve regression testleri eklenmelidir.
- Secret, API anahtarı veya kişisel yol içeren dosya commit etmeyin; kişisel değerler yapılandırma şablonlarına placeholder olarak girilir.
- Kod ve commit mesajlarında açıklayıcı Türkçe kullanın; emoji veya gündelik ikon kullanmayın.
- Gereksiz yorum, devre dışı bırakılmış kod ve TODO bırakmayın.

## İş akışı

1. Konu ile ilgili bir branch açın.
2. Değişikliği yapın; `npm test` ve `npm run verify:ci` geçmeli.
3. `git diff --check` ile boşluk hatalarını temizleyin.
4. Değişikliği tek bir PR olarak gönderin ve davranış değişikliğini açıklayın.
