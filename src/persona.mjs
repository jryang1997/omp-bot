// persona.mjs — bot 人格文件与上下文隔离 overlay。
//
// 隔离目标与实测边界（依据官方 docs 与源码核查，本机未逐项实跑）：
// 1) 人格：身份在 team/bots/<id>/AGENTS.md，团队共识在 team/AGENTS.md，omp 当项目级上下文读；
//    --append-system-prompt 只追加团队工具说明，保留 omp 默认工具/工作流策略。
// 2) 上下文净化：逐文件关掉用户级 AGENTS.md、CLAUDE.md、GEMINI.md，项目级打开。
//    不能用整源开关：disabledProviders 里写 native 会连同原生 MCP 服务器、skills、
//    命令、hooks、tools 一起移除，而 native 正是读取 bot 私有 <cwd>/.omp/mcp.json 的
//    provider。所以这里只用 disabledExtensions 的精确 id + skills 的用户级开关。
//    残留（如实披露，不宣称全封）：用户级 ~/.omp/agent/RULES.md 与用户级 mcp.json
//    在 native 源开启时仍会加载；要一并挡掉只能废掉整个 native 源，代价是失去 bot
//    私有项目 MCP/skills，因此选择保留。
// 3) 记忆：默认关闭记忆后端与 autolearn；用户显式开启时用 mnemopi，scoping 是 global，
//    bank 是 bot-<id>，库文件在 team/.memory/mnemopi.db（所有 bot 一个文件，按 bank 分）。
//    不改 PI_CODING_AGENT_DIR，模型和凭据走用户自己的 omp 配置；autolearn 关掉；
//    default/smol/memory 角色钉在选定模型上，记忆抽取不落到用户全局的别的 provider。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPUTER_PROMPT_TOOLS, COMPUTER_TOOL_NAMES, DEFAULT_TASK_CONCURRENCY } from "./constants.mjs";
import { secretPaths } from "./secret-guard.mjs";

const WRITE_GUARD_MODULE = new URL("./write-guard.mjs", import.meta.url).href;
const SECRET_GUARD_MODULE = new URL("./secret-guard.mjs", import.meta.url).href;
const WORKSPACE_PATHS_MODULE = new URL("./workspace-paths.mjs", import.meta.url).href;

/** 生成给 OMP --extension 加载的模块：只做 import + 注册，逻辑都在 src 里，测的就是跑的。 */
function guardExtensionSource(opts) {
  return [
    "// omp-bot 生成：相对路径落到工作区 + 密钥目录硬拦 + 要我同意档的写文件边界。每次启动重写，改了也没用。",
    `import { secretToolCall } from ${JSON.stringify(SECRET_GUARD_MODULE)};`,
    `import { guardToolCall } from ${JSON.stringify(WRITE_GUARD_MODULE)};`,
    `import { payloadToWorkspace, toWorkspace } from ${JSON.stringify(WORKSPACE_PATHS_MODULE)};`,
    `const opts = ${JSON.stringify(opts)};`,
    "export default function guard(pi) {",
    "  pi.on(\"tool_call\", async (event, ctx) => {",
    "    // 先改路径再检查：硬拦和审批卡看到的都是真正要碰的位置。",
    "    const input = toWorkspace(event.toolName, event.input, opts.workspace);",
    "    const ev = input ? { ...event, input } : event;",
    "    const verdict = secretToolCall(ev, { ...opts, cwd: opts.cwd || ctx?.cwd })",
    "      ?? (opts.writeBoundary ? await guardToolCall(ev, ctx, opts) : undefined);",
    "    return verdict ?? (input ? { input } : undefined);",
    "  });",
    "  pi.on(\"before_provider_request\", (event, ctx) => payloadToWorkspace(event.payload, opts.cwd || ctx?.cwd, opts.workspace));",
    "}",
    "",
  ].join("\n");
}

/**
 * 嵌入模型。multilingual = intfloat/multilingual-e5-large，中文换说法也召回得到；
 * 实测数据和内存代价见 CHANGELOG 0.2.0 的「嵌入模型的选择」。
 */
export const MEMORY_EMBEDDING_VARIANT = "multilingual";

