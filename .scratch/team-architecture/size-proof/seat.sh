#!/usr/bin/env bash
# seat.sh start <user> <display-num> <spacesd-port> <url> | seat.sh stop-browser <user> | seat.sh stop <user>
# 以 root 运行。按 D8 起一个座席：bot 用户自己的 Xvfb、cua-spacesd 和浏览器。浏览器按 D17 不开调试端口。
set -euo pipefail
cmd="$1"; user="$2"
CHROME="${CHROME:-/vercel/sandbox/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome}"
case "$cmd" in
start)
  num="$3"; port="$4"; url="$5"
  id "$user" >/dev/null 2>&1 || { useradd -m -s /bin/bash -G team "$user"; chmod 0700 "/home/$user"; }
  sudo -n -u "$user" -H bash -s "$num" "$port" "$url" "$CHROME" <<'INNER'
set -euo pipefail
num="$1"; port="$2"; url="$3"; chrome="$4"
umask 077
rm -f "$HOME/.Xauthority"; touch "$HOME/.Xauthority"
xauth -f "$HOME/.Xauthority" add ":$num" . "$(mcookie)"
nohup Xvfb ":$num" -screen 0 1280x800x24 -dpi 96 -nolisten tcp -auth "$HOME/.Xauthority" -noreset >"$HOME/xvfb.log" 2>&1 &
for i in $(seq 50); do [ -S "/tmp/.X11-unix/X$num" ] && break; sleep 0.1; done
mkdir -p "$HOME/.spacesd"
[ -s "$HOME/.spacesd/token" ] || head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$HOME/.spacesd/token"
DISPLAY=":$num" XAUTHORITY="$HOME/.Xauthority" nohup cua-spacesd serve --listen "127.0.0.1:$port" \
  --token-file "$HOME/.spacesd/token" --data-dir "$HOME/.spacesd/data" --no-mcp --quic-port 0 >"$HOME/spacesd.log" 2>&1 &
DISPLAY=":$num" XAUTHORITY="$HOME/.Xauthority" nohup "$chrome" --no-sandbox --disable-gpu --password-store=basic \
  --user-data-dir="$HOME/.config/chromium" --no-first-run --no-default-browser-check \
  --window-position=0,0 --window-size=1280,800 "$url" >"$HOME/browser.log" 2>&1 &
INNER
  ;;
stop-browser) pkill -u "$user" -f chrome-linux64 || true ;;
stop) pkill -u "$user" || true ;;
esac
