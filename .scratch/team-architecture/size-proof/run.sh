#!/usr/bin/env bash
# run.sh：依次测 1、3、5 个座席。以有免密 sudo 的普通用户运行，结果写到 result.jsonl。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
URL="${URL:-https://github.com/jryang1997/omp-bot}"
out="$HERE/result.jsonl"; : > "$out"
sudo groupadd -f team
# 沙盒的 /dev/shm 只有 64M，多个 Chromium 会崩。真实客机的 /dev/shm 是内存的一半。
[ "$(df --output=size -m /dev/shm | tail -1)" -ge 1024 ] || sudo mount -o remount,size=2G /dev/shm
log() { echo "$1" | tee -a "$out"; }
base_used() { free -m | awk '/^Mem:/{print $3}'; }
for n in 1 3 5; do
  users=(); seats=()
  for i in $(seq 1 "$n"); do users+=("bot-$i"); seats+=("bot-$i:$((3320 + i))"); done
  before=$(base_used)
  for i in $(seq 1 "$n"); do sudo bash seat.sh start "bot-$i" "$((20 + i))" "$((3320 + i))" "$URL"; done
  sleep 30
  after=$(base_used)
  log "{\"n\":$n,\"phase\":\"settled\",\"freeUsedDeltaMiB\":$((after - before)),\"pss\":$(sudo python3 sample.py pss 0 "${users[@]}")}"
  log "{\"n\":$n,\"phase\":\"idle-cpu\",\"cpuPctOfOneVcpu\":$(sudo python3 sample.py cpu 30 "${users[@]}")}"
  SDK_DIR=/data/omp-bot SEATS="$(IFS=,; echo "${seats[*]}")" SECONDS_=40 INTERVAL=3000 node drive.mjs > drive.out & d=$!
  sleep 5
  cpu=$(sudo python3 sample.py cpu 30 "${users[@]}")
  wait $d
  log "{\"n\":$n,\"phase\":\"active-cpu\",\"cpuPctOfOneVcpu\":$cpu,\"drive\":$(cat drive.out)}"
  log "{\"n\":$n,\"phase\":\"after-active\",\"pss\":$(sudo python3 sample.py pss 0 "${users[@]}")}"
  if [ "$n" = 5 ]; then
    for u in "${users[@]}"; do sudo bash seat.sh stop-browser "$u"; done
    sleep 5
    log "{\"n\":$n,\"phase\":\"browsers-closed\",\"pss\":$(sudo python3 sample.py pss 0 "${users[@]}"),\"cpuPctOfOneVcpu\":$(sudo python3 sample.py cpu 20 "${users[@]}")}"
  fi
  for u in "${users[@]}"; do sudo bash seat.sh stop "$u"; done
  sleep 3
done
for i in 1 2 3 4 5; do log "{\"profileDisk\":\"bot-$i\",\"du\":\"$(sudo du -sh /home/bot-$i/.config/chromium | cut -f1)\"}"; done
