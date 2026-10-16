# 08 共享工作区和私有文件的证据

- `files-e2e.mjs`：沙盒端到端。真实 sshfs 3.7.3、`guest/omp-seat` 和 `src/file-share.mjs`，共享虚拟机换成沙盒本身（同 07 的 `seats-e2e.mjs`，管理通道端口 3398）。客机连回宿主的地址从 10.0.2.2 换成 127.0.0.1，SFTP 服务以沙盒普通用户运行，跟宿主上的 omp-bot 一样。结果在 `files-e2e.json`（10/10）。
  - 两个座席起来后 `/workspace`（root 挂载）和各自的 `~/work`（座席用户自己挂载）都挂上，服务只听 127.0.0.1
  - 双向即时可见：宿主写完客机马上读到，客机写完宿主马上读到，改写变长、删除、建目录都一样
  - 改名落盘：编辑器式的临时文件改名覆盖、宿主改名、目录改名
  - 并发追加：两个座席和宿主各追加 200 行，600 行不重不丢（04 的旧证据是 400/400）
  - 越出根被拒：宿主建的绝对和相对外链读不到，客机建不了外链，根内的相对链接照常
  - 钥匙：A 的钥匙登不进 B 和 workspace，陌生钥匙登不进，钥匙文件 0400
  - `~/work` 别的座席和客机 root 都读不到；`/workspace` 组内能写、`chmod +x` 能跑、`git` 能用，组外用户进不去
  - 服务停着时 `omp-seat status` 不卡（43ms），重启后用回同一个端口，客机 sshfs 自己接上，再开座席不重挂
  - 停座席先卸 `~/work`，另一个座席不受影响，最后一个停掉关共享电脑
- 07 的 `seats-e2e.mjs` 用改过的 `omp-seat` 重跑一遍，9/9（不给 `OMP_SHARE_*` 就不挂，行为同 07）。

前置：07 的前置，加上 `sudo dnf install -y fuse-sshfs`，`sudo chmod 0666 /dev/fuse`（沙盒里 /dev/fuse 是 0600，座席用户的 sshfs 挂不上；Debian 客机里本来就是 0666）。

途中发现并修掉的：
- sshfs 建文件时紧跟着 OPEN 发 LSTAT。服务并发处理的话 LSTAT 先跑完，看不到刚建的文件，写入报 No such file。改成按收到的顺序一个一个处理，跟 OpenSSH 的 sftp-server 一样。
- ssh2 生成的 ed25519 钥匙大约千分之二是坏的，OpenSSH 也读不了。生成后自己解析一遍，坏了重来，读到坏的钥匙文件也重生。
- 客户端发 EOF 后服务不关通道，OpenSSH 的 `sftp -b` 一直等。
- 挂载断了以后 `stat` 收不到 TERM，`timeout 3` 杀不掉，改成 `timeout -k 1 3`。

没覆盖的：真实 QEMU 用户网络里经 10.0.2.2 连回宿主、Windows 宿主上的 SFTP 服务、Debian 客机镜像里自动补装 sshfs。这些要在有 KVM 或 WHPX 的机器上跑 `npm run smoke:computers`。
