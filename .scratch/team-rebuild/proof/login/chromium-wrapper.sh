#!/bin/bash
# 沙盒替身：模仿 Debian 的 /usr/bin/chromium。启动前 source /etc/chromium.d 下的每个文件，再带上 $CHROMIUM_FLAGS。
# 装到 /usr/local/sbin/chromium，座席的 PATH 里排在 /usr/local/bin 前面。
CHROMIUM_FLAGS=""
for f in /etc/chromium.d/*; do
  [ -f "$f" ] && . "$f"
done
# Debian 的 chromium 默认 profile 在 ~/.config/chromium，Chrome for Testing 不是，这里补上。
# --no-sandbox 等几个是沙盒里跑 Chrome for Testing 才要的，真客机里没有
exec /usr/local/bin/chromium --no-sandbox --disable-gpu --disable-background-networking --disable-sync --disable-component-update --user-data-dir="$HOME/.config/chromium" $CHROMIUM_FLAGS "$@"
