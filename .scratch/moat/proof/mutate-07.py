# 07 变异测试：逐个拆掉交接简报和验收标准的一环，相关测试必须变红；跑完恢复原文件。
# 用法：python3 .scratch/moat/proof/mutate-07.py
import subprocess, pathlib, os
O = "src/orchestrator.mjs"
D = ["test/delegation.mjs"]
UI = [("工作台截图检查", ["node", "omp-bot/.scratch/moat/proof/ui/shot-handoff.mjs"], "/data")]
M = [
  ("开跑不附验收标准", O, "          text: delegationTaskText(rec),", "          text: rec.message,", D),
  ("交回不带验收标准", O, '  if (list.length) lines.push("验收标准：", ...acceptanceLines(list));', "", D),
  ("验收标准不存进派活记录", O, "      ...(acceptance.length ? { acceptance } : {}),\n", "", D),
  ("不校验直接收", O, "      acceptance = normalizeAcceptance(args?.acceptance);", "      acceptance = Array.isArray(args?.acceptance) ? args.acceptance : [];", D),
  ("不去空白空行", O, "raw.map((x) => x.trim()).filter(Boolean)", "raw.slice()", D),
  ("条数上限不查", O, "if (list.length > MAX_ACCEPTANCE_ITEMS) throw", "if (false) throw", D),
  ("字数上限不查", O, "list.find((x) => x.length > MAX_ACCEPTANCE_CHARS)", "list.find(() => false)", D),
  ("交回不提醒逐条核对", O, '"请按上面的验收标准逐条核对：没满足的再派或自己补上；已经做完的不要重复派。"', '"请验收：结果不对就再派或自己补上；已经做完的不要重复派。"', D),
  ("模型看到的上限和校验不一致", O, "      maxItems: MAX_ACCEPTANCE_ITEMS,", "      maxItems: 20,", D),
  ("工具说明不讲对方看不到对话", O, "交接简报。对方看不到你和用户的对话，", "交接简报。", D),
  ("人设不提醒写全背景", "src/persona.mjs", "    `- 派活和问队友时，对方看不到你的对话：把背景、相关文件、现状和约束写全，别只丢一句「按刚才说的做」。`,\n", "", D),
  ("工作台不显示验收标准", "web/workbench-panels.js", "    if (acceptance.length) {\n      root.append", "    if (false) {\n      root.append", UI),
]
env = {**os.environ, "PLAYWRIGHT": "/vercel/sandbox/node_modules/playwright/index.mjs"}
out = []
for name, path, a, b, tests in M:
  p = pathlib.Path(path); orig = p.read_text()
  assert orig.count(a) == 1, f"变异点不唯一或找不到：{name}"
  try:
    p.write_text(orig.replace(a, b))
    red = []
    for t in tests:
      label, cmd, cwd = (t, ["node", t], None) if isinstance(t, str) else t
      r = subprocess.run(cmd, capture_output=True, text=True, timeout=300, cwd=cwd, env=env)
      if r.returncode != 0:
        fails = [l[6:] for l in r.stdout.splitlines() if l.startswith("FAIL")]
        red.append(f"{label}" + (f"（{fails[0].split('  ')[0]}）" if fails else ""))
    out.append(f"- {name}：{'抓到 ' + '；'.join(red) if red else '没抓到'}")
    print(out[-1], flush=True)
  finally:
    p.write_text(orig)
pathlib.Path(".scratch/moat/proof/mutate-07.txt").write_text("\n".join(out) + "\n")
