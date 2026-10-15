# 04 本机 omp 怎么碰到客机里的文件

Type: research
Label: wayfinder:research
Status: open
Blocked by:

## Question

bot 用 omp 原生的读、写、编辑、搜索工具改了文件，再到客机里运行。两边怎么保证是同一份文件。

## Why it matters

D3 之后 bot 同时有本机工具和客机工具。共享文件如果只在客机 `/workspace`，omp 的编辑和搜索就用不上，只能靠 computer_files 来回搬，1+1 还是小于 2。让 bot 在客机里再装一个 pi 来改文件也行，但那是套娃，模型费用和上下文都要付两份。

## What to check

- Windows 宿主上的 QEMU 是否支持 virtfs/9p。我目前的判断是不支持，需要核实。
- 候选通道。客机开 SMB 或 SFTP 由宿主挂载；宿主共享文件夹由客机用 cifs 挂载，要确认非管理员能否做到；继续用 computer_files 同步。
- 选定后共享文件只能有一个权威位置。宿主 `team/workspace` 和客机 `/workspace` 不能各存一份。
- bot 的私有目录要不要也两边可见。

## Done when

选定通道，实测宿主写客机读、客机写宿主读、两边并发写、中文路径。

## Comments