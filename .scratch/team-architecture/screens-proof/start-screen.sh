#!/usr/bin/env bash
# start-screen.sh <user> <display-num> <cdp-port>
# 以 root 运行。为一个 bot 起一块独立屏幕，只接受它自己的 X cookie，再在上面开它自己的浏览器 profile。
set -euo pipefail
user="$1"; num="$2"; port="$3"
CHROME="${CHROME:-/vercel/sandbox/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome}"
sudo -n -u "$user" -H bash -s "$num" "$port" "$user" "$CHROME" <<'INNER'
set -euo pipefail
num="$1"; port="$2"; user="$3"; chrome="$4"
umask 077
rm -f "$HOME/.Xauthority"; touch "$HOME/.Xauthority"
xauth -f "$HOME/.Xauthority" add ":$num" . "$(mcookie)"
nohup Xvfb ":$num" -screen 0 1280x800x24 -dpi 96 -nolisten tcp -auth "$HOME/.Xauthority" -noreset >"$HOME/xvfb.log" 2>&1 &
for i in $(seq 50); do [ -S "/tmp/.X11-unix/X$num" ] && break; sleep 0.1; done
DISPLAY=":$num" XAUTHORITY="$HOME/.Xauthority" nohup "$chrome" --no-sandbox --disable-gpu \
  --user-data-dir="$HOME/.config/bot-browser" --no-first-run --no-default-browser-check \
  --remote-debugging-port="$port" --window-position=0,0 --window-size=1280,800 \
  --app="file:///workspace/page.html#$user" >"$HOME/browser.log" 2>&1 &
INNER
