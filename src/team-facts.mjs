// team-facts.mjs — team/AGENTS.md 里「团队事实」块的读写（纯函数，不碰磁盘）。
//
// 块用注释标出起止，每条一行：`- 事实（来源：…）`。块外是用户和主助手手写的规矩，这里不碰。
// 冲突判断只看事实正文（去掉末尾的来源括注），所以用户手改来源不影响匹配。

export const FACTS_HEADING = "## 团队事实";
export const FACTS_START = "<!-- omp-bot 团队事实块开始。成员的提议经用户或主助手接受后写在这里；你也可以直接改。 -->";
export const FACTS_END = "<!-- omp-bot 团队事实块结束 -->";
export const FACT_MAX_CHARS = 500;

/** 事实正文规范化：去首尾空白、开头的列表符，合并连续空白。 */
export function normalizeFact(text) {
  return String(text ?? "").trim().replace(/^[-*]\s+/, "").replace(/\s+/g, " ");
}

const SOURCE_SUFFIX = /（来源：[^（）]*）$/;

function block(text) {
  const src = String(text ?? "");
  const start = src.indexOf(FACTS_START);
  if (start < 0) return null;
  const end = src.indexOf(FACTS_END, start);
  if (end < 0) return null;
  return { start, bodyStart: start + FACTS_START.length, end };
}

/** 读出块里的事实：[{text, line}]，text 是去掉来源括注的正文。没有块返回 []。 */
export function readFacts(agentsText) {
  const b = block(agentsText);
  if (!b) return [];
  return String(agentsText)
    .slice(b.bodyStart, b.end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => ({ line, text: normalizeFact(normalizeFact(line).replace(SOURCE_SUFFIX, "")) }));
}

export function hasFact(agentsText, fact) {
  const want = normalizeFact(fact);
  return readFacts(agentsText).some((f) => f.text === want);
}

function renderLine(fact, source) {
  const s = normalizeFact(source).replace(/[（）]/g, "");
  return `- ${normalizeFact(fact)}${s ? `（来源：${s}）` : ""}`;
}

/**
 * 把一条事实写进块里；replaces 给了就原位替换那一条。没有块就在文末建一个。
 * 调用方先用 hasFact 判断冲突，这里找不到 replaces 直接抛错，不猜。
 */
export function applyFact(agentsText, { fact, source, replaces = null }) {
  const src = String(agentsText ?? "");
  const line = renderLine(fact, source);
  const b = block(src);
  if (!b) {
    if (replaces) throw new Error("没有团队事实块，无从替换");
    const sep = src.trim() ? `${src.replace(/\s*$/, "")}\n\n` : "";
    return `${sep}${FACTS_HEADING}\n\n${FACTS_START}\n${line}\n${FACTS_END}\n`;
  }
  const lines = src.slice(b.bodyStart, b.end).split(/\r?\n/);
  if (replaces) {
    const want = normalizeFact(replaces);
    const at = lines.findIndex((l) => /^\s*[-*]\s+/.test(l) && normalizeFact(normalizeFact(l).replace(SOURCE_SUFFIX, "")) === want);
    if (at < 0) throw new Error("没找到要替换的事实");
    lines[at] = line;
  } else {
    // 块体以换行开头、以换行结尾；新事实加在最后一条后面。
    while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push(line, "");
  }
  let body = lines.join("\n");
  if (!body.startsWith("\n")) body = `\n${body}`;
  if (!body.endsWith("\n")) body = `${body}\n`;
  return `${src.slice(0, b.bodyStart)}${body}${src.slice(b.end)}`;
}
