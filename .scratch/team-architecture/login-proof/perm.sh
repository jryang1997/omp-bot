#!/usr/bin/env bash
# 以 root 运行。共享登录库归 team 组只读，bot 用户能同步，组外用户读不到。
set -euo pipefail
SYNC="$(cd "$(dirname "$0")/../../../guest" && pwd)/omp-login-sync"
install -m 0755 "$SYNC" /usr/local/bin/omp-login-sync
groupadd -f team
id bot-a >/dev/null 2>&1 || useradd -m -s /bin/bash -G team bot-a
id outsider >/dev/null 2>&1 || useradd -m -s /bin/bash outsider
chmod 0700 /home/bot-a /home/outsider
rm -rf /var/lib/omp-login
omp-login-sync publish --from /tmp/login-proof/login --store /var/lib/omp-login --group team
stat -c '%A %U:%G %n' /var/lib/omp-login /var/lib/omp-login/Cookies.db /var/lib/omp-login/version
echo "bot-a: $(sudo -u bot-a omp-login-sync sync --profile /home/bot-a/.config/chromium)"
stat -c '%A %U:%G %n' /home/bot-a/.config/chromium/Default/Cookies
echo "outsider: $(sudo -u outsider omp-login-sync sync --profile /home/outsider/.config/chromium 2>&1 | tail -1)"
