# 第 5 步变异检查：每次改坏一处，chat-check 必须报错。用法：cd /data && python3 omp-bot/.scratch/ui-refresh/mutate-5.py
import subprocess, pathlib, os
os.chdir("/data/omp-bot")
M=[("新消息不加进场","web/app.js",'if (index >= freshFrom) node.classList.add("is-new");',''),
   ("全部消息都加进场","web/app.js",'if (index >= freshFrom) node.classList.add("is-new");','node.classList.add("is-new");'),
   ("日期回到原始格式","web/app.js","const day = fmtDay(date);","const day = date.toLocaleDateString();"),
   ("打开会话不清记数","web/app.js",'if (kind === "bot") chatSeen.delete(keyOf(target));',''),
   ("权限标签不带档位","web/app.js","dataset.level = permissionOf(item)","dataset.lvl = permissionOf(item)")]
for name,f,a,b in M:
  p=pathlib.Path(f); s=p.read_text(); assert a in s,name
  p.write_text(s.replace(a,b,1))
  try:
    r=subprocess.run(["node","omp-bot/.scratch/ui-refresh/chat-check.mjs"],cwd="/data",capture_output=True,text=True,timeout=120,env=dict(os.environ))
    fails=[l for l in r.stdout.splitlines() if l.startswith("FAIL")]
    print(("抓到" if (r.returncode or fails) else "没抓到"), name, fails[:1] or r.stderr[-200:])
  finally:
    p.write_text(s)
