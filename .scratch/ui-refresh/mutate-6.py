# 第 6 步变异检查：每次改坏一处，polish-check 必须报错。用法：cd /data && python3 omp-bot/.scratch/ui-refresh/mutate-6.py
import subprocess, pathlib, os
os.chdir("/data/omp-bot")
M=[("手机页签回到横向滚动","web/style.css",".wb-task-bar > .bt-tabs { width: 100%; overflow: visible; }",".wb-task-bar > .bt-tabs { width: 100%; }\n  .wb-task-bar .bt-tab { padding: 7px 18px !important; }"),
   ("开关回到原生方框","web/style.css","appearance: none; flex: none; width: 40px !important;","flex: none;"),
   ("开关不换色","web/style.css","input[type=checkbox]:checked { background-color: var(--bt-accent);","input[type=checkbox]:checked {"),
   ("规格下拉框没样式","web/workbench-computer.js",'const cpuSelect = el("select", "bt-select");','const cpuSelect = el("select");'),
   ("浅色次要文字变回浅","web/style.css","--bt-ink-3: #6e717d;","--bt-ink-3: #747783;")]
for name,f,a,b in M:
  p=pathlib.Path(f); s=p.read_text(); assert a in s,name
  p.write_text(s.replace(a,b,1))
  try:
    r=subprocess.run(["node","omp-bot/.scratch/ui-refresh/polish-check.mjs"],cwd="/data",capture_output=True,text=True,timeout=120,env=dict(os.environ))
    fails=[l for l in r.stdout.splitlines() if l.startswith("FAIL")]
    print(("抓到" if (r.returncode or fails) else "没抓到"), name, [x[:60] for x in fails[:1]] or r.stderr[-200:])
  finally:
    p.write_text(s)
