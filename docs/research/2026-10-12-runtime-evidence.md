# 本次调研的主代理运行证据

日期为 2026-10-12。产品源码未修改。所有可写探针均使用独立临时数据目录，没有接触现有 Bot 数据。

## 真实网页界面

启动命令为 `node ompbot.mjs serve --port 3197 --no-open --home C:/Users/<user>/AppData/Local/Temp/ompbot-research-20261012`。服务成功监听 127.0.0.1:3197。

使用 Chromium 打开实际页面。初始界面有新建 Bot、新建群聊、搜索、用量、主题入口。进入新建 Bot 表单后，实际 DOM 含名字、角色、模型、思考档、专属指令和主 Bot 选择。模型原生 select 有 218 项，包含默认项。这是本机配置下的样本，不是产品固定数量。没有在这次浏览器检查中完整测试移动端、键盘和读屏。

## HTTP 服务边界

对该临时实例直接发 HTTP 请求，观察到以下结果。

| 请求 | 状态 | 观察 |
|---|---|---|
| GET /api/state，Origin=https://example.invalid | 200 | 返回空团队状态 |
| GET /api/state，Host=example.invalid | 200 | 返回空团队状态 |
| POST /api/bots，Origin=https://example.invalid，Content-Type=text/plain，JSON 请求体 | 200 | 创建临时 Bot ResearchOriginProbe |

这证明服务端未拒绝非预期 Origin、Host 和 text/plain 写请求。调用通道为 Eval 网络客户端，不是恶意网页。没有证明任何特定浏览器、DNS rebinding 或浏览器本地网络权限环境下的完整攻击链，也没有测试跨源读取响应。源码交叉证据在 src/server.mjs:69、src/server.mjs:102。

## 真正 Bot 回合的目录边界

使用 BotRuntime 启动真实 `omp --mode rpc`，模型为 `magpie/commandcode-plan/deepseek/deepseek-v4.1-flash`，thinking=low。

在临时 home 根下创建 `outside-workspace.txt`，内容为 `RESEARCH_OUTSIDE_MARKER_75231`。Bot 的 cwd 位于该 home 下 `bots/audit/private/work`。明确要求 Bot 只调用 read 读取这个授权的临时文件，不访问其他文件或网络。

get_state.dumpTools 返回 `read,bash,edit,eval,glob,grep,task,wait,todo,web_search,write`。真实回合返回标记文本，status=completed。因此在本机当前配置下，工作目录外绝对路径读取是可行的。样本 n=1，仅证明这个路径读取能力，不证明任意系统文件都可读，也没有测试写入、网络外传或凭据泄漏。运行后停止进程并删除该探针创建的临时 home。

## 客户端超时契约

对真实 RpcClient 类创建一次受控探针，将 command 替换为记录命令的函数，用 20ms 等待 prompt_result。没有实际模型慢回合。

结果为 `timed out waiting for prompt_result:prompt_5`，sentCommands 只有 `["prompt"]`。这证明该方法的超时路径没有主动发送 abort。结合 src/bot.mjs:164 的 finally 回到 IDLE，可判定宿主状态缺少真实停止确认。实际 OMP 是否排队、拒绝或执行第二个 prompt，本次未验证，不能宣称已复现并行模型回合或数据损坏。

## 已有 OMP 能力验证

`omp --help` 实际显示版本 v18.10.0，支持 `--profile`、`--tools`、`--no-tools`、`--no-extensions`、`--no-skills`、`--approval-mode`、auth-broker、auth-gateway 等入口。这些开关不是 OS 沙箱的证明。

在另一个临时目录启动 `omp --mode rpc --no-ui --no-tools`，真实调用以下命令均返回成功。

| RPC 命令 | 结果 | 能证明什么 |
|---|---|---|
| abort | success | 当前版本接受中止命令，未验证繁忙工具的实际停止延迟 |
| set_event_filter，messageUpdates=delta | success | 当前版本接受增量事件订阅配置，未测真实流式渲染 |
| set_subagent_subscription，level=progress | success | 当前版本接受子代理进度订阅，未运行子代理 |
| new_session | success | 当前版本接受新会话命令，未做删除/遗忘完整验证 |
| get_available_models | success | 可通过运行时获取模型目录 |

官方 RPC 参考为 https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md 。官方 main 文档还列出 images、steer、follow_up、branch、fork、login 和 export_html。未在本次探针中调用这些命令，其可用性须在实施时针对打包 OMP 版本验收。

## 检查范围

本次未跑全套 npm test、未重新构建安装包、未登录或实操商业竞品、未向真实外部账号发消息、未更改持久模型设置。代理模型 override 仅本次会话生效。运行证据支持报告中的本机局部结论，不能当作所有能力的通过声明。
