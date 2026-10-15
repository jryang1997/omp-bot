# 01 共享电脑里每个 bot 的屏幕

Type: research
Label: wayfinder:research
Status: open
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

## Comments