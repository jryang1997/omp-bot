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