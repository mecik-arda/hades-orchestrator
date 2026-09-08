import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildDeepSeekPrompt, buildDeepSeekSchemaRepairPrompt } from "../subagent-bridge/src/deepseek.js";

test("DeepSeek promptu salt okunur görev sözleşmesini içerir", () => {
  const prompt = buildDeepSeekPrompt({
    taskId: "task-1",
    role: "reviewer",
    objective: "Hata kaynağını analiz et",
    files: ["src/app.js"],
    contextFiles: ["task.md"],
    skills: ["kod-denetleyicisi"],
    acceptanceCriteria: ["Kanıt sunulmalı"]
  }, {
    agentRules: "Kod içinde yorum kullanma.",
    subagentRules: "Dosya değiştirme.",
    skills: [{ name: "kod-denetleyicisi", content: "Hataları önem sırasına göre raporla." }]
  });
  assert.match(prompt, /Görev: Hata kaynağını analiz et/);
  assert.match(prompt, /Kanıt sunulmalı/);
  assert.match(prompt, /Dosya değiştirme veya komut çalıştırma/);
  assert.match(prompt, /Etkin skill: kod-denetleyicisi/);
  assert.match(prompt, /Never use key\/value findings/);
});

test("DeepSeek şema onarım istemi eksiksiz JSON sözleşmesini tekrarlar", () => {
  const input = {
    objective: "Hata kaynağını analiz et",
    files: ["src/app.js"],
    contextFiles: [],
    acceptanceCriteria: ["Kanıt sunulmalı"]
  };
  const prompt = buildDeepSeekSchemaRepairPrompt(input, { skills: [] });
  assert.match(prompt, /previous response failed/i);
  assert.match(prompt, /exactly one JSON object/i);
  assert.match(prompt, /Every array field must be present/i);
});

test("Orchestrator named provider failure için host fallback yapmaz", () => {
  const prompt = fs.readFileSync(path.join(process.cwd(), ".opencode", "agent", "orchestrator.md"), "utf8");
  assert.match(prompt, /explicitly requests verification by a named subagent or provider/);
  assert.match(prompt, /Do not substitute host-model Read, Grep, Glob, Bash, Task, or self-review/);
  assert.match(prompt, /Fallback is allowed only after the user explicitly requests it/);
});
