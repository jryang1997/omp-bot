# 06 变异测试：逐个拆掉整棵派工树预算的一环，相关测试必须变红；跑完恢复原文件。
# 用法：python3 .scratch/moat/proof/mutate-06.py
import subprocess, pathlib
O = "src/orchestrator.mjs"
W = ["test/work-budget.mjs"]
M = [
  ("子任务不记树根", O, "      if (parent) treeRootId = this._treeRootOf(parent);", "", W),
  ("不留交回余量", O, "const TREE_RETURN_SHARE = 0.2;", "const TREE_RETURN_SHARE = 0;", W),
  ("准入不看整棵树", O, "    const tree = treeRootId ? this._treeBudget(treeRootId) : null;\n    if (tree) {\n      const spent", "    const tree = null;\n    if (tree) {\n      const spent", W),
  ("并行兄弟不占整棵树的预留", O, "      this._reserveTree(run.id, treeRootId, effectiveBudget);\n", "", ["test/runs.mjs"]),
  ("孙任务把祖先那份也算成别人的", O, "const others = isReturn ? 0 : (reservedT[field] ?? 0) - (mine?.[field] ?? 0);", "const others = isReturn ? 0 : (reservedT[field] ?? 0);", W),
  ("到余量线不停", O, "      this._checkTreeLine(runId);\n", "", W),
  ("停树时排队的直接丢掉", O, "      if (rec.state === \"queued\" && ids.has(rec.parentRunId)) this._returnNotStarted(rec, reason);", "", W),
  ("停树时连根一起停", O, "r && r.id !== currentRunId && r.id !== rootId && !r.returnOf &&", "r && r.id !== currentRunId && !r.returnOf &&", W),
  ("停树按父回合取消（交回被丢）", O, "this._background(this.cancelRun(r.id, `budget-exhausted:${reason}`));", "this._background(this.cancelRun(r.id, `parent-cancelled:${reason}`));", W),
  ("唤醒不进树（拿新的一份预算）", O, "        treeRootId: rec.parentRunId ? this._treeRootOf(this.getRun(rec.parentRunId)) : null,\n", "", W),
  ("唤醒也只能用到余量线", O, "      const ceil = isReturn ? tree.total : tree.line;\n      const reservedT", "      const ceil = tree.line;\n      const reservedT", W),
  ("根不看整棵树总额", O, "    if (!run.parentRunId) {\n      const rootId = this._treeRootOf(run);", "    if (false) {\n      const rootId = this._treeRootOf(run);", W),
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
pathlib.Path(".scratch/moat/proof/mutate-06.txt").write_text("\n".join(out) + "\n")
