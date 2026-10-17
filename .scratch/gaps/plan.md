# gaps：把两份审计里认可的缺口补上

来源：两份外部审计（框架对比、护城河深挖）核对源码后的修正版方案。逐项落地，每步一提交、一推送。

## 退出条件（可检查）

全部 issue 的 `Status:` 是 `done` 或 `skip`（skip 要写原因），且 `node test/<相关>.mjs` 全绿、`decisions.tsv` 每步有一行。

## 先纠正审计里的错

- 例行任务已经落账本（`routines.mjs:162-179`），不是"无持久化"。
- 接管已有（`web/workbench-computer.js`、`computers.mjs`）。真缺口是截图 3 秒轮询、bot 不能主动求助。
- `hosttools.mjs` 是聊天模式的只读工具，不是正则闸门。命令审批是 OMP 原生的。
- 密钥占位已开（`persona.mjs` 的 `secrets:`）。
- mnemopi 每 bot 记忆有，但默认关（要下 2.7GB 模型）。

## 顺序

| # | 内容 | 更省的路 |
|---|------|----------|
| 01 | 审批分级：只读命令自动放行 | 不写宿主分类器。用 OMP 原生 `bash.patterns` + `tools.approval`，由 persona 写进配置覆盖层。零 token，OMP 内部按真实参数判 |
| 02 | 卡住/死循环检测 | 宿主侧确定性指纹（工具名+参数+结果），连续重复先 steer 换策略，再重复就取消。OMP advisor 当可选项，不默认开（每次评审花 token） |
| 03 | 事件触发的例行任务 | 不开 webhook（服务只听回环）。计划加宿主侧检查命令，没变化不叫 bot，零 token |
| 04 | 电脑求助 | `computer_request_help` 工具 + 等待态 + 通知；接管期间截图加快 |
| 05 | 中断 Run 的安全续跑 | 没有进行中副作用才续，最多一次，走 OMP `--continue` |
| 06 | 派活分档 | `delegate_bot` 加 `tier`，映射到 OMP 模型角色 |
| 07 | 默认轻量记忆 | 待研究：OMP 自带 memory 能否直接开 |
| 08 | 显式计划状态 | 待研究：OMP todo/goal 事件是否已够用 |
| 09 | ask 模式写入限在工作目录 | 待研究 |

不做：凭据代理、UI 时间线/在场/画布、自建 Sentinel（moat 计划已跳过，理由不变）。

## 每步怎么验

单元测试进 `test/*.mjs`；跑相关测试和不需要真模型的那部分全量测试；结果写进 issue 的 `## Comments` 和 `decisions.tsv`。
