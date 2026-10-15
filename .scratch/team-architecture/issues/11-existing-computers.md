# 11 已有的每 bot 电脑怎么办

Type: grilling
Label: wayfinder:grilling
Status: open
Blocked by: 02, 03, 09

## Question

现在每个 bot 一台虚拟机，里面有文件和浏览器登录。换成共享电脑后，这些怎么处理。

## Options

- 把每台旧电脑的 home 自动拷进共享电脑里对应的用户目录。
- 旧电脑保留一段时间，让用户自己搬。
- 直接弃用。

浏览器登录大概率要重新登录一次。

## Need from user

选一个。删除旧虚拟机磁盘不可逆，必须由用户确认。

## Comments

- 2026-10-15 建议。旧电脑 home 自动复制进共享电脑对应用户的 `~/old-computer/`，不覆盖新文件。旧磁盘保留，用户在界面上点删除才删。浏览器登录要重登一次。已发给用户等确认。
