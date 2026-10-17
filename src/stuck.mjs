// stuck.mjs — 卡住/死循环检测。纯函数，不碰模型、不碰进程。
//
// 指纹 = 工具名 + 参数 + 结果（含 isError）。参数相同但结果变了不算重复：
// 那是在推进（比如轮询到了新状态）。按整次 Run 计数而不是只看连续，
// 这样 A、B、A、B 交替打转也能抓到。

import { createHash } from "node:crypto";
import { STUCK_STEER_AT, STUCK_CANCEL_AT } from "./constants.mjs";

/** 键排序的 JSON，保证同样的对象得到同样的串。 */
function stable(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
}

export function toolFingerprint(toolName, args, result, isError) {
  const h = createHash("sha256");
  h.update(String(toolName ?? ""));
  h.update("\0");
  h.update(stable(args));
  h.update("\0");
  // 只取模型看到的 content；details 里常有耗时、时间戳，会让真重复看起来不一样。
  h.update(stable(result && typeof result === "object" && "content" in result ? result.content : result));
  h.update(isError ? "\0E" : "\0");
  return h.digest("hex").slice(0, 32);
}

/**
 * 一次 Run 一个检测器。observe(frame) 吃原生帧，返回 null 或
 * { action: "steer" | "cancel", toolName, count }。每个指纹最多 steer 一次，cancel 只报一次。
 */
export function createStuckDetector({ steerAt = STUCK_STEER_AT, cancelAt = STUCK_CANCEL_AT } = {}) {
  const argsByCall = new Map();
  const counts = new Map();
  const steered = new Set();
  let cancelled = false;
  return {
    observe(frame) {
      if (!frame || cancelled) return null;
      if (frame.type === "tool_execution_start") {
        if (frame.toolCallId) argsByCall.set(frame.toolCallId, frame.args);
        return null;
      }
      if (frame.type !== "tool_execution_end") return null;
      const args = argsByCall.get(frame.toolCallId);
      argsByCall.delete(frame.toolCallId);
      const fp = toolFingerprint(frame.toolName, args, frame.result, frame.isError === true);
      const count = (counts.get(fp) ?? 0) + 1;
      counts.set(fp, count);
      if (count >= cancelAt) {
        cancelled = true;
        return { action: "cancel", toolName: frame.toolName ?? null, count };
      }
      if (count >= steerAt && !steered.has(fp)) {
        steered.add(fp);
        return { action: "steer", toolName: frame.toolName ?? null, count };
      }
      return null;
    },
  };
}

export function stuckSteerText(toolName, count) {
  return `【omp-bot 提示】你已经用同样的参数调用 ${toolName} ${count} 次，结果都没变。不要再重复这一步。换个办法；如果确实做不到，就停下来说明卡在哪、需要谁做什么。`;
}
