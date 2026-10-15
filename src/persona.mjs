// persona.mjs — bot 人格文件与上下文隔离 overlay。
//
// 隔离目标与实测边界（依据官方 docs 与源码核查，本机未逐项实跑）：
// 1) 人格：用 --append-system-prompt <file> 注入 bot 身份，保留 omp 默认工具/工作流策略。
// 2) 上下文净化：逐文件关掉用户级/项目级 AGENTS.md、CLAUDE.md、GEMINI.md。
//    不能用整源开关：disabledProviders 里写 native 会连同原生 MCP 服务器、skills、
//    命令、hooks、tools 一起移除，而 native 正是读取 bot 私有 <cwd>/.omp/mcp.json 的
//    provider。所以这里只用 disabledExtensions 的精确 id + skills 的用户级开关。
//    残留（如实披露，不宣称全封）：用户级 ~/.omp/agent/RULES.md 与用户级 mcp.json
//    在 native 源开启时仍会加载；要一并挡掉只能废掉整个 native 源，代价是失去 bot
//    私有项目 MCP/skills，因此选择保留。
// 3) 记忆：默认关闭共享/本地记忆后端与 autolearn；用户显式开启时用原生 local 后端，
//    隔离靠 BotRuntime 把 PI_CODING_AGENT_DIR 指向 bot 私有 agentDir（含 agent.db 与
//    memories 目录）。该私有目录的模型来源由 memory-config.mjs 写成最小 models.yml
//    （选定 provider 的非密传输行 + 选定模型行），凭据留在全局 auth store；记忆整理用的
//    default/smol/memory 角色钉在选定模型上，不继承用户全局的 cpa/tiny 等 provider。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TASK_CONCURRENCY } from "./constants.mjs";
import { memoryModelRoles } from "./memory-config.mjs";

/** 要逐文件关闭的上下文文件 id（scope: 文件名）。 */
const CONTEXT_FILES_TO_DISABLE = [
  "context-file:user:AGENTS.md",
  "context-file:project:AGENTS.md",
  "context-file:user:CLAUDE.md",
  "context-file:project:CLAUDE.md",
  "context-file:user:GEMINI.md",
  "context-file:project:GEMINI.md",
];

/** 用户级 skills/规则来源开关（项目级保持默认，供 bot 私有 .omp/skills 使用）。 */
const USER_SOURCE_TOGGLES = [
  "enablePiUser",
  "enableAgentsUser",
  "enableClaudeUser",
  "enableCodexUser",
  "enableOpencodeUser",
];

/** 生成 bot 的人格提示文本。 */
export function personaText(bot) {
  const lines = [
    `# 你的身份`,
    ``,
    `你是「${bot.name}」，一个常驻的 AI bot 团队成员。`,
  ];
  if (bot.role) lines.push(`你的角色定位：${bot.role}`);
  // OMP 默认面向技术读者；追加日常表达，仍由原生工具审批决定是否放行。
  lines.push(
    ``,
    `# 说话方式（默认）`,
    ``,
    `- 默认用简体中文，对方用别的语言就跟着用；口吻像同事聊天。`,
    `- 先说结果、对用户的影响、他接下来要做什么，细节按需要再补。`,
    `- 把对方当普通用户，不默认他懂技术；术语只在需要时出现，第一次出现就用一句大白话解释。`,
    `- 日常对话别写成「问题 / 决策 / 检查 / 下一步」那样的工程清单；用户要技术细节时再展开。`,
    `- 回复用户时别贴日志、路径、变量名、内部工具名、Run id、协议字段，除非用户想看，或它们本身就是答案。`,
    `- 用户当场的要求和下面「你的专属指令」优先于这些默认。`,
    ``,
    `# 征求同意（默认）`,
    ``,
    `- 用户明确交办的常规、可逆的事，直接做完再汇报，不要每一步都回来问。`,
    `- 对外发消息、对外发布、付款、重要且不可逆的数据改动、账号和权限变更，先取得用户明确同意；用户没有回应不算同意。`,
    `- 被拒绝或被取消的操作就停下，不换工具或路径重试，也不提议用别的工具绕开，用一句大白话说清这件事没做成；用户重新明确授权前不再尝试。`,
  );
  if (bot.instructions) {
    lines.push(``, `# 你的专属指令`, ``, bot.instructions);
  }
  lines.push(
    ``,
    `# 团队协作规则`,
    ``,
    `- 你可以用 message_bot 工具给团队里的其他 bot 发消息并直接拿到它的回复。`,
    `- 需要对方在后台并行处理时用 delegate_bot：它立即返回子 Run id，你之后可以继续做自己的事。`,
    `- 收到其他 bot 的消息时，消息会带署名，形如「Message from 🤖 名字 (@id): …」。`,
    `- 群聊里，如果这轮你没有实质内容要说，只回复 [PASS]。`,
    `- 想点名某个成员接着说，用 @名字。`,
    `- 跨合作范围（不同工作区）的私有上下文不共享；不要索要其他工作区的私有资料。`,
    `- 回答简洁、直接，别复述规则本身。`,
  );
  return lines.join("\n");
}