/**
 * 「要我同意」档自动放行的只读命令（OMP bash.patterns，`*` 是唯一通配）。
 * 只收不会再起别的程序的命令；写文件在 write 档本来就自动放行，这里管的是 exec。
 * 不收 git：write 档能直接改 .git/config 和 .gitattributes，git status/diff 会因此跑
 * core.fsmonitor、diff.external、textconv 指向的程序，等于绕过 exec 审批。
 */
export const READ_ONLY_BASH_PATTERNS = Object.freeze([
  "pwd", "ls", "ls *", "cat *", "head *", "tail *", "wc *", "stat *", "file *",
  "du *", "df", "df *", "tree", "tree *", "which *", "whoami", "date", "uname", "uname *",
  "echo *", "grep *",
]);

/**
 * `<provider>/<model-id>[:<effort>]` 的显式选择。没有 provider 前缀返回 null（不猜 provider）。
 */
export function splitSelector(model) {
  const raw = typeof model === "string" ? model.trim() : "";
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  return { raw, provider: raw.slice(0, slash), rest: raw.slice(slash + 1) };
}

/** 记忆相关角色：default、smol、memory 全钉在选定模型（值用原始 selector，含思考档）。 */
export function memoryModelRoles(model) {
  const sel = splitSelector(model);
  if (!sel) return null;
  return { default: sel.raw, smol: sel.raw, memory: sel.raw };
}

/**
 * 只关用户级上下文文件。项目级都打开：team 是 git 仓库，omp 往上找 AGENTS.md 停在 team 根，
 * bot 读到 team 和自己两层（先通用后具体）。
 */
const CONTEXT_FILES_TO_DISABLE = [
  "context-file:user:AGENTS.md",
  "context-file:user:CLAUDE.md",
  "context-file:user:GEMINI.md",
];

/** 用户级 skills/规则来源开关（项目级保持默认，供 bot 私有 .omp/skills 使用）。 */
const USER_SOURCE_TOGGLES = [
  "enablePiUser",
  "enableAgentsUser",
  "enableClaudeUser",
  "enableCodexUser",
  "enableOpencodeUser",
];

/**
 * persona.md 只留 omp-bot 必须注入的内容：团队工具怎么用、渠道消息的格式。
 * 名字、角色、专属指令在 team/bots/<id>/AGENTS.md 的身份块里，说话方式和征求同意在 team/AGENTS.md。
 */
export function personaText({ workspace, botDir } = {}) {
  return [
    `# 团队协作`,
    ``,
    `你是 omp-bot 团队的常驻成员。你是谁、怎么说话、做事规矩，见项目里的两层 AGENTS.md：team 根下是团队共识，bots/<你的 id>/ 下是你自己的身份。`,
    ``,
    `- 你可以用 message_bot 工具给团队里的其他 bot 发消息并直接拿到它的回复。`,
    `- 需要对方在后台并行处理时用 delegate_bot：它立即返回子 Run id，你之后可以继续做自己的事。`,
    `- 派活和问队友时，对方看不到你的对话：把背景、相关文件、现状和约束写全，别只丢一句「按刚才说的做」。`,
    `- 团队都该知道的事（约定、资料位置、被纠正过的说法）用 propose_team_fact 提议，写清来源；用户或主助手确认后才进团队共识。`,
    `- 只跟你自己有关、要长期记住的事（主人的偏好、约定、踩过的坑），能写文件时就记进你自己的 ${botDir ? join(botDir, "AGENTS.md") : "bots/<你的 id>/AGENTS.md"}，写在身份块结束标记后面，一条一行，带上日期和来源；新会话、重启后都会读到。身份块里面别改，密码和密钥别记。`,
    `- 每条消息第一行是方括号标签，写着场景和发送者，形如「[私聊，用户]」「[私聊，🤖 名字 (@id)]」「[群聊，产品群]」。记事时把来源一起记下。`,
    `- 群聊里，如果这轮你没有实质内容要说，只回复 [PASS]。`,
    `- 想点名某个成员接着说，用 @名字。`,
    `- 跨合作范围（不同工作区）的私有上下文不共享；不要索要其他工作区的私有资料。`,
    `- 回答简洁、直接，别复述规则本身。`,
    ...(workspace ? [`- 主人给你的工作区是 ${workspace}，主人的项目和文件都在这里。相对路径和不带 cwd 的命令都落在工作区；你自己的文件（笔记、work/）用绝对路径。`] : []),
  ].join("\n");
}

