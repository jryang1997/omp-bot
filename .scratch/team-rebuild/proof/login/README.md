# 09 登录一次所有 bot 共用的证据

- `login-e2e.mjs`：沙盒端到端。真实 Xvfb、cua-spacesd、Chromium 153 和仓库里的 `guest/omp-seat`、`guest/omp-login-sync`、`guest/chromium.d/omp-shared-login`，共享虚拟机换成沙盒本身（同 07、08，管理通道端口 3397）。两个正式脚本经座席层的开机补装装进去，不手工拷。结果在 `login-e2e.json`（6/6），登录屏截图 `login-screen.png`。
  - 开机补装：登录脚本和浏览器钩子的 sha256 跟仓库一致，钩子 root:root 0644
  - 登录屏：`openLogin()` 起 omp-login 座席并开好浏览器，用户的路径全走座席层输入接口（点一下、Ctrl+L、打字、回车），`publishLogin()` 关浏览器、以 root 发布、停登录屏，登录屏用户的进程全停
  - 共享库 `/var/lib/omp-login` root:team，目录 0750、文件 0640，bot 能读不能写
  - 两个 bot 同时开浏览器都是 alice；钩子带 `--password-store=basic` 和 `--disk-cache-size=268435456`；同步以 bot 身份跑，版本标记和 Cookies 归 bot 自己；浏览器开着时同步跳过；bot 自己在别的站点的登录还在
  - 关掉再开登录还在；本地清 cookie 只影响自己；在网站上点退出，大家一起掉线；登录屏再登一次大家都恢复
  - 结论和 02 的 `.scratch/team-architecture/login-proof/proof.json` 逐条一致
- `shot-login-panel.mjs`：面板。后端用替身，HTTP 接口和前端是真的。结果在 `panel-report.json`（10/10），截图 `panel-login-open.png`、`panel-login-done.png`。
  - Bot 的电脑面板有「网站登录」行，点「登录网站」直接打开登录屏，不用再点一次
  - 登录屏只有完成和关闭不保存，没有绑定和规格；开着就是用户在操作，不用接管
  - 实时画面能看到，点画面送出 click；点「完成」发布、写 `login.json`、显示上次发布时间；收起后视图移除；页面没有报错
- `site.mjs`：同 02 的假网站，多一个 `<title>`。沙盒里 headless 的 `--dump-dom` 会卡住，所以 bot 用真浏览器开在自己的屏幕上，经 xdotool 读窗口标题拿当前登录者。
- `chromium-wrapper.sh`：模仿 Debian 的 `/usr/bin/chromium`，source `/etc/chromium.d/*` 后带上 `$CHROMIUM_FLAGS`，profile 放 `~/.config/chromium`。装到 `/usr/local/sbin/chromium`，测完删掉。

运行：`cd /data/omp-bot && node .scratch/team-rebuild/proof/login/login-e2e.mjs`。前置同 07（Xvfb、xdotool、cua-spacesd，免密 sudo）。

途中发现并修掉的：
- Chromium 收到 SIGTERM 不把 cookie 写盘，只靠每 30 秒一次的定时写入。刚登录就点「完成」，发布出去的库是空的。实测 Ctrl+Shift+Q 和从命令行开 `chrome://quit` 都没反应，Ctrl+Shift+W 关掉最后一个窗口后浏览器正常退出，cookie 在。「完成」改成逐个窗口按 Ctrl+Shift+W，35 秒内退不掉才发 SIGTERM。
- 没有窗口管理器时点击不给键盘焦点，spacesd 拒绝发按键。登录屏开好浏览器后用 xdotool 把焦点给它。真客机有 xfwm4，这一步是兜底。

沙盒和真客机的差别：沙盒没有 xfwm4，浏览器窗口没有最大化（截图右边和下边是黑的）。

没覆盖的：真实 QEMU 客机里的 Debian chromium 包（钩子的 source 方式、profile 路径）、真实网站的登录（双因素、设备指纹）。这些要在有 KVM 或 WHPX 的机器上跑 `npm run smoke:computers` 后人工登一次。
