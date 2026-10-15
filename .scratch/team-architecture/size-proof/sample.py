#!/usr/bin/env python3
# sample.py pss|cpu <seconds> <user>...  以 root 运行。按用户汇总 PSS，或在窗口内汇总 CPU 时间。
import os, sys, pwd, time, json
mode, secs, users = sys.argv[1], float(sys.argv[2]), sys.argv[3:]
uids = {pwd.getpwnam(u).pw_uid: u for u in users}
HZ = os.sysconf('SC_CLK_TCK')
def kind(comm):
    return 'xvfb' if comm.startswith('Xvfb') else 'spacesd' if 'spacesd' in comm else 'browser' if comm.startswith(('chrome', 'chrome_crashpad')) else 'other'
def procs():
    for pid in os.listdir('/proc'):
        if not pid.isdigit(): continue
        try:
            st = os.stat(f'/proc/{pid}')
            if st.st_uid not in uids: continue
            comm = open(f'/proc/{pid}/comm').read().strip()
            yield pid, uids[st.st_uid], kind(comm)
        except OSError: pass
def pss():
    out = {u: {'xvfb': 0, 'spacesd': 0, 'browser': 0, 'other': 0} for u in users}
    for pid, u, k in procs():
        try:
            for line in open(f'/proc/{pid}/smaps_rollup'):
                if line.startswith('Pss:'): out[u][k] += int(line.split()[1]); break
        except OSError: pass
    return {u: {k: round(v / 1024, 1) for k, v in d.items()} | {'total': round(sum(d.values()) / 1024, 1)} for u, d in out.items()}
def ticks():
    t = {}
    for pid, u, k in procs():
        try:
            f = open(f'/proc/{pid}/stat').read().rsplit(')', 1)[1].split()
            t[pid] = (u, int(f[11]) + int(f[12]))
        except OSError: pass
    return t
if mode == 'pss':
    print(json.dumps(pss()))
else:
    a = ticks(); t0 = time.time(); time.sleep(secs); b = ticks(); dt = time.time() - t0
    per = {u: 0 for u in users}
    for pid, (u, v) in b.items(): per[u] += v - a.get(pid, (u, 0))[1]
    # 单位：占一个 vCPU 的百分比
    print(json.dumps({u: round(100 * v / HZ / dt, 1) for u, v in per.items()}))
