# 07 共享电脑座席的证据

- `seats-e2e.mjs`：沙盒端到端。真实 Xvfb、cua-spacesd 0.5.3 和 `guest/omp-seat`，共享虚拟机换成沙盒本身，sudo 起一个 root 的 cua-spacesd 当管理通道。座席端口不经 QEMU 转发，直接连。结果在 `seats-e2e.json`（9/9），两张截图是两个座席各自的屏幕（A 画红块，B 画蓝块）。
- `shot-panel.mjs`：电脑面板截图。后端用替身，规格接口是真的。结果在 `panel-report.json`（7/7），截图 `panel-unbound.png`、`panel-bound.png`。

前置：`sudo dnf install -y xorg-x11-server-Xvfb xorg-x11-xauth xdotool`，`sudo install -m 0755 <cua-spacesd> /usr/local/bin/cua-spacesd`，ImageMagick 的 `magick` 和 `display`。

没覆盖的：真实 QEMU 里开共享虚拟机、17 个端口转发真的连得通、镜像里补装脚本、Debian 客机里 apt 真的装上包。这些要在有 KVM 或 WHPX 的机器上跑 `npm run smoke:computers`。
