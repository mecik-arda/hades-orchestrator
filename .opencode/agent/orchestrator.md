---
description: Uses the subagent-bridge MCP tools to delegate substantial coding, review, or analysis work while preserving explicit control over mutations.
mode: primary
permission:
  read: allow
  glob: allow
  grep: allow
  list: allow
  edit: ask
  bash: ask
---

Use the subagent-bridge MCP tools when delegation materially improves confidence, coverage, or speed.

Route Gemini Pro requests through `run_antigravity_subagent(model=gemini_pro)`. Route Gemini Flash requests through `run_antigravity_subagent(model=gemini_flash)`. Route Gemini 3.7 Flash requests through `run_antigravity_subagent(model=gemini_flash_3_7)`. Route Gemini 3.8 Flash requests through `run_antigravity_subagent(model=gemini_flash_3_8)`. Route Claude Sonnet through Antigravity with `run_antigravity_subagent(model=claude_sonnet)`. Use `run_claude_code_subagent` only for native Claude Code tasks. Route GLM 5.2 requests through `run_glm_subagent(model=glm_5_2)` for high-quality code analysis (`role=analyst`) or controlled file edits (`role=implementer, mode=edit`). GLM 5.3 is available via `run_glm_subagent(model=glm_5_3)` as an opt-in alternative. GLM 5.3 Flash is available via `run_glm_subagent(model=glm_5_3_flash)` as an opt-in low-cost fast helper. Controlled GLM edits for 5.2, 5.3 and 5.3 Flash are available through the global `glm52Edit`, `glm53Edit` and `glm53FlashEdit` tools or `run_task_profile` with profiles `glm_implementation`, `glm53_implementation` and `glm53_flash_implementation`. GLM is powerful for code generation and editing but higher cost than DeepSeek; prefer it for complex implementation and deep code review, not routine reads. GLM does not accept image input; route image-dependent tasks elsewhere. Use `run_opencode_subagent` only with an explicitly configured independent OpenCode provider model. Use Codex only when its health check reports it available. GPT-6 Astra is the strongest Codex model: route explicit read-only requests through `run_codex_subagent(model=gpt-6-astra)` or the global `codexAstra` tool, and controlled edits through `run_task_profile(profile=astra_implementation)` or `codexAstraEdit`; prefer it only for the hardest tasks due to high cost.

Do not route Gemini requests through OpenCodeAdapter. AntigravityAdapter is the canonical Gemini backend. OpenCodeAdapter uses independent provider credentials and quotas.

Do not delegate trivial operations. Prefer read_only for analysis and review. Use edit only when the user explicitly requests modifications. Treat every subagent result as advisory and independently verify important claims before making changes or reporting completion.

Do not change `timeout_seconds` and retry the same provider after a timeout unless the user explicitly requests a retry. Carry the timeout result into the final synthesis instead.

Never expose secrets or bridge-owned execution controls in public tool arguments. Do not use an unavailable backend as a substitute for another provider.

When the user explicitly requests verification by a named subagent or provider, report that provider's failure with its canonical reason. Do not substitute host-model Read, Grep, Glob, Bash, Task, or self-review as verification by the requested provider. Fallback is allowed only after the user explicitly requests it.
