# 02 共享浏览器登录与多屏并行

Type: prototype
Label: wayfinder:prototype
Status: resolved
Blocked by: 01

## Question

用户登录一次网站，所有 bot 都能用。同时两个 bot 在各自屏幕上用浏览器，互不冲突。

## Why it matters

一个 Chromium profile 同一时间只能被一个进程打开。第二个实例会把窗口交给第一个进程，开在别人的屏上，或者直接失败。

## Candidates

- 每 bot 独立 profile，从一个主 profile 同步登录 cookie。
- 一个共享浏览器进程，bot 通过 CDP 各开标签页，屏幕只用来给人看。
- 每 bot 独立 profile，用户逐个登录。体验最差，只作退路。

## Done when

选定一个方案，在真实客机里证明三件事。登录一次后两个 bot 并行使用；停启电脑后登录还在；一个 bot 退出登录不影响别人，或者明确记下会影响。

## Answer

每个 bot 用自己的 Chromium profile，启动浏览器前从共享登录库并入 cookie。用户在一块专门的登录屏上登录一次，所有 bot 下次开浏览器就是登录状态。

### 做法

- 共享电脑里多一个不属于任何 bot 的用户 `omp-login`，有自己的屏幕和 spacesd。界面上的"登录网站"打开这块屏，用户接管后登录，点"完成"。
- "完成"时 omp-bot 走管理通道运行 `omp-login-sync publish`，用 SQLite 的备份接口把登录屏的 cookie 拷进 `/var/lib/omp-login/`，归 root:team，0640。
- Debian 的 `/usr/bin/chromium` 启动前会读 `/etc/chromium.d/` 下的每个文件。放一个钩子，给所有 profile 加 `--password-store=basic`，再以 bot 用户身份运行 `omp-login-sync sync`。共享库比上次新，而且这个 profile 没被占用，就把共享 cookie 用 `INSERT OR REPLACE` 并进去。
- 所有 profile 用同一种 cookie 加密方式，行可以直接搬，bot 自己在别的网站的登录不受影响。
- 脚本在仓库 `guest/omp-login-sync` 和 `guest/chromium.d/omp-shared-login`。

### 实测

沙盒替身，Chrome for Testing 153，假网站按 cookie 认人，退出时在服务端吊销会话。脚本和结果见 `login-proof/`，`proof.json` 和 `perm.out` 可以重跑。

- 登录一次后两个 bot 同时开浏览器，都显示已登录。
- bot-a 事先在另一个站点的登录，同步后还在。
- 再次同步是空操作。浏览器开着时同步会跳过，不改正在用的库。
- 关掉浏览器再开，登录还在。登录跟着 bot 自己的 profile 走，停启电脑也在。
- 一个 bot 只在本地清 cookie，别的 bot 不受影响。
- 一个 bot 点了网站的"退出"，服务端吊销了会话，所有 bot 都掉线。这是共用一个会话的必然结果，用户要在登录屏重登一次。`team/AGENTS.md` 写明 bot 不要点共享网站的退出。
- 用户重登并发布后，两个 bot 下次开浏览器都恢复。
- 权限。共享库目录和文件都是 root:team 只读，bot 用户能同步，组外用户读不到。bot 新建的 cookie 库是 0600。

### 不在范围

- 登录状态存在 localStorage 或 IndexedDB 里的网站。只同步 cookie。
- 已经开着的 bot 浏览器不会立刻拿到新登录，要等它下次启动。
- 调试端口。我们的客机工具只用截图和输入，不用 CDP，浏览器按默认方式启动不开调试端口，01 发现的跨用户连接问题不出现。`team/AGENTS.md` 写明不要用 `--remote-debugging-port` 开浏览器。

## Comments

- 01 号实测时发现，浏览器调试端口监听 127.0.0.1，同一台客机上别的 bot 用户也能连上并操作这个浏览器。cua-driver 的浏览器工具正是通过 CDP 驱动 Chromium。选方案时要一并解决，例如改用 `--remote-debugging-pipe`，或者只在需要时临时开端口。
- 01 号的形态下每个 bot 是独立 Linux 用户，profile 在各自 home 里。"共用一个 profile"需要跨用户共享目录，与 03 号的隔离相冲突，候选里的同步 cookie 和共享 CDP 浏览器更合适。

- 2026-10-15 待用户定。网站登录是所有 bot 共用，还是按网站选哪些 bot 能用。这决定同步 cookie 时要不要按站点过滤。问题、利弊和建议已发给用户。
- 2026-10-15 用户选 A，网站登录全员共用。
