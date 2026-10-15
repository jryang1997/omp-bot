# 02 共享浏览器登录与多屏并行

Type: prototype
Label: wayfinder:prototype
Status: open
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

## Comments

- 01 号实测时发现，浏览器调试端口监听 127.0.0.1，同一台客机上别的 bot 用户也能连上并操作这个浏览器。cua-driver 的浏览器工具正是通过 CDP 驱动 Chromium。选方案时要一并解决，例如改用 `--remote-debugging-pipe`，或者只在需要时临时开端口。
- 01 号的形态下每个 bot 是独立 Linux 用户，profile 在各自 home 里。"共用一个 profile"需要跨用户共享目录，与 03 号的隔离相冲突，候选里的同步 cookie 和共享 CDP 浏览器更合适。