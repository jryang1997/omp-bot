#!/bin/bash
# 跑全部 test/*.mjs，输出每个文件的最后一行
cd /data/omp-bot
export PATH=/data/omp-probe/node_modules/.bin:$PATH
for f in unit workbench-runs attachment-drafts shutdown ledger runs features http-boundaries mobile computers rpc-client channels team seats; do
  out=$(node test/$f.mjs 2>&1); code=$?
  echo "$f exit=$code $(echo "$out" | grep -v Warning | grep -v trace-warnings | tail -1)"
  [ $code -ne 0 ] && echo "$out" | grep -E "FAIL|Error" | head -10
done
exit 0
