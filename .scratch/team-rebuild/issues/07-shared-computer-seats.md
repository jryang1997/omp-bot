# 07: 一台共享电脑，每个 bot 一个座席

**What to build:** 新的座席层替代每 bot 一台虚拟机。它沿用现在电脑后端的接口，电脑 id 指一个 bot 的座席。只有一台共享虚拟机，按 10 号票的默认规格创建，预先转发座席端口。座席层经管理通道运行客机座席脚本，为 bot 建 Linux 用户、屏幕和 spacesd。客机工具接受 `~` 路径，默认在 `~/work`，不再限制写入目录。新增装系统包的客机工具，每次都要用户批准。

**Blocked by:** 06

**Status:** done

- [x] 客机座席脚本能建用户、起屏幕和 spacesd、停座席，可重复执行
- [x] 座席层用替身虚拟机测通状态、创建、启动、停止，最后一个座席停掉后关虚拟机
- [x] 沙盒里用真实 Xvfb、spacesd 和座席脚本端到端跑通两个座席的截图、输入和命令，互不串
- [x] 虚拟机启动参数含默认规格和 17 个座席端口转发
- [x] `~` 路径解析到座席用户的主目录
- [x] 装系统包工具校验包名，overlay 里是 prompt，在全部放手档也会问
- [x] 上层租约、接管和现有电脑测试不改也通过

落地记录：

- 后端：`src/computer-backend.mjs` 把截图、输入、命令、传文件抽成导出的 `GuestDesk`，每 bot 电脑和座席共用。`create` 接 `machine`（cpus、memoryMb、diskGb、forwards），QEMU 参数改成导出的纯函数 `qemuArgs`，用户网络加座席端口转发，全部只绑宿主回环。覆盖层可按 `overlayCreateArgs` 指定大小，不小于底层镜像。`GuestDesk.run` 多一个 `env`。另外导出 `connectSpacesd`、`probeSpacesdHealth`、`redactSecrets`。
- 客机脚本：`guest/omp-seat`，root 运行，子命令 up、down、status、count、install-packages 都可重复执行。座席是 `team` 组里的 Linux 用户，主目录 0700，没有 sudo。屏幕只认自己的 X cookie，陈旧锁文件会清掉，有 xfwm4 就起。spacesd 用宿主给的令牌（经 `OMP_SEAT_TOKEN` 环境变量进来，主目录里 0400），令牌变了就重启。down 先 TERM 后 KILL。装包校验包名、加 flock，`apt-get install --no-install-recommends`。
- 座席层：`src/computer-seats.mjs` 的 `SeatBackend`，接口同 `ComputerBackend`，多一个 `installPackages`。共享虚拟机固定 id `shared`，16 个 bot 座席加登录座席 `login`（`omp-login`，第 17 个）。客机端口 3300–3316，屏幕 :20–:36，用户名 `omp-` 加电脑 id 的 sha256 前 12 位。座席按需建，令牌 48 位 hex 存 `<home>/computers/seats.json`（0600）。生命周期操作全局排队，停座席后 `omp-seat count` 为 0 才关虚拟机，数不清就不关。每次开机后比对客机脚本 sha256，不一致先落 `<home>/computers/guest-files/` 再经管理通道补装。状态多 `vm.state` 和 `seat.ready`。
- 规格（用户故事 36）：默认 4 vCPU、8 GiB、64 GiB 动态盘。vCPU 2–8 且不超过宿主核数减 2，内存 4–16 GiB。存 `<home>/computers/shared-machine.json`，下次开机生效。接口 `GET/PUT /api/computer/shared-machine`，越界 400。电脑面板多一行"共享电脑规格"。
- 功能层：默认后端换成 `createSharedComputer`。客机路径接受 `~` 和 `~/…`，shell 里写成 `"$HOME"/'…'`。去掉 /work、/tmp 写入限制，remove 拒删 `/`、`~`、`~/work`。默认 cwd `~/work`，附件放 `~/work/attachments`。新工具 `computer_install_packages`，在 `COMPUTER_PROMPT_TOOLS` 里，overlay 写 `prompt`，全部放手档也会问（omp 18.10.3 yolo 下工具没声明策略时用户级 prompt 生效，已读源码确认）。电脑面板文案改成座席。`electron-builder.yml` 打包 `guest/**/*`。
- 测试：新 `test/seats.mjs` 13 项（替身虚拟机：生命周期、排队、令牌、补装、座席上限、`~` 路径、装包校验、出错、规格和接口）。team.mjs 06 测试按 `COMPUTER_PROMPT_TOOLS` 区分 allow 和 prompt。14 个测试文件全过，smoke-gui 56/56，租约、接管和现有电脑测试没改。
- 证据：`proof/seats/seats-e2e.mjs` 沙盒里真实 Xvfb、spacesd 和座席脚本跑两个座席 9/9：截图各是各的、输入只进自己的屏幕、B 读不到 A 的主目录、令牌和屏幕、换令牌连不上、停一个不影响另一个、最后一个停掉关管理通道、再开文件还在。`proof/seats/shot-panel.mjs` 面板 7/7。
- 待实机：真实 QEMU 开共享虚拟机、端口转发、镜像里补装、Debian 客机装包、`smoke-computers.mjs`（已改成 `~/work` 和读不到别人主目录）。smoke 里靠桌面图标和 ctrl+alt+t 开终端的两步，座席只起 Xvfb 和 xfwm4，可能要在 omp-seat 里加起桌面和快捷键守护，实机跑时再定。
