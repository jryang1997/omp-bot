# 04 本机 omp 怎么碰到客机里的文件

Type: research
Label: wayfinder:research
Status: resolved
Blocked by:

## Question

bot 用 omp 原生的读、写、编辑、搜索工具改了文件，再到客机里运行。两边怎么保证是同一份文件。

## Why it matters

D3 之后 bot 同时有本机工具和客机工具。共享文件如果只在客机 `/workspace`，omp 的编辑和搜索就用不上，只能靠 computer_files 来回搬，1+1 还是小于 2。让 bot 在客机里再装一个 pi 来改文件也行，但那是套娃，模型费用和上下文都要付两份。

## What to check

- Windows 宿主上的 QEMU 是否支持 virtfs/9p。我目前的判断是不支持，需要核实。
- 候选通道。客机开 SMB 或 SFTP 由宿主挂载；宿主共享文件夹由客机用 cifs 挂载，要确认非管理员能否做到；继续用 computer_files 同步。
- 选定后共享文件只能有一个权威位置。宿主 `team/workspace` 和客机 `/workspace` 不能各存一份。
- bot 的私有目录要不要也两边可见。

## Done when

选定通道，实测宿主写客机读、客机写宿主读、两边并发写、中文路径。

## Answer

宿主目录做唯一权威，omp-bot 在宿主侧内置一个用户态 SFTP 服务，客机用 sshfs 挂载。omp 原生的读写编辑工具直接改 NTFS 上的文件，客机里同一路径马上能看到。

### 排除的通道

- virtfs/9p 不行。QEMU 的构建脚本写明 virtio-9p 只支持 Linux、macOS、FreeBSD 宿主（`qemu/qemu` 的 `meson.build`）。virtiofsd 也只跑在 Linux 上。
- 客机开 Samba、宿主映射网络盘不合适。Windows 自己占着 445 端口，SMB 客户端改用别的端口需要 Windows 11 24H2，而且微软文档要求在管理员 PowerShell 里映射。管理员会话里映射的盘，普通会话里的 omp 看不到。
- 宿主共享文件夹给客机用 cifs 挂载不合适。在 Windows 上建共享要管理员权限。
- 两边各一份再同步不合适。会有冲突，用户也说不清哪份是真的。
- rclone serve sftp 不合适。沙盒实测它的 VFS 目录缓存默认 5 分钟，宿主新建的文件客机迟迟看不到，追加写也不正常。它是给云存储设计的。

### 实测

沙盒替身见 `files-proof/`，可以重跑。宿主侧用 OpenSSH 的 sftp-server 直接读写磁盘，代替将来的 Node 服务；客机侧用 root 跑 sshfs，参数 `gid=team,umask=0007,cache=no`，属性和目录缓存全部关掉。结果见 `proof.json`。

- 宿主写、客机读，18 ms 内可见。宿主像编辑器那样先写临时文件再改名，客机读到完整的新内容。
- 客机写、宿主读，15 ms 内可见。中文文件名正常。
- 另一个 bot 能追加 bot-a 建的文件。两个 bot 同时往同一个文件各追加 200 行，400 行一行不丢。
- 宿主和客机同时各建 200 个文件，两边都看到 400 个。
- 在挂载里 `chmod +x` 后能直接运行脚本。
- 小文件慢。客机在挂载里写再读 500 个 1 KiB 文件用 6.6 秒，客机本地盘 0.4 秒，慢 16 倍。走 QEMU 的 user 网络还会更慢。

### 落地要点

- omp-bot 用 Node 的 `ssh2` 包（MIT，纯 JS）在 `127.0.0.1` 起 SFTP 服务，只认一把密钥。客机通过 QEMU user 网络的 `10.0.2.2` 连回宿主回环地址，不经过防火墙，也不需要管理员。
- 私钥只放在客机 root 可读的位置，由 root 挂载。bot 用户只看到挂载结果。
- 挂载 `team/workspace` 到客机 `/workspace`，归 team 组。是否再按 bot 挂它自己的 `team/bots/<名>` 留给 09 号票，挂的话用 `uid=bot-<id>,umask=0077`。
- 挂载源必须是共享目录本身。沙盒里把 `/` 挂进来时，服务端列目录会 stat 到挂载点自己，直接死锁。
- 依赖目录和构建产物放客机本地盘，例如 `node_modules`、虚拟环境、编译缓存。共识层 AGENTS.md 里写明这条，否则 bot 在挂载里 `npm install` 会非常慢。

### 只能在 Windows 上验的

- NTFS 没有可执行位。Node 服务要么对普通文件统一报 0755，要么把 chmod 记在旁路文件里。
- 大小写不敏感、`CON`、`AUX` 这类保留名、260 字符路径上限、符号链接。
- 宿主侧有程序开着文件时，客机写入和改名会不会被 Windows 锁住。Node 默认带共享读写删除标志打开，预计没问题。
- 走 QEMU user 网络时的真实吞吐。

## Comments