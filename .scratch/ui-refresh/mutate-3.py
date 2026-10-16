import subprocess, pathlib, os
M=[("整行不可点","web/workbench-panels.js","      main.onclick = open;\n",""),
   ("多行不压成一行","web/workbench-panels.js",'.replace(/\\s+/g, " ").trim()',''),
   ("零数字照样显示","web/style.css",".wb-tab-count.is-zero { display: none; }",""),
   ("停止冒泡到行","web/workbench-panels.js",'tile.append(button("btn ghost danger wb-row-stop"','main.append(button("btn ghost danger wb-row-stop"')]
env=dict(os.environ)
for name,f,a,b in M:
  p=pathlib.Path(f); s=p.read_text(); assert a in s,name
  p.write_text(s.replace(a,b,1))
  try:
    r=subprocess.run(["node","omp-bot/.scratch/ui-refresh/tasks-check.mjs"],cwd="/data",capture_output=True,text=True,timeout=120,env=env)
    fails=[l for l in r.stdout.splitlines() if l.startswith("FAIL")]
    print(("抓到" if r.returncode else "没抓到"), name, fails[:1] or r.stderr[-200:])
  finally:
    p.write_text(s)
