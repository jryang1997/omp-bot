# 10: 旧电脑的文件搬进共享电脑

**What to build:** 共享电脑第一次就绪后，座席层依次开机每台旧的每 bot 电脑，把 `/work` 和主目录打包，解到对应座席的 `~/old-computer/`，再关机。界面上每台旧电脑有"删除旧电脑"。

**Blocked by:** 07

**Status:** done

- [x] 旧电脑记录被识别，复制按 bot 依次进行，进度和错误可见
- [x] 不覆盖已有文件，已完成的跳过
- [x] 旧磁盘保留，点"删除旧电脑"才删，删除前确认
- [x] 替身后端测试覆盖复制、跳过和删除

落地记录：

- 识别：`ComputerBackend.listComputers()` 列出有 `vm.json` 的电脑，去掉共享电脑就是旧电脑。旧电脑的 id 就是 bot 现在的座席 id。对不上任何 bot 的记成 orphan，不复制，只能删。
- 复制：`SeatBackend.migrateOld()` 一台一台来。开旧电脑，以 cua 打包 `/work` 和主目录（读不到的文件跳过，`.cache` 和浏览器 profile 不带，登录到登录屏重登），取回宿主，关旧电脑；座席没开就开，经管理通道传到 `/var/tmp/omp-old`（root 0700），`omp-seat import-old` 以座席用户身份解到 `~/old-computer/work` 和 `~/old-computer/home`，`--skip-old-files` 不覆盖已有文件，解完删包；座席原来没开就再关上。进度存在 `<home>/computers/old-computers.json`（0600）。
- 何时：任一 bot 座席开机成功后，有待复制的就在后台开始，不挡开机。做完的跳过；出错的记下哪一步错了，用户点「重试复制」才再来，免得每次开机都重撞同一个错。一台出错不挡后面的，出错时也把旧电脑关上。
- 删除：`ComputerBackend.remove()` 先关机，关不掉不删，再删整个电脑目录。复制中不删。接口要 `confirm: true`，界面先弹确认框，没复制完的提醒文件还没进共享电脑。
- 接口：`GET /api/computer/old`（带 botName），`POST /api/computer/old/<id>/copy`，`POST /api/computer/old/<id>/delete`。
- 界面：Bot 电脑面板有旧电脑时多一行「旧电脑」，显示进度、出错原因、文件数和时间，按钮「重试复制」「删除旧电脑」。助手已删的旧电脑也列在这里。
- 测试：`test/seats.mjs` 加 3 项到 21 项（编排顺序、做完跳过、座席开机自动开始、原来开着的座席不关；出错要重试、orphan、复制中不删；HTTP 接口和 confirm）。去掉关座席、出错自动重试、去掉确认、复制中可删、出错不关旧电脑、不自动开始，对应测试都会失败。15 个测试文件全过，smoke-gui 56/56。
- 沙盒端到端：`.scratch/team-rebuild/proof/old/`，真跑打包和 `import-old` 4/4，面板 8/8。
- 待实机：真实旧电脑和共享电脑之间的整条链路（QEMU 里的 cua 用户、spacesd 传大文件、两台虚拟机同时开的内存）。
