# 当前浏览器实现与 Ego Lite 效率判断

研究范围为现有 OMP Bot 的浏览器路径、Ego Lite 官方能力和本机可验证的接入条件。读取代码、公开资料与已安装的随包技能，并分别在 OMP Chromium 与 Windows Ego 的自建测试页面运行功能探针；未改变执行权限、安装浏览器或迁移登录。

## 当前实现

绑定电脑的 Bot 使用独立 Linux VM 中的 Chromium。OMP 模型留在 Windows，`Computers.guestTools` 注册固定客机截图、输入、命令与文件工具。`computer_screenshot` 把 PNG 作为 image content 给模型；`computer_input` 调用固定 SpacesdClient 的鼠标键盘。工作台每 3 秒轮询状态与桌面图片，不是内嵌 Chromium 页面，也不是直接读取网页 DOM。来源为 `src/features/computers.mjs:1201`、`src/computer-backend.mjs:761`、`web/workbench-computer.js:15`。

客机中的浏览器 profile 落在持久虚拟磁盘，停启验收使用 `/usr/bin/chromium` 和 `/home/cua/.config/ompbot-smoke-browser`，实际 localStorage 保留。电脑任务的模型没有宿主 `eval/browser`，目前没有专门的客机 DOM、定位器或浏览器 CDP 工具。模型也可以在客机 shell 自行运行浏览器脚本，因此并非所有任务都必须按像素点击，但产品尚未提供标准浏览器自动化接口。

未绑定电脑的本机 Bot 仍有 OMP 原生 browser Eval 路径，支持 Chromium/CDP/relay。旧「浏览器接管」只暂停空闲 Bot 的新回合，需要先由 Bot 打开可见窗口，与新的 VM 整机接管是不同接口。来源 `src/features/native.mjs:826`。

## Ego 的可核实优势

[官方 ego-browser 文档](https://lite.ego.app/document/en/docs/ego-browser) 给出单个 Node 脚本组合导航、snapshotText、click、fill、js 和 CDP 的接口。[产品介绍](https://lite.ego.app/document/en/docs/product-introduce) 称其浏览器引擎内的 Snapshot 可覆盖跨域 iframe 与 shadow DOM，典型页面为 200–400 tokens。这是官方声明，不是本项目实测。


[Snapshot 说明](https://lite.ego.app/document/en/docs/snapshot) 同时指出离屏内容、图片内文字、复杂 Canvas 和受限跨域 iframe 可能无法完整读取，所以它仍需要截图补充。不能把营销中的 iframe 覆盖理解为任何网页都可完整提取。

[官方 Space 文档](https://lite.ego.app/document/en/docs/space) 描述每任务独立 BrowserContext、cookies 和 storage，同时复用已有登录环境。当前随包 `ego-skills/ego-browser/references/clearing-state.md:3` 却明确同 profile 的 cookie jar 与 HTTP cache 被用户标签和所有 Space 共享。这两个来源冲突；本轮未读写 cookies 来裁决。Bot 的独立账号边界必须按 profile 设计，不能仅靠 Space；当前独立 VM 的浏览器身份保证不能直接替换为共享宿主 profile。

[官方 README](https://github.com/citrolabs/ego-lite) 公开下载指向 macOS，Windows 闭测仍为预告，Linux 在 roadmap。但本机实际已安装 Windows 0.5.2.15，并通过绝对路径执行 `ego-browser.exe --version`，输出 Chromium 154.0.8037.44、Node v24.21.0。公开资料与实际安装不同步，不能据此声称 Windows 不可运行。本机 CLI 路径为 `C:/Program Files/Citro Labs/ego lite/Application/0.5.2.15/ego-browser.exe`；随包技能 v2.0.0 提供 Windows 调用方式。Linux 客机兼容与跨机控制未验证。[自建 Harness 指南](https://lite.ego.app/document/en/docs/custom-agent-harness) 指出 VM/远端访问宿主 Ego 需要 host bridge；给电脑 Bot 开放任意宿主 shell 会改变现有隔离契约。

## 效率判断

相对当前逐步截图、鼠标键盘的网页操作，DOM/语义树、定位器与批处理预计减少模型回合、图像输入和滚动试探，尤其适用于后台表格、搜索、填表和导出。此为机制推断，没有本机 Ego 与 CUA 的耗时或 token 对照。

相对已有 OMP 原生 browser，Ego 的优势需证明 Snapshot 质量、复杂 iframe 和登录复用，不能仅凭「支持单次脚本批处理」。本次 OMP managed Chromium 的一次 `tab.run` 完成页面设置、输入“北京”、点击筛选、提取表格并断言 `北京\t37`。Windows Ego 的一次脚本也完成自建页面、snapshot、fill、click 与精确结果断言；恢复同一 Space 后语义快照和数据仍确认只显示北京、37，随后 `finish({keep:[]})` 回执确认 Space 关闭。两侧均为单个功能样本，不是同模型速度或 token 对照。记录见 `.scratch/ego-browser-research/native-batch-proof.json` 和 `ego-batch-proof.json`。

Ego 探针的 `page.screenshot()` 在 `Page.captureScreenshot` 超时；同 Space 的受限时 raw CDP 截图也超时。因此只记录语义功能通过，截图未通过，不能宣称全部能力验收或得到视觉证据。该异常未改动、未掩盖，也未调查根因。

公开基准也不能直接换算成本项目收益。[产品介绍](https://lite.ego.app/document/en/docs/product-introduce) 的 31 任务比较对象是四种浏览器 CLI；[README](https://github.com/citrolabs/ego-lite) 另称四任务相对 agent-browser 最多快 2.5 倍。[基准框架](https://github.com/citrolabs/ego-browser-benchmark-framework) 明确结果不是通用排行榜，应固定模型、登录、任务、skill、并发和 judge。它们均未直接比较本项目 CUA 或 OMP browser。

## 建议

优先在各 Bot 自己的 Linux VM 中补受控 Chromium CDP/Playwright 路径。服务端固定电脑和浏览器目标，所有动作继续经过现有电脑租约、generation、审批、取消与附件成果接口。普通网页任务走语义读取与批量操作；Canvas、桌面弹窗和网页登录视觉步骤仍使用 CUA。这样获得主要浏览器自动化收益，同时保留每 Bot 的磁盘、profile 与账号边界。


当前 Cua 的 `TunnelService.Forward` 协议允许经授权 WebSocket 转发客机端口，目标限制为 loopback 或客机自身地址，并提供到期 ticket 与 CloseForward。它是连接客机 CDP 的候选能力，不需要开放任意宿主浏览器；本轮只核对协议，未实跑 CDP 隧道。来源 `.scratch/bot-computers/vendor/cua/libs/cua/proto/cua/env/v1/tunnel.proto:19`。

本机 Ego 可作为未绑定电脑 Bot 的可选宿主浏览器路径。接入前仍需服务端固定 Bot→profile→Space、隔离工具权限，并验证人工接管和取消；本轮未实施。它不直接替换 Linux VM 路径，不能承诺相对 CUA/OMP 的速度提升倍数。

## 未测

未测：与 CUA/OMP 的同模型同任务耗时及 token 对照、客机 CDP 接入、跨 Bot cookies 隔离和切换接管时的命令取消。Windows Ego 的基础语义操作已实跑，截图失败；公开来源细节见 `2026-10-13-ego-lite-source.md`。
