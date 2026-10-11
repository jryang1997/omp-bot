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
