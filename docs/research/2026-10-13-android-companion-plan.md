# omp-bot 安卓伴侣应用研究

日期为 2026-10-13。本轮只做研究和隔离运行检查，没有修改业务代码、安装 Android 工具或开放远程端口。

本文保留第一轮研究的证据与建议。后续已按用户要求直接复用 OpenMausBot 安卓源码并适配 omp-bot，当前安装和构建入口见 [根目录 README](../../README.md#安卓手机)，移植范围见 [安卓来源记录](../../android/PROVENANCE.md)。

## 结论与范围

建议做 Kotlin + Jetpack Compose 原生安卓伴侣应用。Bot、模型凭据、任务执行、电脑与成果仍由当前 Windows 服务持有。手机负责选择 Bot、聊天派活、看运行、补充任务、停止、审批、上传资料和领取成果。用户这轮只要求安卓，因此跨平台框架的收益较小。

这是基于当前工程的设计建议，不是已经实现或经过真机验证的结果。Android 官方把 Compose 列为推荐的原生界面工具包，见 [Compose 官方介绍](https://developer.android.com/compose)。本项目现有网页是原生 DOM 模块，没有可直接搬到 React Native 的 React 组件，见 [package.json](../../package.json)、[web/app.js](../../web/app.js)。

连接建议采用 Tailscale 私网 HTTPS，前面放只允许设备操作的入口，复用现有 API 和编排器。Tailscale Serve 能把本地服务安全地提供给同一 tailnet 内的设备，见 [官方 Serve 文档](https://tailscale.com/docs/reference/tailscale-cli/serve)。这需要电脑和手机加入有相应访问权限的私网。它解决可达性与传输，不解决手机后台通知，也不会保持电脑永不休眠。本轮没有启用 Serve。

## OpenMausBot 的手机连接结构

OpenMausBot 已发布 [安卓 1.5.0 APK](https://github.com/milind-soni/OpenMausBot/releases/tag/android-v1.5.0)。[发布快照 README](https://github.com/milind-soni/OpenMausBot/blob/16ad4080f20fcd2fb310e27d527ce0f6a36e3724/android/README.md) 确认原生 Kotlin + Compose，分 `core` 协议模块和 `app` 平台模块，最低 Android 8.0。安卓源码在发布分支与标签，当前 main 没有 `android/`。因此此次实现证据以提交 `16ad4080f20fcd2fb310e27d527ce0f6a36e3724` 为准，不代表未发布特性分支或商店最新包。

该快照没有 FCM 依赖，通知来自活动 SSE。其 [后台生命周期源码](https://github.com/milind-soni/OpenMausBot/blob/16ad4080f20fcd2fb310e27d527ce0f6a36e3724/android/app/src/main/kotlin/com/openmausbot/companion/lifecycle/SessionLingerController.kt) 默认只保留 25 秒连接宽限，并明确系统可提前回收。另有可选 always-on 常驻前台服务。不能把这些源码事实说成关闭 App 后的可靠推送已经得到真机证明。

其 [companion 官方说明](https://github.com/milind-soni/OpenMausBot/blob/main/companion/README.md) 明确采用独立伴侣服务。手机连接 companion，companion 通过回环访问 harness。harness 继续只绑定本机。

companion 按请求方法和路径维护默认拒绝的白名单，不提供桌面网页，带 Origin 的浏览器请求也被拒绝。配对和长期设备凭据在该服务处理，电脑查看与控制是额外的逐设备授权。官方说明的配对凭证为高熵二维码加六位手输回退，有效两分钟，单次使用。这些是竞品文档事实，本轮没有运行竞品验证。

值得复用的是客户端、远程入口、Bot 引擎三者分工。omp-bot 已有 PairingService 和设备范围校验，实施时让受限入口调用现有服务，不再建另一份配对凭据库。

## 为什么不直接转发桌面网页

本地网页目前信任能导航到本机服务的用户。顶层网页导航会获得所有者会话 cookie，见 [src/server.mjs](../../src/server.mjs) 的 `serveStatic` 和 `principalOf`。

根代理对临时实例发出真实 HTTP 顶层导航，观察到 `200` 和所有者 cookie。随后同时携带该 cookie 与只授权一个 Bot 的设备 Bearer，`/api/state` 返回两个 Bot。原因是 `principalOf` 先接受所有者 cookie。这个行为适用于原有本机信任范围，但不能原样作为受限手机入口。

远程入口必须只服务设备 API，拒绝桌面静态页面、所有者 bootstrap、配置与管理接口。该入口不接受所有者 cookie 或进程级 Bearer，只接受设备 token，兑换入口除外。Host、Origin 和代理来源的处理必须显式配置，不能为了接手机放开现有所有检查，也不能信任任意来访者声明的转发头。

## 本机运行证据

根代理在系统临时目录建立独立 home，启动真实 `startServer({ port: 0 })`，使用两个临时 Bot。没有触碰用户运行实例，没有启动 OMP 或模型。检查结束后关闭实例并删除临时数据。以下为观测结果，不是旧报告转述。

| 场景 | 实际结果 | 对安卓的影响 |
|---|---|---|
| 桌面签发配对码，设备兑换 | HTTP 201、200 | 可复用现有一次性配对服务 |
| 同码再次兑换 | HTTP 410 | 一次性限制有效 |
| 设备读取状态 | HTTP 200，只含授权 Bot | Bot 范围过滤有效 |
| 设备读取 runs、approvals、events/history | 均 HTTP 200 | 任务、审批列表和事件恢复已有入口 |
| 设备读取 chat、attachments、artifacts、computer | 均 HTTP 403，`DEVICE_NO_ADMIN` | 这些用户功能还没有设备访问路径 |
| 设备建立 Bearer SSE | HTTP 200，收到授权事件及序号，未收到另一 Bot 事件 | 活跃应用可复用事件流与游标 |
| 桌面撤销设备 | HTTP 200，已有 SSE 关闭，后续状态请求 HTTP 401 | 撤销可立即生效 |
| 使用远程域名 Host 或 Origin | 均 HTTP 403 | 现有回环边界不能直接接远程域名 |
| 本地顶层网页导航 | HTTP 200，获得所有者 cookie | 远程设备入口不能转发该导航 |
| 所有者 cookie 与设备 Bearer 同时出现 | 状态返回两个 Bot | 远程入口必须避免凭据主体混用 |

事件检查使用真实服务和账本，但事件由探针主动发出。没有验证真实模型响应、真实审批回答、手机网络、附件传输或电脑接管。这些仍属于实施后的端到端验收。

检查 PATH 时找到 Node 和 Tailscale，未找到 java、adb、gradle。这仅说明命令不在当前 PATH，不能据此认定 SDK 或 Android Studio 未安装。`tailscale status --json` 没有取得可解析的 JSON，因此没有确认登录或私网状态。

## 客户端方案取舍

| 方案 | 本项目能复用什么 | 代价 | 建议 |
|---|---|---|---|
| Kotlin + Compose | 现有 HTTP API、任务状态、事件与权限模型 | 单独编写移动界面，配置 JDK、SDK 和 APK 构建 | 首选，只做安卓且需要完整系统交互 |
| Capacitor | 网页 DOM、样式、部分聊天与运行渲染 | 重做设备认证和 API 地址；SSE、下载、扫码、密钥需适配或原生桥 | 适合优先复用网页，但不能把包装 APK 当成功能完成 |
| Expo + React Native | API、状态与业务契约 | 当前 DOM 组件需重写，增加 React 和原生构建体系 | 日后明确做 iOS 时再评估 |
| 手机 PWA | 网页代码复用最多 | 同样要补远程认证；文件、系统交互、后台能力依赖浏览器 | 可作辅助入口，不作为此次原生安卓目标 |

Capacitor 官方确认其 Android runtime 可让 JavaScript 调用 Java 或 Kotlin，并由 Android Studio 管理，见 [Android 文档](https://capacitorjs.com/docs/android)。此表的项目适配成本是设计判断，没有构建性能或工期测量。

Experience First 原则影响了选型。优先完成手机派活、审批和领取成果的连续流程，因此不把桌面全部设置搬到小屏，也不把原样网页包装当作交付标准。

## 复用位置与必须补的契约

现有设备服务在 [src/pairing.mjs](../../src/pairing.mjs)。默认配对码有效期五分钟，权限为 `read`、`run`、`approve`，其中审批需单独授权。设备 token 在服务端以加盐摘要保存，可撤销，目标 Bot 由配对记录确定。

HTTP 主体、状态投影、事件过滤、运行与审批接口在 [src/server.mjs](../../src/server.mjs)。附件、成果与电脑功能经 [src/features.mjs](../../src/features.mjs) 统一接入。设备身份目前不能进入这些 owner 路由。网页 HTTP helper 与同源会话在 [web/workbench-core.js](../../web/workbench-core.js)，原生 `EventSource` 在 [web/app.js](../../web/app.js)，不能直接承担安卓 Bearer 认证。

实施时复用这些模块，逐项开放必要的设备行为，不复制第二套运行或审批逻辑。

1. 为授权 Bot 的聊天历史增加设备读取路径。私聊派活继续使用 `/api/runs`，停止和补充复用现有 cancel 与 steer。
2. 附件上传、预览和成果下载按资源归属检查 Bot 范围。手机只传资源 ID，服务端核对记录，不把用户传入的 `botId` 当归属证据。
3. 所有列表、单资源请求、事件重放都保持相同范围。对手机可见返回值检查本机路径、内部配置及第三方连接地址的必要性。
4. 如开放电脑预览与人工接管，应明确设备权限并复用现有暂停、归还及单目标控制规则，不能因为有普通 `run` 权限就自动授予远程桌面控制。
5. 群运行目前对设备明确禁止。需要手机群聊时，单独定义完整群范围和消息可见性，不能由“能看其中一个 Bot”推导“能看整群”。

## 配对与恢复的建议流程

电脑选择可操作 Bot，并单独选择审批权限，生成包含协议版本、可达 HTTPS 地址和一次性配对码的二维码。二维码不含桌面 owner token。当前系统已有配对码，但二维码格式属于待实现契约。

手机扫码后展示目标服务和权限，兑换设备凭证。使用 Android Keystore 管理加密密钥，把 token 加密后放在应用私有存储。Keystore 储存的是密钥，不是可以随意写入的 token 数据库，见 [官方 Keystore 文档](https://developer.android.com/privacy-and-security/keystore)。

前台通过带 Bearer 的 HTTP 与 SSE 连接。保存最后消费的事件序号，恢复时拉取当前快照并按游标补齐保留事件；保留窗口不足时明确重取状态，不能假装事件完整。遇到撤销后的 401，停止连接并回到重新配对流程。

网络切换期间保留输入草稿，不把未知结果的派活请求自动重发。若设计自动重试，先提供服务端幂等的请求标识，否则可能派发重复任务。这个边界属于连接体验需要，不建议在本轮研究提前增加通用重试系统。

## 安卓文件、通知与安装

文件由系统选择器交给 App，成果通过系统“另存为”保存，并支持系统分享。Android Storage Access Framework 支持用户选定文件和保存位置，见 [官方文件访问文档](https://developer.android.com/training/data-storage/shared/documents-files)。因此不需要把整块手机存储访问作为默认权限。

前台 SSE 与关闭 App 后的系统推送是两种机制。锁屏、Doze、进程回收和厂商策略会影响应用长连接。有 Google Play 服务可评估 FCM；非 GMS 手机可评估 UnifiedPush 或厂商推送，不能宣称只有一种安卓推送渠道。UnifiedPush 需要 distributor 和服务端 Web Push 库，见 [官方介绍](https://unifiedpush.org/developers/intro/)。具体取舍见 [平台证据](2026-10-13-android-platform-options.md)。不把前台服务永久保活作为默认通知实现。

推送只带必要的 Bot、run、approval 标识和短摘要。点击后重新向电脑读取当前状态，待审批通知可能已经过期，不能仅凭通知载荷直接批准。没有后台渠道时，在界面说明通知仅在连接期间有效。

Android 包可以作为签名 APK直接安装。所有 APK 都必须签名，同一应用后续升级需保持签名连续性，见 [官方签名文档](https://developer.android.com/studio/publish/app-signing)。开发使用 debug 签名，稳定交付使用保管好的 release 签名；上架与开发者账号另行决定，不是本轮研究的前提。

## 建议的实施顺序与验收

1. 完成设备 API 和隔离远程入口。在真实服务器证明 scope、撤销、Host、Origin、静态页隔离及资源归属后，再启用手机可达的私网入口。
2. 构建原生安卓客户端，完成配对、Bot 选择、历史、派活、流式进度、停止、补充和原生审批表单。
3. 完成资料上传、成果保存与分享，并按目标手机确定后台推送。需要查看电脑时纳入预览及人工控制契约。
4. 交付签名 APK和对应桌面包，在真机上验收 Wi-Fi 与移动网络切换、锁屏、后台恢复、任务重复风险、过期审批、断电或休眠、撤销和覆盖升级。

以上为首轮研究计划。后续按用户授权实施了原生客户端和设备入口，验收结果见下方「实施验收」。

## 首轮研究时的未测项

- 未运行 OpenMausBot 安卓应用，也未验证其下载包、扫码体验或推送稳定性。
- 未安装或运行 Android SDK、模拟器、真机客户端。
- 未启用 Tailscale Serve，未开放公网或修改网络认证。
- 未知目标安卓手机型号、系统版本及 Google Play 服务情况。实施后台推送前需要真机核对。
- 真机体验、二维码格式、远程入口配置、通知提供者和手机电脑接管权限尚未成为产品决策。

## 后附取证

- [安卓框架、推送与 Tailscale 平台证据](2026-10-13-android-platform-options.md)。
- [OpenMausBot 安卓源码与分发取证](2026-10-13-openmausbot-android.md)。

## 实施验收

已实现原生 Kotlin 与 Compose 客户端，直接复用 OpenMausBot 的扫码、SSE、Keystore 和后台连接代码，来源与许可同时进入 APK 的 `assets/licenses/`。模型和工作区继续由 Windows 服务持有，桌面管理服务保留回环绑定，手机使用默认关闭的独立设备入口。

| 检查 | 实际结果 |
|---|---|
| 原生构建与签名 | APK 包名 `org.ompbot.companion`，Android 8.0 以上，v2 与 v3 签名通过 |
| Kotlin 单测 | 105 项通过，0 失败、0 错误，包括读取连接恢复与写请求不重放 |
| Node 设备入口与 HTTP 边界 | 手机入口 112/112，HTTP 边界 83/83 |
| Node 功能、运行与关停 | 功能 53 项、运行 44/44、关停检查通过 |
| Android 15 模拟器配对 | 深链与手动输入均兑换真实邀请，只列出授权 Bot，冷启动恢复连接与历史 |
| 真实模型任务 | `opencode-go/deepseek-v4.1-flash` 返回 `OMPANDROID7319` |
| 附件到成果 | 58 字节附件含 A=21 与 B=34，手机回答真实 bash 审批，产出含标记与 55 的 `result.txt` |
| 手机文件保存 | 原生预览、系统保存与分享面板通过。保存 18 字节，SHA-256 与电脑不可变成果一致 |
| 补话与取消 | 同一 Run 记录 `run_steered`，手机停止后状态为 `cancelled` |
| 后台连接 | Android 15 的 connectedDevice 前台服务运行，后台任务通知含 `BACKGROUND7319`，模拟器重启后服务恢复 |
| 打包电脑端 | 实际 Electron 应用和交付的免安装 EXE 均运行；免安装 EXE 下载的 APK 为 33,467,713 字节，SHA-256 与独立 APK 一致，二维码与撤销界面通过 |
| 图片与撤销 | 系统图片选择器上传真实 PNG，电脑界面撤销后手机提示凭据失效 |
| 扫描界面 | 系统相机授权与 CameraX 预览通过，实体二维码识别未测试 |

实跑修复了审批选项无法首次选择、事件流并发关闭和文件选择器返回时 HTTP 客户端尚未恢复的问题。读取请求使用连接级恢复，HTTP 写操作失败不自动重发；断开已复用连接的回归与一次 POST 回归均通过，实际空闲后配对成功。系统保存完成提示在真实写入和关闭文件后才显示。

实体手机未连接 ADB，因此没有把摄像头扫码、实际手机的 Wi-Fi 与 Tailscale 路径、厂商后台策略或锁屏稳定性算作已验收。未启用公网发布或云推送。

