#!/usr/bin/env bash
# 04 号票沙盒替身。宿主侧（普通用户）跑一个直接映射文件系统的 SFTP 服务，客机侧（root）用 sshfs 挂到挂载点。
# 这里用 OpenSSH 的 sftp-server 加 socat 代替将来 omp-bot 内置的 Node SFTP 服务，两者都直接读写磁盘、不做缓存。
# 挂载源必须是宿主目录本身，不能是 /，否则 sftp-server 列目录时会 stat 到挂载点自己而死锁。
# 用法：./setup.sh <宿主目录> <挂载点>
set -euo pipefail
HOST_DIR="$1"; MNT="$2"; PORT="${PORT:-2023}"; LOG="${LOG:-/data/files-proof.log}"
mkdir -p "$HOST_DIR"
pkill -x socat || true; sleep 0.5
nohup socat "TCP-LISTEN:$PORT,bind=127.0.0.1,reuseaddr,fork" "EXEC:/usr/libexec/openssh/sftp-server -d $HOST_DIR" >"$LOG" 2>&1 &
sleep 1
sudo -n mkdir -p "$MNT"
sudo -n umount -l "$MNT" 2>/dev/null || true
# 关掉 sshfs 的属性、目录和内容缓存，宿主改完客机马上能看到。gid=team、umask=0007 让 team 组可读写。
sudo -n sshfs "127.0.0.1:$HOST_DIR" "$MNT" -o directport="$PORT" \
  -o allow_other,uid=0,gid="$(getent group team | cut -d: -f3)",umask=0007 \
  -o cache=no,attr_timeout=0,entry_timeout=0,negative_timeout=0
mount | grep "$MNT"
