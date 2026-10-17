// 审批卡上「以后都允许这条命令」：只收能原样写进 OMP bash.patterns 的命令。

/** 每个助手最多记多少条，防止名单无限长成「其实全放开」。 */
export const MAX_ALLOWED_COMMANDS = 50;

// `*` 在 bash.patterns 里是通配，记进去就不是「这条命令」了；引号、转义和控制符交给 OMP 判，
// 这里直接不收，免得记下的串和 OMP 解析后的命令对不上。
const UNSAFE = /[*?;&|<>$`()\\'"\n\r\t{}[\]#~!]/;

export function isRememberableCommand(cmd) {
  return typeof cmd === "string" && cmd.length > 0 && cmd.length <= 200 && cmd === cmd.trim() && !/\s{2}/.test(cmd) && !UNSAFE.test(cmd);
}

/**
 * 从 OMP 原生审批卡标题里取出 bash 命令（格式见 OMP bash 工具的 formatApprovalDetails：
 * `Allow tool: bash` 换行 `Command: <命令>`）。带 Reason 的是规则强制弹卡，记了也没用，不收。
 */
export function rememberableCommand(title) {
  const lines = typeof title === "string" ? title.split("\n") : [];
  if (lines.length !== 2 || lines[0] !== "Allow tool: bash" || !lines[1].startsWith("Command: ")) return null;
  const cmd = lines[1].slice("Command: ".length);
  return isRememberableCommand(cmd) ? cmd : null;
}

export function normalizeAllowedCommands(list) {
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list)) throw new Error("allowedCommands 必须是数组");
  const out = [...new Set(list)];
  const bad = out.find((c) => !isRememberableCommand(c));
  if (bad !== undefined) throw new Error(`allowedCommands 里有不能原样放行的命令: ${JSON.stringify(bad)}`);
  if (out.length > MAX_ALLOWED_COMMANDS) throw new Error(`allowedCommands 最多 ${MAX_ALLOWED_COMMANDS} 条`);
  return out;
}
