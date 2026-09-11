# Multi-Agent Sistemleri ve Subagent Orkestrasyonu Araştırma Rehberi

Bu belge, bir yapay zekanın diğerini (alt-ajan/subagent olarak) çalıştırması ve görev devretmesi konularındaki modern endüstri standartlarını, best-practice kurallarını ve popüler araştırma başlıklarını içerir.

## 1. Temel Konseptler ve Mimariler

### Neden Subagent Kullanmalıyız? (Context Isolation)
Tek bir yapay zeka modelinin (God Model) tüm görevleri aynı anda, aynı konuşma penceresinde (context window) çözmeye çalışması sistemin tıkanmasına (Context Bloat) yol açar. Geçmiş araştırmalar, uzun deneme yanılma döngüleri ve loglar modelin dikkatini dağıtır ve halüsinasyonları artırır.
Subagent kullanımı **bağlam izolasyonu (context isolation)** sağlar: Her ajan yalnızca kendisine verilen **dar görevle** ilgilenir ve temiz bir zihinle çalışıp sadece "damıtılmış (compress)" sonucu ana modele iletir.

### Mimari Desenler (Architectural Patterns)
*   **Orkestratör - İşçi (Supervisor/Worker):** Projemizdeki mimarinin karşılığıdır. OpenCode oturumunda aktif kullanılan ana model planı yapar, işi parçalara böler. DeepSeek ve Codex gibi ajanlara dar kapsamlı görevler (Örn: "Bu hatayı araştır") verir; Gemini/Antigravity yalnız salt-okunur web ve workspace analizi için kullanılır, kod yazma görevi verilmez.
*   **Pipeline (Boru Hattı):** Bir ajanın çıktısının, doğrudan diğerinin girdisi olduğu sıralı sistemlerdir.
*   **Swarm (Sürü):** Aynı problemin birden fazla bağımsız ajana verilip sonuçların oylandığı/birleştirildiği yapılardır.

## 2. Eğitim ve Araştırma İçin Odak Anahtar Kelimeler

Video (YouTube vb.) veya makale araştırması yaparken şu başlıklar kullanılmalıdır:
*   **"LangChain Subagents Explained / Supervisor Pattern"**
*   **"CrewAI Multi-Agent Setup Tutorial"**
*   **"Master Claude Code Subagents"**
*   **"Microsoft AutoGen Orchestration"**

## 3. Güvenlik ve Limitasyon (Best Practices)

Multi-agent mimariler inşa edilirken uygulanması gereken altın kurallar:
1.  **Dar ve Sınırlandırılmış Görevler (Bounded Tasks):** Alt-ajana "Bu projeyi bitir" yerine, "Projedeki Auth.js dosyasındaki CORS hatasını bul ve json dön" gibi net hedefler verilmelidir.
2.  **Araç/Bütçe Kotası (Tool Budgets / Max Turns):** Ajanların birbiriyle veya kendi kendilerine sonsuz döngüye (infinite loop) girmesini engellemek için maliyet, token ve tur (turn) sınırları konulmalıdır. *(Projemizdeki `policy.json` bu mantıkla çalışır).*
3.  **Özetlenmiş Çıktı (Compression):** Alt-ajan tüm çalışma sürecindeki adımlarını (örn: bash logları) değil, sadece yapması istenen işin nihai özetini (veya JSON çıktısını) ana modele teslim etmelidir.

## 4. İncelemeye Değer Kütüphaneler (Frameworks)
*   **LangGraph (LangChain):** Graf mimarisiyle ajanların ne zaman hangisine gideceğini kesin kurallarla çizen yapıdır.
*   **CrewAI:** Ajanlara "Kıdemli Araştırmacı", "Yazılım Geliştirici" gibi roller atayarak birbirleriyle insan ekibi gibi çalışmalarını simüle eder.
*   **Microsoft AutoGen:** Çoklu ajan konuşturma (conversable agents) konusunda Microsoft'un geliştirdiği çok popüler bir araştırma altyapısıdır.

---
**Sonuç:** Projemizde planladığımız "MCP üzerinden Subagent Delegasyonu" mimarisi, yapay zeka mühendisliği literatürünün geldiği en üst (State-of-the-Art) noktalardan biridir. Yukarıdaki kavramları özümsemek, sistemin daha kararlı çalışmasını sağlayacaktır.
