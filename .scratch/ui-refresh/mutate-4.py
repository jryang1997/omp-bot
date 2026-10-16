import subprocess, pathlib, os
M=[("更多设置放回顶部","web/app.js","body.replaceChildren(...[tabBar, content, sub ? more?.node : null]","body.replaceChildren(...[tabBar, more?.node, content]"),
   ("长说明放回来","web/workbench-computer.js",'"接管后由你来操作，助手暂停。"','"接管后助手的自动输入立即失效，你的鼠标和键盘直接操作这台电脑。每次接管或归还会更换控制代号。"'),
   ("Bot 词回来","web/workbench-computer.js",'agent: "助手在用"','agent: "Bot 自动控制"'),
   ("子页不带更多设置","web/app.js","sub ? more?.node : null","null")]
for name,f,a,b in M:
  p=pathlib.Path(f); s=p.read_text(); assert a in s,name
  p.write_text(s.replace(a,b,1))
  try:
    r=subprocess.run(["node","omp-bot/.scratch/ui-refresh/settings-check.mjs"],cwd="/data",capture_output=True,text=True,timeout=120,env=dict(os.environ))
    fails=[l for l in r.stdout.splitlines() if l.startswith("FAIL")]
    print(("抓到" if r.returncode else "没抓到"), name, fails[:1] or r.stderr[-200:])
  finally:
    p.write_text(s)
