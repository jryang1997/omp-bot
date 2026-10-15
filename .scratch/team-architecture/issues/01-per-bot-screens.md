# 01 共享电脑里每个 bot 的屏幕

Type: research
Label: wayfinder:research
Status: resolved
Blocked by:

## Question

一台 QEMU 客机里，能否给每个 bot 一块独立屏幕，截图和输入只落在那块屏上，多个 bot 同时操作互不干扰。

## Why it matters

这是 D2 的核心。Grok Bot 每个 bot 一块屏，所以能并行。做不到的话只能排队共用一块屏。

## What to check

- Cua computer-server 能否按 `DISPLAY` 起多个实例，每 bot 一个 Xvfb 或 Xvnc 加一个端口。`src/computer-backend.mjs` 的连接能否按 bot 选实例。
- 截图、点击、剪贴板粘贴（`clipboard-proof.json` 用的那条路径）是否都跟随 `DISPLAY`。
- 人工接管看的是哪块屏。现在接管和归还按整台电脑互斥，要改成按屏互斥。
- 做不到时的退路是一块屏加输入排队。记下体验代价。

## Done when

两个 bot 在同一台客机的两块屏上同时点击和输入，截图不串屏。有可重跑的证明脚本和 proof.json。

## Answer

能做到。推荐形态是每个 bot 一个 Linux 用户，配一块自己的 Xvfb 屏，再跑一个属于它的官方 `cua-spacesd` 实例。

### 依据

- 官方 Cua Linux 镜像本身就是 Ubuntu 24.04 加 XFCE，跑在 Xvfb `:1` 上，镜像里已经带了 xvfb、xdotool、xclip、imagemagick、xauth 和 chromium（`trycua/cua` 的 `libs/images/linux/Dockerfile`）。不用往客机里加新软件。
- `cua-spacesd` 的显示和端口都能参数化。启动脚本读 `CUA_DISPLAY`，命令行有 `--listen`、`--port`、`--token-file`、`--data-dir`、`--quic-port`。
- spacesd 的截图接口虽然有 `display` 参数，但那是同一个 X 服务器里的显示器，共用一个指针和键盘焦点，不能拿来并行。要并行就得是独立的 X 服务器。

### 实测

沙盒是 Amazon Linux 2023，没有 KVM，所以用它代替客机，工具与 Cua 镜像相同。证据在 `screens-proof/`，可以重跑。

- `proof.mjs` 用 xdotool 和 xclip 让两个 bot 同时在 `:11`、`:12` 上各操作 15 轮，每轮点击、粘贴中文和 emoji、打字、回车。两边都按顺序收到自己的 15 行，没有一个字符串到对方屏上。见 `proof.json` 和 `screens-side-by-side.png`。
- `sdk-proof.mjs` 给每块屏起一个 `cua-spacesd 0.5.3`，用项目现有的 `@trycua/cua 0.4.1` 和 `src/computer-backend.mjs` 里同样的调用（`runtime.spacesd(url, token)`、`click`、`setClipboard` 加 Ctrl+V、`screenshot`）并发操作各 10 轮。全部按顺序到达，截图各是 1280×800，拿 bot-a 的令牌连 bot-b 的实例被拒绝。见 `sdk-proof.json`。
- 越界尝试都被挡住。拿自己的 X cookie 连别人的屏，报 Authorization required；读别人的 `.Xauthority` 和 home，报 Permission denied；两块屏的剪贴板互不可见。
- `/workspace` 用 setgid 加默认 ACL，bot-b 能追加 bot-a 建的文件，文件属组是 team、权限 660。只靠 umask 022 做不到，必须有默认 ACL。

### 这个形态顺带解决的事

- spacesd 以 bot 自己的用户运行，所以 computer_shell 和 computer_files 天然以该 bot 身份执行。03 号要的客机用户隔离不用再在命令外面套 sudo。
- 宿主侧继续按 bot 绑定端口和令牌，模型选不到别人的实例，沿用现有"电脑绑定由服务端持有"的规则。
- 原来 `cua` 用户的 `:1` 桌面和 3211 端口留作管理通道，用来建用户、装系统包。走这条路要用户审批。

### 资源

每个 bot 的 Xvfb、spacesd 和一个开着简单页面的浏览器，PSS 合计约 385 MiB，其中 spacesd 约 60 MiB、Xvfb 约 60 MiB。真实网页会更多，交给 10 号票。

### 旁支发现

`computer-backend.mjs` 的 type 先 `setClipboard` 再发 Ctrl+V，按键调用返回时浏览器还没读剪贴板。连续两次 type 间隔很短时，第二次写剪贴板会抢在第一次粘贴之前，结果粘进两遍第二段。一块屏也有这个问题，与多屏无关。实施时 type 要等粘贴落地，例如短暂等待后再放行下一次输入。

### 留给实施时在真实客机上验收

- 每 bot 一个 systemd 模板单元，以 bot 用户跑 Xvfb `:N`、xfwm4 和 spacesd。每个实例要给不同的 `--quic-port`，或者设成 0，否则第二个实例会报 QUIC 端口冲突。沙盒里已经撞到这个冲突。
- QEMU 的 user 网络现在只转发一个 spacesd 端口。每加一个 bot 要多一条 hostfwd，可以通过 QMP 在运行中添加，不必重启客机。
- 工作台按 bot 显示它自己那块屏。人工接管和归还从按整台电脑互斥改成按屏互斥。
- 沙盒里没有窗口管理器也能正确识别焦点窗口。客机里每块屏加 xfwm4 后要再确认一次多窗口时的焦点和层级。

## Comments