# 09: 登录一次，所有 bot 共用

**What to build:** 共享电脑里有一个登录屏。界面上"登录网站"打开它，用户接管登录后点"完成"，座席层发布 cookie。bot 的浏览器启动时并入共享 cookie。已有镜像在第一次就绪时补装脚本和浏览器钩子。

**Blocked by:** 07

**Status:** done

- [x] 登录屏座席和接口，打开、完成两个动作
- [x] 完成时运行发布，共享库归 root:team 只读
- [x] 浏览器钩子加 basic 密码存储和 256 MiB 缓存上限，并以 bot 身份同步
- [x] 沙盒假网站测试改为调用仓库里的正式脚本，结论与 02 号票一致
- [x] 团队 AGENTS.md 模板写明不要点共享网站的退出、不要开调试端口

落地记录：

- 座席层：`SeatBackend.openLogin()` 起 omp-login 座席（07 已有的登录座席），浏览器没开就开一个，开好后用 xdotool 把键盘焦点给它。`publishLogin()` 先正常关浏览器，关不掉就不发布；再经管理通道以 root 跑 `omp-login-sync publish --group team`；发布失败保留登录屏，成功才停登录屏。返回发布时间和状态。
- 关浏览器：Chromium 收到 SIGTERM 不把 cookie 写盘，只靠每 30 秒一次的定时写入，刚登录就点「完成」会发布一个空库。沙盒实测 Ctrl+Shift+Q 和 `chrome://quit` 没反应，Ctrl+Shift+W 关掉最后一个窗口后正常退出、cookie 在。所以逐个窗口按 Ctrl+Shift+W，35 秒内退不掉才发 SIGTERM。这段脚本导出成 `BROWSER_QUIT`。
- 补装：`GUEST_FILES` 从一份变三份，`omp-seat`、`/usr/local/lib/omp-bot/omp-login-sync`（0755）、`/etc/chromium.d/omp-shared-login`（0644），开机比对 sha256，不一致才传，传之前建好目录。
- 钩子：`guest/chromium.d/omp-shared-login` 加 `--password-store=basic` 和 `--disk-cache-size=268435456`，以启动浏览器的 bot 身份跑 `sync`，登录屏用户自己不 sync，失败不挡浏览器启动。
- 接口：`GET /api/computer/login`，`POST /api/computer/login/open|done|stop|input`，`GET /api/computer/login/screen`。开着时控制方就是用户，不用接管；输入要带当前代号，每次打开、完成、关闭都换代号。发布时间记在 `<home>/computers/login.json`。后端没有登录屏时回 501 `computer_login_unsupported`。
- 界面：Bot 电脑面板的状态卡多一行「网站登录」，点「登录网站」在面板里展开登录屏并直接打开。登录屏只有完成和关闭不保存，显示上次发布时间。
- 模板：`team/AGENTS.md` 模板的共享电脑规则 07 时已写明不点共享网站的退出、不开远程调试端口，这里没再改。
- 测试：`test/seats.mjs` 加 2 项到 18 项（关浏览器、发布、停登录屏的顺序，发布失败保留，关不掉不发布；HTTP 接口全流程和 501）。15 个测试文件全过，smoke-gui 56/56。
- 沙盒端到端：`.scratch/team-rebuild/proof/login/`。`login-e2e.mjs` 用真实 Xvfb、spacesd、Chromium 153 和正式脚本，6/6，结论和 02 的 proof.json 逐条一致，连跑三次都过。`shot-login-panel.mjs` 面板 10/10。
- 待实机：真实客机里的 Debian chromium 包（钩子的 source 方式、profile 路径、xfwm4 下的焦点和关窗）、真实网站的登录、`smoke:computers`。
