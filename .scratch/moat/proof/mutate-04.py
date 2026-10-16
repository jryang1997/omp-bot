# 04 变异测试：逐个拆掉团队事实提议的一环，相关测试必须变红；跑完恢复原文件。
# 用法：python3 .scratch/moat/proof/mutate-04.py
import subprocess, pathlib
M = [
  ("接受时不核对旧事实还在不在", "src/orchestrator.mjs", "const problem = this._teamFactProblem(rec, text, { atAccept: true });", "const problem = null;", ["test/team-memory.mjs"]),
  ("纠正过的旧说法不拦", "src/orchestrator.mjs", "if (p.replaces) replaced.set(normalizeFact(p.replaces), normalizeFact(p.fact));", "", ["test/team-memory.mjs"]),
  ("提议时不查要替换的那条", "src/orchestrator.mjs", "if (replaces && !hasFact(agentsText, replaces)) {", "if (false) {", ["test/team-memory.mjs"]),
  ("不要求来源", "src/orchestrator.mjs", 'if (!src) throw httpErr(400, "要写清来源：这条事实从哪来。", "bad_source");', "", ["test/team-memory.mjs"]),
  ("普通 bot 也能接受", "src/orchestrator.mjs", 'if (by?.kind === "bot" && this.getBot(by.botId)?.isMain === true) return;', 'if (by?.kind === "bot") return;', ["test/team-memory.mjs"]),
  ("审核工具发给所有 bot", "src/orchestrator.mjs", "    if (bot.isMain === true) {\n      tools.push({\n        name: \"review_team_proposals\",", "    if (true) {\n      tools.push({\n        name: \"review_team_proposals\",", ["test/team-memory.mjs"]),
  ("接受后不提交", "src/orchestrator.mjs", "this.team.commit(`团队事实：${this._deciderName(by)}接受了 ${rec.botName ?? \"用户\"} 的提议`);", "", ["test/team-memory.mjs"]),
  ("替换时追加而不是原位替换", "src/team-facts.mjs", "    lines[at] = line;", "    lines.splice(at + 1, 0, line);", ["test/team-memory.mjs"]),
  ("团队事实接口对设备开放", "src/server.mjs", '{ method: "GET", path: ["api", "team", "facts"], run: () => ({', '{ method: "GET", path: ["api", "team", "facts"], access: "any", run: () => ({', ["test/http-boundaries.mjs"]),
]
out = []
for name, path, a, b, tests in M:
  p = pathlib.Path(path); orig = p.read_text()
  assert orig.count(a) == 1, f"变异点不唯一或找不到：{name}"
  try:
    p.write_text(orig.replace(a, b))
    red = []
    for t in tests:
      r = subprocess.run(["node", t], capture_output=True, text=True, timeout=300)
      if r.returncode != 0:
        fails = [l[6:] for l in r.stdout.splitlines() if l.startswith("FAIL")]
        red.append(f"{t}" + (f"（{fails[0]}）" if fails else ""))
    out.append(f"- {name}：{'抓到 ' + '；'.join(red) if red else '没抓到'}")
    print(out[-1], flush=True)
  finally:
    p.write_text(orig)
pathlib.Path(".scratch/moat/proof/mutate-04.txt").write_text("\n".join(out) + "\n")
