#!/usr/bin/env bash
# 以 root 运行。模拟共享客机的用户模型：每 bot 一个 Linux 用户，home 0700，/workspace 归 team 组。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
groupadd -f team
for b in bot-a bot-b; do
  id "$b" >/dev/null 2>&1 || useradd -m -s /bin/bash -G team "$b"
  chmod 0700 "/home/$b"
done
install -d -m 2770 -g team /workspace
setfacl -d -m g:team:rwX /workspace
install -m 0644 "$HERE/page.html" /workspace/page.html
