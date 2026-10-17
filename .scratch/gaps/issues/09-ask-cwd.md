# 09: ask 模式写入限在工作目录

**What to build:** ask 权限下，写文件只能落在 bot 工作目录内。

**Blocked by:** 无

**Status:** done

- [x] 不硬拦，改成弹卡。目标在 bot 目录、工作区（--add-dir）、系统临时目录以外，write/edit/ast_edit 先弹「允许改目录外的文件？」，主人同意才写；没 UI 或不同意就拦
- [x] 走 OMP 原生扩展：`--extension <bot 私有目录>/write-guard.js`，`tool_call` 处理器返回 `{block, reason}`。扩展文件不在 cwd 里，每次启动重写
- [x] edit 三种整段格式（hashline、apply_patch、sloppy）都抠路径；抠不出就当看不出，照样弹卡
- [x] 路径先解 `~`、`file://`、相对路径和软链再比；`local://` 这类内部 URL 交给 OMP
- [x] 只挂在 supervised + write；全部放手、每次都问、chat 不挂
- [x] `test/write-guard.mjs` 6/6；软链、前缀冒充、缩进头、忽略同意、忽略无 UI 五个变异都抓到

## Comments

查了 OMP 源码（tools/approval.ts、internal-urls/router.ts）。write 档对普通路径一律给 write 级，不看在不在 cwd 里，也没有按路径升级的原生开关。`tools.approval` 只能整个工具 allow/deny/prompt，用它等于退回「每次都问」。

所以用 OMP 自己的扩展口子补：`tool_call` 处理器能拦，出错按拦处理；rpc-ui 下 `ctx.ui.confirm` 会变成工作台已经支持的 confirm 卡。

额外收获：bot 以前在这档能直接改 team/AGENTS.md，绕过团队事实的提议审核。现在会弹卡。

扔掉的：硬拦（主人想让它改 ~/.gitconfig 也得换档，太死）；把 edit 钉成 replace 模式好解析（会改所有 ask 档 bot 的编辑方式和准确率）；从 OMP 内部包 import 原生 editInspect（跟版本绑死，验不了）。

没管的：cwd 里面的 `.omp/`、`.mcp.json` 这类项目配置。改了它们下次启动能跑命令，但这是 cwd 内的问题，不在这条范围，列进注意事项。没在真 omp 上跑过；事件形状按 OMP 源码对照，生成的扩展模块在 Node 里真加载过。
