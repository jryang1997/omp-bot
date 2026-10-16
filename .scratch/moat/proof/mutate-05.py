# 05 变异测试：逐个拆掉秘密不进模型的一环，相关测试必须变红；跑完恢复原文件。
# 用法：python3 .scratch/moat/proof/mutate-05.py
import subprocess, pathlib
M = [
  ("overlay 不打开 secrets", "src/persona.mjs", '    "secrets:",\n    "  enabled: true",\n', "", ["test/team.mjs"]),
  ("老团队不补 secrets.yml 的忽略行", "src/team.mjs", '"bots/*/.omp/mcp.json", "bots/*/.omp/secrets.yml"];', '"bots/*/.omp/mcp.json"];', ["test/team.mjs"]),
  ("老团队不补会话目录的忽略行", "src/team.mjs", 'const MUST_IGNORE = ["bots/*/sessions/", ', 'const MUST_IGNORE = [', ["test/team.mjs"]),
  ("新团队模板漏掉 secrets.yml", "src/team.mjs", '  "bots/*/.omp/secrets.yml",\n  "",\n].join', '  "",\n].join', ["test/team.mjs"]),
  ("补过忽略行不提交", "src/team.mjs", '    else if (ignoreFixed) this.commit("补上 .gitignore：带密钥的文件不进版本历史");\n', "", ["test/team.mjs"]),
  ("座席 env 混进宿主环境", "src/computer-seats.mjs", "const env = { OMP_SEAT_TOKEN: seat.token };", "const env = { ...process.env, OMP_SEAT_TOKEN: seat.token };", ["test/seats.mjs"]),
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
pathlib.Path(".scratch/moat/proof/mutate-05.txt").write_text("\n".join(out) + "\n")