/**
 * 为一个 bot 准备人格文件与 config overlay，返回启动时要追加的 argv。
 * @param {object} bot 花名册记录
 * @param {string} dir 该 bot 的私有目录（放 persona 文件、overlay、session）
 * @param {object} [opts]
 * @param {string[]} [opts.extraDisabledExtensions] 额外要禁用的扩展 id（如 chat 档逐个关掉的 `mcp:<name>`）
 * @param {string} [opts.librarySkillsDir] 共享技能库目录（team/skills），写进 skills.customDirectories
 * @param {{dbPath:string, bank:string}} [opts.memory] 开启记忆时必填：mnemopi 库文件和 bank
 * @param {{cwd?:string, roots?:string[]}} [opts.writeRoots] 要我同意档可直接写的目录（bot cwd 和工作区）
 * @param {{ompbotHome?:string, agentDirs?:string[]}} [opts.secretDirs] 除了 ~ 下的常见凭据，还要硬拦的位置
 */
export function writePersonaFiles(bot, dir, opts = {}) {
  mkdirSync(dir, { recursive: true });
  const personaPath = join(dir, "persona.md");
  writeFileSync(personaPath, personaText({ workspace: bot.workspace, botDir: opts.writeRoots?.cwd }), "utf8");

  const extraDisabled = Array.isArray(opts.extraDisabledExtensions) ? opts.extraDisabledExtensions : [];
  const overlayPath = join(dir, "isolate.yml");
  const lines = [
    "# omp-bot 生成的隔离 overlay（每 bot 一份，不改用户全局配置）。",
    "# 1) 逐文件关掉用户级上下文文件，项目级（team 和 bot 两层 AGENTS.md）打开；不用整源开关，避免连原生 MCP 一起废掉。",
    "disabledExtensions:",
    ...CONTEXT_FILES_TO_DISABLE.map((id) => `  - ${id}`),
    ...extraDisabled.map((id) => `  - ${id}`),
    "skills:",
    ...USER_SOURCE_TOGGLES.map((k) => `  ${k}: false`),
  ];
  if (opts.librarySkillsDir) {
    // 共享技能库：每个 bot 都从 team/skills 发现，加载哪些由 --skills 白名单决定。
    // JSON 字符串就是合法的 YAML 双引号串，Windows 路径里的反斜杠和冒号不会出问题。
    lines.push("  customDirectories:", `    - ${JSON.stringify(opts.librarySkillsDir)}`);
  }

  if (bot.memoryEnabled === true) {
    const mem = opts.memory ?? {};
    // 缺库路径就不写记忆段：omp 会退回用户自己 agentDir 下的 mnemopi 库，和用户记忆混在一个文件里。
    if (typeof mem.dbPath !== "string" || !mem.dbPath || typeof mem.bank !== "string" || !mem.bank) {
      throw new Error("开启记忆需要 team 里的记忆库路径和 bank 名");
    }
    // JSON 串就是合法的 YAML 双引号串，Windows 路径里的反斜杠和冒号不会出问题。
    lines.push(
      "# 2) 记忆由用户显式开启：mnemopi，每个 bot 一个 bank，库在 team/.memory，私聊群聊通用。",
      "#    autolearn 关掉，记忆只走 mnemopi 的自动召回和自动存档。",
      "memory:",
      "  backend: mnemopi",
      "mnemopi:",
      "  scoping: global",
      `  bank: ${JSON.stringify(mem.bank)}`,
      `  dbPath: ${JSON.stringify(mem.dbPath)}`,
      `  embeddingVariant: ${MEMORY_EMBEDDING_VARIANT}`,
      "autolearn:",
      "  enabled: false",
    );
    // 记忆抽取用 smol 角色选模型；不钉住就会落到用户全局配置里的别的 provider。
    // overlay 层压在全局配置之上，所以这三个角色只用选定模型。
    const roles = memoryModelRoles(bot.model);
    if (roles) {
      lines.push(
        "# 2b) 记忆相关角色钉在选定模型上（overlay 层覆盖用户全局 modelRoles）。",
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
    "# 2c) 秘密不进模型：OMP 在发给模型前把 secrets.yml（用户的 agent 目录和 bots/<id>/.omp/）里配的秘密、",
    "#     名字像密钥的环境变量值、像凭据的串（sk-、ghp_ 之类）换成占位符，工具执行前再换回原文。",
    "#     本地会话文件里仍是原文（OMP 的设计），所以 bots/*/sessions/ 和 secrets.yml 都不进 team 的 git。",
    "secrets:",
    "  enabled: true",
  );

  lines.push(
    "# 3) 团队工具显式声明审批档：未声明的原生 host tool 默认按 exec 处理，",
    "#    会在 supervised/write 下每次都弹卡。派活三个工具的边界由宿主 admission 保证：",
    "#    同工作区、父预算/能力交集内自动；忙目标与越域一律拒绝。",
    "#    团队事实提议只记一条待确认，不改文件；审核由宿主核对主助手身份。",
    "#    不在此宽泛放行任何内置工具或 task。",
    "tools:",
    "  approval:",
    "    message_bot: allow",
    "    list_bots: allow",
    "    delegate_bot: allow",
    "    propose_team_fact: allow",
    "    review_team_proposals: allow",
  );
  if (bot.computer && bot.executionMode !== "chat") {
    // 共享电脑是给 bot 的独立 Linux 用户，权限交给客机，两个可执行档都不弹审批。
    // 装系统包例外：用户级 prompt 在 yolo 下也生效，全部放手档同样会问。
    for (const name of COMPUTER_TOOL_NAMES) {
      lines.push(`    ${name}: ${COMPUTER_PROMPT_TOOLS.includes(name) ? "prompt" : "allow"}`);
    }
  }

  if (bot.executionMode === "chat") {
    // chat 档使用受控工具来源，关闭项目 MCP：
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

  if (bot.executionMode === "supervised" && (bot.approvalMode ?? "write") === "write") {
    // 4c) 「要我同意」档：只读命令不弹卡。走 OMP 原生 bash.patterns，规则在 OMP 里按真实参数判：
    //     allow 只认整条简单命令，带 ; | & > $ ` ( 等控制符或 -c/-e 重解释参数的一律不算命中；
    //     rm -rf / 这类关键模式照样强制弹卡。命中后按 write 档放行，和改文件同一级。
    //     刻意不收 rg（--pre 能跑程序）、find（-exec/-delete）、sed（e 命令）、awk（system()）、xargs、env、git。
    lines.push(
      "# 4c) 要我同意档：只读命令直接放行（OMP 原生 bash.patterns，零 token）。",
      "bash:",
      "  allowCompoundCommands: true",
      "  patterns:",
      ...[...READ_ONLY_BASH_PATTERNS, ...(bot.allowedCommands ?? [])].map((match) => `    - { match: ${JSON.stringify(match)}, approval: allow }`),
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

  const argv = ["--append-system-prompt", personaPath, "--config", overlayPath];
  if (bot.executionMode !== "chat") {
    // 4d) 一个 tool_call 扩展，两条规矩（OMP 原生扩展点，文件放 bot 私有目录、不在 cwd 里，每次启动重写）：
    //     任何档位碰密钥目录一律拦；要我同意档的 write/edit/ast_edit 写到 bot 目录、工作区、临时目录以外先弹卡。
    const guardPath = join(dir, "guard.js");
    const wr = opts.writeRoots ?? {};
    writeFileSync(guardPath, guardExtensionSource({
      cwd: typeof wr.cwd === "string" ? wr.cwd : "",
      roots: Array.isArray(wr.roots) ? wr.roots.filter((r) => typeof r === "string" && r) : [],
      writeBoundary: bot.executionMode === "supervised" && (bot.approvalMode ?? "write") === "write",
      secrets: secretPaths(opts.secretDirs),
      workspace: typeof bot.workspace === "string" ? bot.workspace : "",
    }), "utf8");
    argv.push("--extension", guardPath);
  }

  return { personaPath, overlayPath, argv };
}
