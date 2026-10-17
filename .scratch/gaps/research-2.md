# 第二轮：复测 + 真模型 + 对标补充

## 复测（gaps 32a67ed）
- test/*.mjs 29 个全过（补 node_modules 软链后 channels 34/34、file-share 11、mobile 112/112、seats 22/22）
- 新测试：approval-tiers 5/5、stuck 8/8、routine-check 6/6、computer-help 7/7、resume 5/5、plan-state 5/5、write-guard 6
- test/real-omp.mjs（真 omp 18.11.3 + 脚本假模型）6/6
- UI 回归 9 个全过

## 真模型
- 本机没有任何模型 key。外网通。omp login 支持设备码（ChatGPT Codex headless、GitHub Copilot 等）。
- 待主人选提供商。测：02 真实打转是否误杀、01/09 审批、05 续跑、06 派活、07 记忆、子任务被取消时父助手是否如实转告。

## 发现的安全问题（01 引入）
- READ_ONLY_BASH_PATTERNS（src/persona.mjs）含 cat/grep/head 等通配，ask 档下 `cat ~/.ssh/id_rsa`、
  `cat $OMPBOT_HOME/server.json`（服务 token）直接放行；read 工具读这些也不弹卡。
- 修法：复用 09 的 OMP tool_call 扩展加敏感路径硬拦，read/bash/write 都拦，全部放手档也拦。

## 对标（源码在 /data/research）
- openhuman：命令按类别分级且 fail-closed；无论档位硬拒 ~/.ssh ~/.gnupg ~/.aws 和系统目录；
  无进展断路器 Continue→Nudge→Halt，超时/限流/5xx 阈值放宽；子代理三态 Completed/AwaitingUser/Incomplete{reason}，
  父代理转告阻碍不重派；停止后如实收尾；工具失败分类（缺权限/凭据错/被拦/用户拒绝不自动重试）；按回合来源决定审批。
- OpenMausBot：审批卡保存精确命令白名单；例行任务可设运行时长上限。
- OMP 原生可复用：tools.approval、bash.patterns、model.toolCallLoopGuard、retry.fallbackChains、tool_call 扩展。
  OMP 没有原生敏感目录保护。

## 候选改进（按优先级）
1. 敏感路径硬拦
2. 卡住取消后不沉默，父助手不重派同样的活；可恢复错误放宽阈值
3. 审批卡"以后都允许这条命令"→ 写进该助手 bash.patterns
4. 外部渠道（飞书/手机）来的回合更严格审批
5. 可选：例行任务运行时长上限、工具失败分类人话展示
