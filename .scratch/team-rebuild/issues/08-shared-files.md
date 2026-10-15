# 08: 共享工作区和私有文件挂进客机

**What to build:** omp-bot 内置 SFTP 服务，导出 `team/workspace` 和每个 bot 的 `bots/<id>/work`。座席就绪时客机用 sshfs 把前者挂到 `/workspace`，后者以 bot 用户身份挂到 `~/work`。

**Blocked by:** 01, 07

**Status:** ready-for-agent

- [ ] SFTP 服务只监听本机回环，只认 omp-bot 生成的密钥，按用户名分根
- [ ] 越出根的路径和符号链接被拒绝
- [ ] 沙盒里用真实 sshfs 测双向即时可见、改名落盘、并发追加不丢
- [ ] 座席脚本挂载 `/workspace` 归 team 组，`~/work` 只有该 bot 能读写
- [ ] 服务随 omp-bot 启停，端口和密钥经座席层传进客机
