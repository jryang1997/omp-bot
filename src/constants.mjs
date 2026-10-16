// constants.mjs — 编排层的领域常量。
// 群聊/投递相关阈值抄自 DS-Bot（groups.js/constants.js/delivery.js），
// 那些值是作者踩坑调出来的，连数值一起借用。

/** bot→bot 消息的最大跳数，防止两个 bot 无限互相转派。 */
export const MAX_HOPS = 6;

/** 等待收件 bot 回合结束（拿到 reply）的超时。 */
export const DELIVER_TIMEOUT_MS = 240_000;

/** 群聊回合里等待某成员发言的超时。 */
export const ROOM_TURN_TIMEOUT_MS = 240_000;

/** 群模式。admin=默认，普通消息只给 admin，由它 @ 人；everyone=轮流答，admin 先。 */
export const ROOM_MODES = ["admin", "everyone"];

/** 一个群回合里，普通成员最多 @ 点名几次；admin 翻倍。 */
export const MENTION_LIMIT_PER_ROUND = 2;
export const ADMIN_MENTION_LIMIT_PER_ROUND = 4;

/** bot 在没人（用户）发言的情况下，自发在群里连续开回合的上限。 */
export const ROOM_BOT_ROUNDS = 3;

/** room.log 只保留最近多少条消息进 prompt（更早的靠会话自身上下文/压缩）。 */
export const ROOM_LOG_KEEP = 60;

/** 群回合总数硬上限，防止 @ 链导致的长尾。 */
export const ROOM_MAX_ROUNDS = 12;

/** 成员发言为空或等于此标记时视为「本轮不发言」。 */
export const PASS_TOKEN = "[PASS]";

/** 团队状态文件的 schema 版本，用于迁移。 */
export const STATE_VERSION = 1;

/** 默认握手/prompt 超时（单次 RPC 命令）。 */
export const RPC_COMMAND_TIMEOUT_MS = 30_000;

/** 等 ready 帧的超时。 */
export const RPC_STARTUP_TIMEOUT_MS = 90_000;

// ---- Run 生命周期（与 Ledger 的 state 字段一致）----
// 状态只能由宿主真实事件推动：native prompt_result 只是「本次 yield」，
// 只有原生 session 真正 settled（session_settled / get_state.isSettled）才算静默。

export const RUN_STATES = {
  QUEUED: "queued",
  STARTING: "starting",
  RUNNING: "running",
  WAITING_INPUT: "waiting_input",
  WAITING_APPROVAL: "waiting_approval",
  CANCELLING: "cancelling",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  INTERRUPTED: "interrupted",
  /** 对外副作用是否发生未知，必须人工/对账后才能继续，禁止自动重放。 */
  RECONCILIATION_REQUIRED: "reconciliation_required",
};

/** 终态：不再接受新的 native 回合，也不允许被重新打开。 */
export const TERMINAL_RUN_STATES = new Set([
  RUN_STATES.COMPLETED,
  RUN_STATES.FAILED,
  RUN_STATES.CANCELLED,
  RUN_STATES.INTERRUPTED,
  RUN_STATES.RECONCILIATION_REQUIRED,
]);

export const RUN_KINDS = ["chat", "room", "delegation"];

// ---- 执行环境与审批档（不是 OS 沙箱）----

/** chat=--no-tools 只有宿主受控工具；supervised=原生审批；full=本机完全能力。 */
export const EXECUTION_MODES = ["chat", "supervised", "full"];
/** 能力强度序：子 Run 不得越过父 Run 的档位。 */
export const EXECUTION_MODE_RANK = { chat: 0, supervised: 1, full: 2 };
export const DEFAULT_EXECUTION_MODE = "supervised";

/** 透传给原生 --approval-mode。 */
export const APPROVAL_MODES = ["always-ask", "write", "yolo"];
export const DEFAULT_APPROVAL_MODE = "write";

/**
 * 用户可见的三档权限。内部仍存执行档和审批档，每档只对应一种组合：
 * chat 只聊天；ask 本机运行命令和操作浏览器前先问（原生 write 审批）；full 全部放手。
 * 共享电脑工具在 ask 和 full 下都不问，装系统包例外（见 persona overlay）。
 */
