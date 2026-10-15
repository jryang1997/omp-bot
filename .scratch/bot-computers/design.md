# Computer integration synthesis

基底采用应用自管 QEMU 生命周期、进程内官方 Cua SDK 与 OMP host tools。独立评判见 local://computer-design-judgement.md，两个候选见 local://computer-design-sdk.md 与 local://computer-design-mcp.md。两候选独立上下文；运行时没有提供可核验的模型家族差异。边界评审子任务被中断，没有有效结论，实施后另作独立审查。

选择依据是复用现有 RPC 的审批、取消、进度和 image content，避免再添加 OMP MCP server、命名管道 shim 和能力 token。吸收第二候选的正交电脑绑定、电脑粒度租约、generation 与旧输入拒绝。

电脑字段与 executionMode 正交。既有本机 Bot 默认无绑定，保持现有模式。电脑绑定的非聊天 Bot 保留团队工具和 rpc-ui 审批，但关闭全部原生本机工具、扩展、skills 和用户/项目 MCP；实际 dumpTools 只准所注册的固定客机工具、团队工具和 ask。聊天档继续只聊天，不因绑定自动获得执行能力。

服务端独占 computerId、客机地址、根 token、宿主落盘路径。模型 schema 无目标字段。每台电脑固定独立 SDK 客户端、磁盘和状态目录。桌面使用工作台同源图片/输入接口，人工输入必须检查当前接管 generation；不向 UI 发可长期绕过归还的完整控制 viewer ticket。

部署层与客机操作分开。官方 0.4.1 Windows QEMU 生命周期的源码 pid_alive 恒 false，不能作存活真值源。生命周期用应用自己的 Windows 进程/QMP 监督，客机采用官方 Cua Linux 镜像与 spacesd 接口。已实测 whpx,kernel-irqchip=off 开机后健康接口返回 204，SDK 完成 Linux 命令和 1280×800 截图。双机、取消与停启仍须验收。

完成条件维持 spec.md，不降成仅状态面。Shell 取消必须终止或保持效果未知；截图进模型、客机文件和 profile 跨停启、两 Bot 隔离、同电脑跨 scope 独占和成果往返均是实际运行门。
