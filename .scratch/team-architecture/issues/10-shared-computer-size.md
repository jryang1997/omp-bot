# 10 共享电脑的规格

Type: research
Label: wayfinder:research
Status: open
Blocked by: 01, 02

## Question

一台共享虚拟机给多少 vCPU、内存和磁盘，能撑几个 bot 同时开屏幕和浏览器。

## Facts

宿主 31.8 GiB 内存，上次实测空闲 11.6 GiB。现在每 bot 一台 2 vCPU、2 GiB。

## What to check

在 01、02 选定的方案下，实测 1、3、5 个 bot 并行时的内存和 CPU。给出默认值和上限，以及空闲屏幕是否自动休眠。

## Done when

默认规格、上限和实测数字写进 Answer。

## Comments