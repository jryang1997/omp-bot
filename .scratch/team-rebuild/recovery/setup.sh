#!/bin/sh
# 沙盒重置后先跑这个：装提交即推送钩子。GitHub 登录要用户重新授权。
set -e
cd "$(git rev-parse --show-toplevel)"
install -m 0755 .scratch/team-rebuild/recovery/post-commit .git/hooks/post-commit
gh auth status >/dev/null 2>&1 && gh auth setup-git || echo "gh 未登录：需要用户做设备码授权" >&2
