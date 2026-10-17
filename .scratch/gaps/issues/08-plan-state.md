# 08: 显式计划状态

**What to build:** 工作台看得到 bot 当前计划和进度。

**Blocked by:** 无

**Status:** done

- [x] 不新建计划状态。直接用 OMP 原生 `todo` 工具结果里的 `details.phases`（每次改动都带完整计划）
- [x] `planFromTool`：只认 todo 的成功结束帧；查看（`op: view`）、出错、形状不对都不显示，不猜
- [x] 任务卡片里显示"计划 已做/总数"，分阶段列出，进行中加粗，卡住的带原因
- [x] `test/plan-state.mjs` 5/5；去掉工具名判断、去掉 view 判断两个变异都抓到

## Comments

查了一遍。工作台原来只认 `todo_reminder` 帧。OMP 源码（session/todo-tracker.ts）里这个帧只在 bot 想停下但清单没做完时才发，而且只带没做完的项。所以平时看不到计划，只有催的时候闪一下。

真实的计划在 `todo` 工具的结果里（tools/todo.ts：`details: { op, phases, storage }`）。工具帧本来就转发到前端，只差解析。零新状态、零 token、跟 OMP 一致（OMP 自己的 HUD 也是从这里读）。

没在真 omp 上跑过；帧形状按 OMP 源码对照。goal 帧原样保留。
