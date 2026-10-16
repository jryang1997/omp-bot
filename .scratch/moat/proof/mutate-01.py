# 01 变异测试：逐个拆掉一条保护，test/delegation.mjs 必须变红；跑完恢复原文件。
# 用法：python3 .scratch/moat/proof/mutate-01.py
import subprocess, pathlib
SRC = pathlib.Path("src/orchestrator.mjs")
orig = SRC.read_text()
M = [
  ("目标忙不再算等待", 'new Set(["target_busy", "bot_paused"])', 'new Set(["bot_paused"])'),
  ("去掉重复交付防护", 'if (!rec || rec.state !== "returned" || rec.delivery !== "pending") return { outcome: "noop" };', 'if (!rec || rec.state !== "returned" || rec.delivery === "dropped") return { outcome: "noop" };'),
  ("交回前不查可见性", 'if ((from.workspace ?? "") !== (target.workspace ?? "")) {\n        return', 'if (false) {\n        return'),
  ("开跑前不重查准入", '      this._assertDelegationAllowed(from, target, parentRun);\n    } catch (e) {\n      this._returnNotStarted', '      void 0;\n    } catch (e) {\n      this._returnNotStarted'),
  ("重启不对账派活", '    this._recoverDelegations();\n  }', '  }'),
  ("父回合取消不撤排队", '      this._dropQueuedDelegations(runId);', '      void 0;'),
  ("排队的不许挂已结束父 Run", '{ allowFinishedParent: true }', '{ allowFinishedParent: false }'),
  ("关停级联当成用户取消", 'return /(^|:)shutdown$/.test(String(run?.error ?? ""));', 'return run?.error === "shutdown";'),
  ("父 bot 忙就丢交付", 'if (DELEGATION_WAIT_CODES.has(e?.code) || e?.code === "concurrency_limit") return { outcome: "busy" };', ''),
  ("落定不触发交回", '    this._onRunSettled(next);\n    return next;', '    return next;'),
]
out = []
try:
  for name, a, b in M:
    assert orig.count(a) == 1, f"变异点不唯一或找不到：{name}"
    SRC.write_text(orig.replace(a, b))
    r = subprocess.run(["node", "test/delegation.mjs"], capture_output=True, text=True, timeout=120)
    last = [l for l in r.stdout.splitlines() if l.strip()][-1]
    fails = [l[6:] for l in r.stdout.splitlines() if l.startswith("FAIL")]
    verdict = "抓到" if r.returncode != 0 else "没抓到"
    out.append(f"- {name}：{verdict}（{last}）" + (f" 首个变红：{fails[0]}" if fails else ""))
    print(out[-1], flush=True)
finally:
  SRC.write_text(orig)
pathlib.Path(".scratch/moat/proof/mutate-01.txt").write_text("\n".join(out) + "\n")
