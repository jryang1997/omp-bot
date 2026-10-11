// persona.mjs — bot 人格文件与上下文隔离。
//
// 两个隔离目标：
// 1) 人格：用 --append-system-prompt <file> 注入 bot 身份，保留 omp 默认工具/工作流策略。
// 2) 上下文净化：用 --config overlay 关掉所有 context-file provider，
//    这样用户全局 ~/.omp/agent/AGENTS.md（飞书/AskHuman 等约定）不会漏进 bot，
//    bot 只看到自己的人格 + omp 默认系统提示。模型认证不受影响：
//    disabledProviders 里放的是 context provider id（native/agents-md/…），
//    与模型 provider id（anthropic/openai/…）不同命名空间。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 要禁用的 context-file provider（不含任何模型 provider）。 */
const CONTEXT_PROVIDERS_TO_DISABLE = [
  "native",
  "agents",
  "agents-md",
  "claude",
  "claude-md",
  "codex",
  "gemini",
  "opencode",
  "github",
  "custom-context",
];

/** 生成 bot 的人格提示文本。 */
export function personaText(bot) {
  const lines = [
    `# 你的身份`,
    ``,
    `你是「${bot.name}」，一个常驻的 AI bot 团队成员。`,
  ];
  if (bot.role) lines.push(`你的角色定位：${bot.role}`);
  if (bot.instructions) {
    lines.push(``, `# 你的专属指令`, ``, bot.instructions);
  }
  lines.push(
    ``,
    `# 团队协作规则`,
    ``,
    `- 你可以用 message_bot 工具给团队里的其他 bot 发消息并直接拿到它的回复。`,
    `- 收到其他 bot 的消息时，消息会带署名，形如「Message from 🤖 名字 (@id): …」。`,
    `- 群聊里，如果这轮你没有实质内容要说，只回复 [PASS]。`,
    `- 想点名某个成员接着说，用 @名字。`,
    `- 回答简洁、直接，别复述规则本身。`,
  );
  return lines.join("\n");
}

/**
 * 为一个 bot 准备人格文件与 config overlay，返回启动时要追加的 argv。
 * @param {object} bot 花名册记录
 * @param {string} dir 该 bot 的私有目录（放 persona 文件、overlay、session）
 */
export function writePersonaFiles(bot, dir) {
  mkdirSync(dir, { recursive: true });
  const personaPath = join(dir, "persona.md");
  writeFileSync(personaPath, personaText(bot), "utf8");

  const overlayPath = join(dir, "isolate.yml");
  const overlay = [
    "# omp-bot 生成的隔离 overlay：关掉 context-file 发现，只保留 bot 人格。",
    "disabledProviders:",
    ...CONTEXT_PROVIDERS_TO_DISABLE.map((p) => `  - ${p}`),
    "",
  ].join("\n");
  writeFileSync(overlayPath, overlay, "utf8");

  return {
    personaPath,
    overlayPath,
    argv: ["--append-system-prompt", personaPath, "--config", overlayPath],
  };
}
