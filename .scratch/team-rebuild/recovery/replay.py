#!/usr/bin/env python3
"""按顺序重放会话记录里保存下来的改文件命令（read_session_event 的结果文件）。

用法：replay.py FILE... [--force] [--ok-exit SEQ=CODE]
已重放的序号记在 ledger.tsv，重跑会跳过。遇到意外的非零退出就停。
"""
import json, os, re, subprocess, sys

ROOT = "/data"
LEDGER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ledger.tsv")


def load(path):
    t = open(path, encoding="utf-8").read()
    seq = int(re.search(r"^event_sequence: (\d+)", t, re.M).group(1))
    tool = re.search(r"^tool_name: (\S+)", t, re.M).group(1)
    i = t.index("\ninput:")
    inp, _ = json.JSONDecoder().raw_decode(t[i + len("\ninput:"):].lstrip())
    return seq, tool, inp


def ledger():
    out = {}
    if os.path.exists(LEDGER):
        for line in open(LEDGER, encoding="utf-8"):
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 3:
                out[int(parts[0])] = parts[2]
    return out


def resolve(p):
    return p if os.path.isabs(p) else os.path.join(ROOT, p)


def run_bash(inp):
    cwd = resolve(inp.get("workdir") or ROOT)
    r = subprocess.run(["bash", "-c", inp["command"]], cwd=cwd, capture_output=True, text=True, timeout=1800)
    return r.returncode, r.stdout, r.stderr


def run_edit(inp):
    path = resolve(inp["file_path"])
    s = open(path, encoding="utf-8").read()
    old, new = inp["old_string"], inp["new_string"]
    if old not in s:
        return 1, "", f"old_string not found in {path}"
    s = s.replace(old, new) if inp.get("replace_all") else s.replace(old, new, 1)
    open(path, "w", encoding="utf-8").write(s)
    return 0, f"edited {path}", ""


def find_block(lines, block, start):
    n = len(block)
    for norm in (lambda x: x, lambda x: x.rstrip(), lambda x: x.strip()):
        nb = [norm(b) for b in block]
        for i in range(start, len(lines) - n + 1):
            if [norm(l) for l in lines[i:i + n]] == nb:
                return i
    return -1


def run_patch(inp):
    rows = (inp.get("input") or inp.get("patch")).splitlines()
    i, log = 0, []
    while i < len(rows):
        row = rows[i]
        if row.startswith("*** Add File: "):
            path = resolve(row[14:].strip())
            body = []
            i += 1
            while i < len(rows) and not rows[i].startswith("*** "):
                body.append(rows[i][1:] if rows[i].startswith("+") else rows[i])
                i += 1
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, "w", encoding="utf-8").write("\n".join(body) + "\n")
            log.append(f"A {path}")
            continue
        if row.startswith("*** Delete File: "):
            path = resolve(row[17:].strip())
            os.remove(path)
            log.append(f"D {path}")
            i += 1
            continue
        if row.startswith("*** Update File: "):
            path = resolve(row[17:].strip())
            i += 1
            dest = None
            if i < len(rows) and rows[i].startswith("*** Move to: "):
                dest = resolve(rows[i][13:].strip())
                i += 1
            src = open(path, encoding="utf-8").read()
            trailing = src.endswith("\n")
            lines = src.split("\n")
            if trailing:
                lines = lines[:-1]
            cursor = 0
            while i < len(rows) and (not rows[i].startswith("*** ") or rows[i] == "*** End of File"):
                if rows[i] == "*** End of File":
                    i += 1
                    continue
                anchor = None
                if rows[i].startswith("@@"):
                    anchor = rows[i][2:].strip()
                    i += 1
                old, new = [], []
                while i < len(rows) and not rows[i].startswith("@@") and not rows[i].startswith("*** "):
                    r = rows[i]
                    tag, body = (r[:1], r[1:]) if r else (" ", "")
                    if tag == "-":
                        old.append(body)
                    elif tag == "+":
                        new.append(body)
                    else:
                        old.append(body)
                        new.append(body)
                    i += 1
                if anchor:
                    a = find_block(lines, [anchor], cursor)
                    if a >= 0:
                        cursor = a + 1 if old and old[0].strip() != anchor else a
                if not old:
                    lines[cursor:cursor] = new
                    cursor += len(new)
                    continue
                at = find_block(lines, old, cursor)
                if at < 0:
                    at = find_block(lines, old, 0)
                if at < 0:
                    return 1, "\n".join(log), f"hunk not found in {path}:\n" + "\n".join(old[:8])
                lines[at:at + len(old)] = new
                cursor = at + len(new)
            target = dest or path
            os.makedirs(os.path.dirname(target), exist_ok=True)
            open(target, "w", encoding="utf-8").write("\n".join(lines) + ("\n" if trailing else ""))
            if dest:
                os.remove(path)
            log.append(f"M {target}")
            continue
        i += 1
    return 0, "\n".join(log), ""


def main():
    args, force, ok_exit, files = sys.argv[1:], False, {}, []
    it = iter(args)
    for a in it:
        if a == "--force":
            force = True
        elif a == "--ok-exit":
            k, v = next(it).split("=")
            ok_exit[int(k)] = int(v)
        else:
            files.append(a)
    done = ledger()
    tail = lambda s, n: "\n".join(s.strip().splitlines()[-n:])
    for seq, tool, inp in sorted((load(f) for f in files), key=lambda e: e[0]):
        if seq in done and not force:
            print(f"skip {seq}")
            continue
        runner = {"bash": run_bash, "edit": run_edit, "apply_patch": run_patch}.get(tool)
        if not runner:
            sys.exit(f"unsupported tool {tool} at {seq}")
        code, out, err = runner(inp)
        print(f"== {seq} {tool} exit={code}")
        if out.strip():
            print(tail(out, 10))
        if err.strip():
            print("stderr:", tail(err, 6))
        if code != 0 and ok_exit.get(seq) != code:
            sys.exit(f"STOP at {seq}: exit {code}")
        with open(LEDGER, "a", encoding="utf-8") as f:
            f.write(f"{seq}\t{tool}\t{code}\n")


if __name__ == "__main__":
    main()
