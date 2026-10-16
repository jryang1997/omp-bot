# 08: 共享工作区和私有文件挂进客机

**What to build:** omp-bot 内置 SFTP 服务，导出 `team/workspace` 和每个 bot 的 `bots/<id>/work`。座席就绪时客机用 sshfs 把前者挂到 `/workspace`，后者以 bot 用户身份挂到 `~/work`。

**Blocked by:** 01, 07

**Status:** done

- [x] SFTP 服务只监听本机回环，只认 omp-bot 生成的密钥，按用户名分根
- [x] 越出根的路径和符号链接被拒绝
- [x] 沙盒里用真实 sshfs 测双向即时可见、改名落盘、并发追加不丢
- [x] 座席脚本挂载 `/workspace` 归 team 组，`~/work` 只有该 bot 能读写
- [x] 服务随 omp-bot 启停，端口和密钥经座席层传进客机

落地记录：

- 服务：`src/file-share.mjs` 的 `FileShare`，基于 `ssh2` 1.17.0（精确版本）。只听 127.0.0.1，优先复用上次的端口（`<home>/computers/file-share/port.json`），客机里 sshfs 的 reconnect 才接得上。主机钥匙和客户端钥匙都在 `<home>/computers/file-share/`，0600。用户名 `workspace` 对应 `team/workspace`，bot id 对应 `team/bots/<id>/work`，已删除的 bot 登不进来。路径有 `..` 就拒，跟随符号链接后必须还在根里，悬空链接不许 O_CREAT，只许建根内的相对链接，改名直接覆盖（编辑器保存要用）。请求按收到的顺序处理，跟 OpenSSH sftp-server 一样。
- 偏离规格：规格写"只认一把由 omp-bot 生成的密钥"，做成 workspace 一把、每个 bot 各一把。同一把钥匙的话，一个座席能用别的 bot 的用户名登进它的 `~/work`，"只有该 bot 能读写"就不成立。
- 客机脚本：`guest/omp-seat up` 读 `OMP_SHARE_*` 环境变量（没有就不挂，行为同 07）。root 把 `/workspace` 挂到 `/srv/omp-share/workspace`（`/srv/omp-share` 是 0750 root:team），`/workspace` 是指向它的链接；挂载不加 default_permissions，组内都能写、能 `chmod +x`，组外用户在上一级就被挡住。座席用户自己挂 `~/work`，不开 allow_other，别的用户和 root 都进不去。挂载关掉缓存（cache=no，三个 timeout 都是 0），StrictHostKeyChecking=yes 加 HostKeyAlias，端口变了不用改 known_hosts。地址、端口、钥匙、主机公钥任何一个变了，或者挂载死了，就重挂。down 先卸 `~/work` 再停进程。status 多 `workspace=`、`work=`，`stat` 用 `timeout -k 1 3`，服务停着也不卡。客机没有 sshfs 就先 apt 装上。`/workspace` 里的文件都显示成 root 所有，git 会拒绝，所以系统级放行 `safe.directory`（Debian 12 的 git 2.39 不认前缀写法）。
- 座席层：`SeatBackend` 接可选的 `share`，`SeatShare` 包 `FileShare`。座席起来时把主机公钥、端口和两把钥匙（base64）放进管理通道的 env，不进命令行和 seats.json，报错时脱敏。登录座席不挂。共享电脑开着时服务自动起来，后端关闭时服务跟着关。`vm.shareHost` 能换掉默认的 10.0.2.2。功能层 `Computers.ensureBackend` 用 `seatShareRoots` 解析根，电脑 id 反查 bot id。
- 模板：`team/AGENTS.md` 模板写明依赖和构建产物放客机本地盘。只影响新建的 team 目录，已有的 AGENTS.md 不动。
- 测试：新 `test/file-share.mjs` 11 项（监听地址、钥匙、分根、`..`、外链、改名覆盖、并发追加、请求顺序、坏钥匙重生、OpenSSH sftp 批处理）；`test/seats.mjs` 加 3 项到 16 项。改坏根内检查、去掉 O_APPEND、请求并发处理、去掉脱敏、去掉关通道，对应测试都会失败。15 个测试文件全过，smoke-gui 56/56。
- 沙盒端到端：`.scratch/team-rebuild/proof/files/`，真实 sshfs 两座席 10/10，07 的 seats-e2e 用改过的脚本重跑 9/9。途中修掉的四个问题记在那里的 README。
- 待实机：真实 QEMU 里经 10.0.2.2 连回宿主、Windows 宿主上的 SFTP 服务（路径分隔符、权限位、符号链接）、Debian 镜像里补装 sshfs、`smoke:computers`。