export const PERMISSION_LEVELS = Object.freeze({
  chat: Object.freeze({ executionMode: "chat", approvalMode: "write" }),
  ask: Object.freeze({ executionMode: "supervised", approvalMode: "write" }),
  full: Object.freeze({ executionMode: "full", approvalMode: "yolo" }),
});
export const DEFAULT_PERMISSION = "ask";

/** 共享电脑的客机工具名（与合同一致；工具 schema 里没有 computerId/endpoint/token/localPath）。 */
export const COMPUTER_TOOL_NAMES = Object.freeze([
  "computer_screenshot",
  "computer_input",
  "computer_shell",
  "computer_files",
  "computer_upload_attachment",
  "computer_install_packages",
  "computer_publish_file",
]);
/** 客机工具里每次都要用户批准的：overlay 写 prompt，omp 在 yolo 下也尊重，全部放手档同样会问。 */
export const COMPUTER_PROMPT_TOOLS = Object.freeze(["computer_install_packages"]);

export const DEFAULT_MEMORY_ENABLED = false;

// ---- 超时 / 上限 ----

/** 单次 Run 的默认回合上限（未被调用方覆盖时）。 */
export const RUN_TIMEOUT_MS = 600_000;
/** 改策略/模型/人格后，等待 runtime 空闲或显式取消的最长时间。 */
export const POLICY_IDLE_TIMEOUT_MS = 30_000;
/** 取消后等待原生真正静默的时长；超时就回收进程，不假装已停止。 */
export const CANCEL_SETTLE_TIMEOUT_MS = 5_000;
/** 工作台 UI 请求（审批/提问）的默认存活时间。到期即过期：不自动放行。 */
export const UI_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/** delegate_bot 异步子 Run 的最大嵌套深度。 */
export const MAX_DELEGATE_DEPTH = 4;
/** 等待子 Run 终态的默认时长（供 message_bot 同步等待）。 */
export const DELEGATE_WAIT_TIMEOUT_MS = 300_000;
/** 同时可在飞的 native 子代理/task 上限（原生 --max-time 之外的自有额度）。 */
export const DEFAULT_TASK_CONCURRENCY = 4;

/**
 * 会真正阻塞回合、等着用户作答的原生 UI 方法（其余是展示类状态更新）。
 * 依据 18.10.0 协议：interactive = select/confirm/input/editor/ask；
 * notify/setStatus/setWidget/setTitle/set_editor_text/... 只是 UI 状态，不产生审批、不占 TTL。
 */
export const UI_INTERACTIVE_METHODS = new Set(["select", "confirm", "input", "editor", "ask"]);

/** 明确不由工作台代答的方法（需要专用认证流程或仅终端显示）。 */
export const UI_UNANSWERABLE_METHODS = new Set(["secret"]);

/** native_event 单帧进台账/SSE 的体积上限；超过只留摘要（物理分块帧直接丢弃）。 */
export const NATIVE_EVENT_MAX_BYTES = 32 * 1024;
/** native_event 里字符串叶子超过该长度就截断为摘要，避免整段 transcript 重复入账。 */
export const NATIVE_EVENT_TEXT_LIMIT = 4096;

/**
 * 允许经工作台入口下发的原生命令（会话/模型/登录/技能/记忆/电脑操作）。
 * 其余命令一律拒绝，不提供任意 bash/eval/raw frame 通道。
 * 注意：原生全局记忆清理（memory_clear/clear_memory）不在集合内 —— 那会删掉用户所有
 * 项目的记忆队列；记忆只能按 bot 私有目录做目录级操作。
 */
export const NATIVE_COMMAND_ALLOWLIST = new Set([
  "new_session",
  "fork",
  "branch",
  "get_state",
  "get_session_stats",
  "get_available_models",
  "get_available_commands",
  "get_subagents",
  "set_subagent_subscription",
  "set_event_filter",
  "set_ask_dialog",
  "login",
  "logout",
]);
