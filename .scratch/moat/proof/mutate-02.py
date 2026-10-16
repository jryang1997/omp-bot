# 02 变异测试：逐个拆掉外部动作记录的一环，相关测试必须变红；跑完恢复原文件。
# 用法：python3 .scratch/moat/proof/mutate-02.py
import subprocess, pathlib
M = [
  ("电脑工具不记 in_flight", "src/features/computers.mjs", "if (mutating) effectId = this.orch.beginSideEffect?.(runId, { tool: name, kind }) ?? null;", "", ["test/computers.mjs"]),
  ("电脑工具做完不记 done", "src/features/computers.mjs", "if (effectId) this.orch.endSideEffect?.(runId, effectId, { ok: true });", "", ["test/computers.mjs", "test/runs.mjs"]),
  ("断流不记 unknown", "src/features/computers.mjs", "{ ok: false, unknown, error: e?.message ?? String(e) }", "{ ok: false, unknown: false, error: e?.message ?? String(e) }", ["test/computers.mjs"]),
  ("重启不把在飞那笔改 unknown", "src/ledger.mjs", 's?.status === "in_flight" ? { ...s, status: "unknown", outcome: "unknown", endedAt: now } : s,', "s,", ["test/runs.mjs"]),
  ("落定动作写回 in_flight", "src/orchestrator.mjs", 'status: unknown ? "unknown" : "done",', 'status: unknown ? "unknown" : "in_flight",', ["test/runs.mjs"]),
  ("动作键不按次数区分", "src/orchestrator.mjs", "const id = `${tool}#${n}`;", "const id = `${tool}#1`;", ["test/runs.mjs"]),
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
pathlib.Path(".scratch/moat/proof/mutate-02.txt").write_text("\n".join(out) + "\n")
