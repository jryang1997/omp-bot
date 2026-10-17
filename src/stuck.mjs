// stuck.mjs — 卡住/死循环检测。纯函数，不碰模型、不碰进程。
//
// 指纹 = 工具名 + 参数 + 结果（含 isError）。参数相同但结果变了不算重复：
// 那是在推进（比如轮询到了新状态）。按整次 Run 计数而不是只看连续，
// 这样 A、B、A、B 交替打转也能抓到。

import { createHash } from "node:crypto";
import { STUCK_STEER_AT, STUCK_CANCEL_AT } from "./constants.mjs";

/** 取消原因的机器前缀；后面跟给人看的那句话。 */
export const STUCK_CODE = "stuck-loop";

// 超时、限流、5xx、断连：等一等可能就好了，同样的报错多几次不一定是打转，阈值翻倍。
const TRANSIENT = /timed?\s*out|timeout|rate[\s_-]?limit|too many requests|\b429\b|\b50[234]\b|bad gateway|service unavailable|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|temporarily unavailable/i;

function resultText(result) {
  const content = result && typeof result === "object" ? result.content : null;
  if (!Array.isArray(content)) return typeof result === "string" ? result : "";
  return content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("\n");
}

export function isTransientError(result, isError) {
  return isError === true && TRANSIENT.test(resultText(result));
}

/** 键排序的 JSON，保证同样的对象得到同样的串。 */
function stable(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
}

// OMP 18.11 起，同一文件读到第 3 次一样的内容会在结果末尾加一句计数提示（"[You have received this
// identical output N times...]"）。计数每次都变，不去掉的话真重复永远对不上指纹。真 omp 上测出来的。
const OMP_REPEAT_NOTE = /\n*\[You have received this identical output \d+ times[^\]]*\]\s*$/;

function stripRepeatNote(content) {
  if (!Array.isArray(content)) return content;
  return content.map((part) =>
    part && part.type === "text" && typeof part.text === "string" ? { ...part, text: part.text.replace(OMP_REPEAT_NOTE, "") } : part,
  );
}

export function toolFingerprint(toolName, args, result, isError) {
  const h = createHash("sha256");
  h.update(String(toolName ?? ""));
  h.update("\0");
  h.update(stable(args));
  h.update("\0");
  // 只取模型看到的 content；details 里常有耗时、时间戳，会让真重复看起来不一样。
  h.update(stable(result && typeof result === "object" && "content" in result ? stripRepeatNote(result.content) : result));
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
      const slack = isTransientError(frame.result, frame.isError) ? 2 : 1;
      if (count >= cancelAt * slack) {
        cancelled = true;
        return { action: "cancel", toolName: frame.toolName ?? null, count };
      }
      if (count >= steerAt * slack && !steered.has(fp)) {
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

/** 停下时给用户（和父助手）看的那句话。 */
export function stuckStopText(toolName, count) {
  return `我先停下了：同样的 ${toolName} 调用做了 ${count} 次，结果一直没变，再做下去也不会有进展。可以补充信息、换个说法，或者告诉我换什么办法，我再接着做。`;
}

export function stuckCancelReason(toolName, count) {
  return `${STUCK_CODE}: ${stuckStopText(toolName, count)}`;
}

/** 卡住取消的原因里抠出人话；不是卡住取消返回 null。 */
export function stuckNotice(error) {
  const s = typeof error === "string" ? error : "";
  return s.startsWith(`${STUCK_CODE}: `) ? s.slice(STUCK_CODE.length + 2).split("; ")[0] : null;
}