/**
 * 为一个 bot 准备人格文件与 config overlay，返回启动时要追加的 argv。
 * @param {object} bot 花名册记录
 * @param {string} dir 该 bot 的私有目录（放 persona 文件、overlay、session）
 * @param {object} [opts]
 * @param {string[]} [opts.extraDisabledExtensions] 额外要禁用的扩展 id（如 chat 档逐个关掉的 `mcp:<name>`）
 */
export function writePersonaFiles(bot, dir, opts = {}) {
  mkdirSync(dir, { recursive: true });
  const personaPath = join(dir, "persona.md");
  writeFileSync(personaPath, personaText(bot), "utf8");

  const extraDisabled = Array.isArray(opts.extraDisabledExtensions) ? opts.extraDisabledExtensions : [];
  const overlayPath = join(dir, "isolate.yml");
  const lines = [
    "# omp-bot 生成的隔离 overlay（每 bot 一份，不改用户全局配置）。",
    "# 1) 逐文件关掉用户级/项目级上下文文件；不用整源开关，避免连原生 MCP 一起废掉。",
    "disabledExtensions:",
    ...CONTEXT_FILES_TO_DISABLE.map((id) => `  - ${id}`),
    ...extraDisabled.map((id) => `  - ${id}`),
    "skills:",
    ...USER_SOURCE_TOGGLES.map((k) => `  ${k}: false`),
  ];

  if (bot.memoryEnabled === true) {
    // 记忆由用户显式开启：原生 local 后端 + autolearn，根目录靠运行时环境
    // PI_CODING_AGENT_DIR 指向本 bot 私有 agentDir（见 BotRuntime.buildEnv）。
    lines.push(
      "# 2) 记忆由用户显式开启：原生 local 后端；隔离依赖 PI_CODING_AGENT_DIR 指向本 bot 私有目录。",
      "#    不改用户全局配置，也不调用原生的全局 clear（那会删掉用户所有项目的记忆队列）。",
      "memory:",
      "  backend: local",
      "autolearn:",
      "  enabled: true",
    );
    // 记忆整理阶段用 default/smol/memory 角色选模型；不钉住就会落到用户全局配置里的
    // cpa/tiny 等别的 provider（私有目录没有它们的定义，直接不可用）。overlay 层压在
    // 全局配置之上，所以这三个角色只用选定模型。
    const roles = memoryModelRoles(bot.model);
    if (roles) {
      lines.push(
        "# 2b) 记忆/整理角色钉在选定模型上（overlay 层覆盖用户全局 modelRoles）。",
        "modelRoles:",
        ...Object.entries(roles).map(([role, value]) => `  ${role}: ${value}`),
      );
    }
  } else {
    lines.push(
      "# 2) 关掉共享记忆后端与 autolearn，防止 bot recall/retain 用户的私有记忆库。",
      "#    bot 的常驻记忆靠会话续接（--continue）实现，不依赖记忆后端。",
      "memory:",
      "  backend: off",
      "autolearn:",
      "  enabled: false",
    );
  }

  lines.push(
    "# 3) 团队工具显式声明审批档：未声明的原生 host tool 默认按 exec 处理，",
    "#    会在 supervised/write 下每次都弹卡。这三个工具的边界由宿主 admission 保证：",
    "#    同工作区、父预算/能力交集内自动；忙目标与越域一律拒绝。",
    "#    不在此宽泛放行任何内置工具或 task。",
    "tools:",
    "  approval:",
    "    message_bot: allow",
    "    list_bots: allow",
    "    delegate_bot: allow",
  );
  if (bot.computer) lines.push("    computer_screenshot: allow");

  if (bot.executionMode === "chat" || bot.computer) {
    // chat 与电脑绑定都使用受控工具来源，关闭项目 MCP：
    //  - mcp.enableProjectConfig=false：不加载项目级 .mcp.json/mcp.json
    //    （settings id 在 18.10.0 schema 中确认：packages/coding-agent/src/mcp/settings.ts，
    //     description "Load .mcp.json/mcp.json from project root"，默认 true）。
    //  - disabledExtensions 里的 `mcp:<name>`：按扩展 id 逐个关掉用户级 MCP 服务器
    //    （MCP 条目的 toExtensionId 就是 `mcp:${name}`；未发现通配支持，只能列名）。
    //  - 启动参数额外加 --no-extensions（真实 CLI 开关 → disableExtensionDiscovery）。
    // 本机实测：restrictToolNames/enableMCP/allowRestrictedCustomTools 这类 SDK 选项会被忽略，
    // 所以不再写它们；残留风险由 BotRuntime 的运行时工具面校验兜底（见 _verifyChatToolSurface），
    // 发现越界工具即拒绝运行，不宣称安全聊天。
    lines.push(
      "# 4a) chat 档：用真实原生设置关掉项目 MCP 来源（SDK 选项实测被忽略，不再使用）。",
      "mcp:",
      "  enableProjectConfig: false",
    );
  }

  lines.push(
    "# 4b) 原生子任务并发与递归上限（本次运行内生效，不改用户全局配置）。",
    "task:",
    `  maxConcurrency: ${DEFAULT_TASK_CONCURRENCY}`,
    "  maxRecursionDepth: 2",
    "",
  );
  writeFileSync(overlayPath, lines.join("\n"), "utf8");

  return {
    personaPath,
    overlayPath,
    argv: ["--append-system-prompt", personaPath, "--config", overlayPath],
  };
}
