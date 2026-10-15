# OpenMausBot Android 伴侣应用研究（只读快照，2026-10-13）

## 0. 方法与快照

- 对象 `github.com/milind-soni/OpenMausBot`。main HEAD = `34cbd59bb46341839febcb5ed5b014b11be9e102`（2026-10-12T23:02Z，API `commits/main`）。
- **移动端源码不在 main 上**：`main` 树里 `android/` 与 `ios/` 均 404，只存在于 `android-release/*`、`ios-release/*` 分支与对应 tag。Android 快照取最新发布分支 `android-release/v1.5.0`（tag `android-v1.5.0`，commit `16ad4080f20fcd2fb310e27d527ce0f6a36e3724`，2026-09-27）。本文中 `[A]/<p>` = `https://github.com/milind-soni/OpenMausBot/blob/16ad4080f20fcd2fb310e27d527ce0f6a36e3724/android/<p>`；`[M]/<p>` = `https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/<p>`。
- 发布之后仍有 Android 提交落在特性分支（如 `fix/android-copy-guard-after-2296`，`09a9898`，2026-10-06），不在本次快照内。
- 取证方式为两个只读浅克隆（main 与 `android-release/v1.5.0`）加 GitHub API；未安装、未构建、未运行任何 Android 产物。标注：**【源】** 源码/清单可核；**【文档】** 仓库文档自述；**【商店】** 外部平台页面；**【推测】**；**【未测】**。

## 1. 应用形态与发行

- 原生 **Kotlin + Jetpack Compose**，`applicationId com.openmausbot.companion`，两个 Gradle 模块：`:core`（协议，README 自述由 `ios/Sources/CompanionCore` 移植）与 `:app`（Compose UI、Android 平台）。`minSdk 26`，`compileSdk/targetSdk 37`，`versionName 1.5.0`（`versionCode` 按 MAJOR*10000+MINOR*100+PATCH 派生 = 10500）。【源】[A]/README.md、[A]/app/build.gradle.kts:72,94-100、[A]/core/build.gradle.kts:19
- 无 React Native/Expo/Flutter/Capacitor；`android.webkit` 仅用于 `MimeTypeMap` 工具，无 WebView 界面。唯一内嵌浏览器路径是 Chrome Custom Tabs，用于云桌面 noVNC 查看器，注释明确拒绝 WebView 形态。【源】[A]/app/build.gradle.kts:243-256、[A]/app/src/main/kotlin/com/openmausbot/companion/browser/CloudDesktopBrowser.kt:5,16-19
- 发行：GitHub release `android-v1.5.0` 附 `OpenMausBot.apk` 与 `OpenMausBot-1.5.0.apk`（各 34,512,379 B，2026-09-27），历史 tag 自 `android-v1.0.0`（2026-09-01）起，含 2026-09-13 的 preview APK；`android-v1.4.0` 有分支无 release。仓库代码把 Android 下载指向 GitHub APK 而非商店。【源】[M]/src/lib/app-links.ts:30-32、release API
- 【商店】Google Play 存在同包名 `com.openmausbot.companion` 的 **MausBot** 页面：开发者显示 "Omkar Satpute"，主体 SUPAMAUS SOFTWARE PRIVATE LIMITED（Pune, India），更新 2026-10-10，100+ 下载，描述含语音/通话。仓库 `android/PlayStore/` 自称 "release preparation" 且 CHECKLIST 全为未勾选项，官网下载页则称手机端应用 "在 Discord 分享"。Play 列表与项目的关系为**【推测】**（仓库一手源未给出商店链接），其实际版本号**【未测】**。
- 签名：维护者离线 keystore，启用 v2+v3（无 v1，因 minSdk 26）；CI 只跑 Kotlin 单测与 debug/preview APK（无 release 签名）。`isMinifyEnabled=false` 是有意为之（66 个 `@Serializable` 类经反射找 serializer）。【源】[A]/README.md、[A]/app/build.gradle.kts:114-122,155-170、[A]/.github/workflows/ci.yml:455-498

## 2. 配对与凭据

- 二维码链接为 `openmausbot://pair?address=&token=omb_pair_<43字符>&code=<6位>&name=&hosts=&endpoints=`，解析见【源】[A]/core/src/main/kotlin/com/openmausbot/companion/core/Connection.kt:353-440：地址限 `http(s)://host[:port]`、禁凭据/路径/查询；`hosts` ≤8；`endpoints` 为 URL-safe base64 的 JSON（≤8 KB），kind ∈ hosted/tailnet/lan/bonjour，hosted 必须 `https`，tailnet 必须 `http` 且 `*.ts.net`（[A]/core/.../Endpoint.kt:20-160）。服务器模式链接为 `https://host/pair#code=<12符号>`。
- 链接由桌面/服务器侧统一构造（含 P-256 HPKE 的 `secretKey` 字段），**Android 端未实现该字段与 HPKE 凭据录入**（android 源码搜索 `secretKey`/`HPKE` 零命中；该能力见 docs/ios-companion.md 的 "Secure credential entry"）。【源】[M]/shared/pairing-link.ts、[A] 全树
- 配对请求：走伴侣 sidecar 时 `POST /api/pair`（`code` 6 位或 `credential` token，附 `deviceName`、`pairRequestId`）；多路由邀请用 `pairFirstReachable`：先并发 `GET /api/health` 探活（4 s），按广告顺序逐个 `POST /api/pair`（8 s 超时），≥500 或 429 之外才轮换，响应不可读时靠 `pairRequestId` 幂等重放。【源】[A]/core/.../Client.kt:1120-1230
- 走 headless 服务器时 `POST /api/auth/pair`（12 符号码，字符集 `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`），先读 `/.well-known/openmausbot/environment` 比对 `environmentId`，成功后记录 `session.scopes`。【源】[A]/core/.../Client.kt 同上、[A]/core/.../Session.kt:289-326
- 连接策略允许 HTTPS；明文 HTTP 仅在 `localhost`、`.local`、`.ts.net` 或环回、链路本地、私网字面 IP 等允许范围内使用，字面 IP 判断不做 DNS 解析。【源】[A]/core/.../ServerTransport.kt
- 凭据存储：设备 token 存 **EncryptedSharedPreferences**（MasterKey AES256_GCM；键名 AES256_SIV、值 AES256_GCM），键 `token.<connectionId>`，写入用 `commit()` 同步落盘，先存 token 后写可恢复的连接注册表；连接注册表（不含 token）存 DataStore Preferences，含单机到多机的迁移。备份规则在 Auto Backup / 设备迁移中排除 token 与权限、引导标记。【源】[A]/app/src/main/kotlin/com/openmausbot/companion/storage/KeystoreTokenStore.kt、[A]/.../DataStoreConnectionStore.kt、[A]/app/src/main/res/xml/backup_rules.xml、data_extraction_rules.xml
- 作用域：服务器配对返回的 `scopes`（服务端取值为 `admin`/`client`）只被 Android 存进 `Connection.serverScopes`，本次快照未发现客户端按 scope 做 UI 门控的读点，限制靠服务端返回 403。【源】[A]/core/.../Connection.kt:31、[A]/core/.../Session.kt:312、[M]/server/index.ts:18072-18073

## 3. 网络与传输

- 传输候选四类（hosted/tailnet/lan/bonjour），自动候选做 "credential-safe" 过滤：起点为受保护路由时不回落到本地路由；失败按 `CandidateRotation` 轮换端点，断流重连 1 s 起指数退避、封顶 15 s。【源】[A]/core/.../Endpoint.kt、[A]/core/.../Session.kt:840-886
- 客户端为 OkHttp：动作 20 s 超时；上传无总时限（只看空闲超时）；SSE 流 `callTimeout=0`、空闲读 90 s；探活 4 s、配对 8 s、头像生成 150 s、Claude 更新 200 s。所有认证请求带 `Authorization: Bearer`。【源】[A]/core/.../Client.kt:125-192,830-845,956-962
- 桌面对端（架构图，【文档】[M]/docs/ios-companion.md）：harness 仅 `127.0.0.1:8799`；伴侣 sidecar 设备面 `0.0.0.0:8810`（配对鉴权、默认拒绝的 allowlist、SSE 清洗）；控制面 `127.0.0.1:8811`（启动/取消配对、列设备、吊销）；托管隧道网关 `127.0.0.1:8812`（Cloudflare outbound connector，与 sidecar 世代绑定）。桌面 App 经 `electron/companion.mjs` 管理 sidecar 生命周期。
- 局域网发现：Android NSD 浏览 `_openmausbot._tcp`（API 33/34 解析差异处理），作为二维码之外的显式兜底。【源】[A]/app/src/main/kotlin/com/openmausbot/companion/discovery/NsdDiscovery.kt:414-532
- 桌面依赖：需电脑（macOS/Windows/Linux）运行 OpenMausBot，或 headless 服务器（`openmausbot serve`、`openmausbot pair --phone android` 出 app-scheme 二维码）；电脑需保持唤醒。伴侣 sidecar 独立运行仅存在于 git checkout，npm 包与 Docker 镜像不含它。【文档】[M]/docs/self-hosting.md:793-826、[M]/docs/cli-onboarding.md:38-52

## 4. 事件流、状态与功能面

- 单一 SSE：`GET /api/events?since=<cursor>&screens=on|off`，`Accept: text/event-stream`。帧类型：hello（cursor、resumed）、message、messagePatch、thread、bot、botDeleted、botQueued、room、roomDeleted、notify、screen（base64 PNG）、computer、config、runtime、unknown；未知帧安全降级，坏 JSON 只丢一帧。`resumed=false` 时先 `GET /api/bots?messages=50` 补水（hydrate）再提交 cursor；401 进入 Unauthorized 停止重试。【源】[A]/core/.../Sse.kt、[A]/core/.../Frames.kt:46-148、[A]/core/.../Session.kt:821-886
- 状态机：`Status = Unpaired|Connecting|Live|Unauthorized|Offline`；`RestoreState = Pending|Ready|Unpaired`；配对、切换电脑、登出、地址更新都在单一 `gate` 互斥下重排 client 与路由。【源】[A]/core/.../Session.kt:80-95,496-540,582-630
- API/状态流（`/api` 路径集的节选）：发消息（`/bots/:id/messages`、`/groups/:id/messages`）、编辑与队列取消（`/edit`、`/queue/:id`）、中断（`/interrupt`）、审批/问题回答（`/threads/:id/messages/:messageId/respond`）与窄授权 `always-allow`（服务端 pending key 校验）、任务 CRUD（`/tasks`）、routines（含 `/routines/:id/run`）、连接器（catalog/connected/authorize）、搜索/导出、附件上传（`/attachments`、`/files`）与下载、TTS（voices/prepare/speak）、模型与 profile、头像生成、`/instances/:id/claude-update`、`/companion/endpoints`（受权后刷新连接候选）。完整枚举见 [A]/core/.../Client.kt。
- 聊天/运行：发消息即起回合，支持队列（`QueuedSend`）、中断、编辑；`SendReceipt` 处理中途 steer。审批用 `OptionCard`，`answer` 可选 `always-allow`（仅当卡片带 pending allow key）。附件支持图片/文件上传、下载与预览、分享入站（`ShareReceiveActivity` 收 `text/*`、`image/*`、PDF、Office 等）。
- 计算机预览：`Frame.Screen` 为只读画面（有 watcher 时才开 `screens=on`）；只有 `computer == "cloud"` 且非 VPS 后端显示 "Open live cloud desktop" 按钮，`POST /api/bots/:id/computer/join` 取 URL 后交 Chrome Custom Tabs 打开；Local VM 与 "this Mac" 只给预览、无控制入口，Android 快照内无 Local VM 截图/租约控制端点。【源】[A]/app/src/main/kotlin/com/openmausbot/companion/ui/ComputerPolicy.kt:13-60、[A]/core/.../Client.kt:804-806

## 5. 通知与后台

- 通知只由活动 SSE 的 `notify` 帧触发的本地通知产生，**无 FCM/firebase 依赖**。【源】[A]/app/src/main/kotlin/com/openmausbot/companion/notifications/LocalNotificationPoster.kt:18
- 三个业务通道：`approval_question`（HIGH）、`bot_messages`（HIGH，接管旧 `done` 通道时保留用户自定义）、`routine_failed`（DEFAULT），加常驻 `always_on_status`（LOW）。去重 id 为 `openmaus.<threadId>.<seq>`；点击 PendingIntent 以 data 携带 botId+threadId 直达线程；角标只挂真实通知，无独立角标 API。【源】[A]/.../NotificationMapping.kt、[A]/.../LocalNotificationPoster.kt
- 后台存活：进程退到后台后有 **25 秒 linger**（用普通 started service 把进程锚出 cached 类，非前台服务），到期或锚被回收即断开。另有默认关闭的 "always on" 开关：前台服务 `connectedDevice` 常驻低优先通知、`START_STICKY`、开机广播恢复。被系统杀掉的进程无法靠推送唤醒。【源】[A]/app/src/main/kotlin/com/openmausbot/companion/lifecycle/SessionLingerController.kt:120,185、[A]/.../AlwaysOnConnectionService.kt:47,56、[A]/app/src/main/AndroidManifest.xml:16-19,207-223
- 文档口径：`docs/phone-web-app.md` 明说 PWA 无离线聊天、无推送、无原生手机控制；iOS 文档承认关闭态收不到通知。Android 的 always-on 是明确标价的例外（常驻通知 + 电耗）。

## 6. 许可

- 仓库根 `LICENSE` 为 Apache-2.0，例外只有 `enterprise/`（与 android/ 无关）；`NOTICE` 记录由 MIT 再许可及第三方（含桌面/服务器侧 HPKE 库）。android/ 源码无逐文件 SPDX/版权头（仅 `gradlew` 有）。
- 依赖许可（POM 核对）：OkHttp 4.12.0 = Apache-2.0；AndroidX/Compose/kotlinx/CameraX/DataStore/security-crypto 为 Apache-2.0 系；**ML Kit `barcode-scanning` 17.3.0 = "ML Kit Terms of Service"（非开源）**（仅用于二维码扫描，选型理由是不依赖 Play services）；`junit:junit:4.13.2` = EPL-1.0（仅测试）。

## 7. 明确 / 推测 / 未测

- **明确**（仓库一手源可核）：技术栈与模块、SDK/版本号与签名策略、二维码字段与配对端点和超时、明文 HTTP 允许集、token 存储与备份排除、SSE 帧与状态机、通知通道与无 FCM、25 s linger 与 always-on 前台服务、计算机预览的只读边界、依赖许可、发行产物与 CI 行为。
- **推测**：Google Play 的 MausBot 列表属项目官方渠道（开发者名与仓库链接不一致）；Play 页 2026-10-10 更新对应版本可能新于 `android-v1.5.0`；各 OEM 省电策略下的实际通知到达率。
- **未测**：本次未做真机、安装、构建或任何运行时验证。配对成功率、SSE 断线恢复、通知延迟/丢帧、电耗、Play 版本号与签名身份、iOS 端行为均未运行验证。

## 8. 可直接打开的关键来源

- [安卓发布快照 README](https://github.com/milind-soni/OpenMausBot/blob/16ad4080f20fcd2fb310e27d527ce0f6a36e3724/android/README.md)。模块、构建、安装与签名说明。
- [Android 1.5.0 官方发布](https://github.com/milind-soni/OpenMausBot/releases/tag/android-v1.5.0)。APK与发布提交。
- [伴侣服务说明](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/companion/README.md)。独立入口、路由白名单与设备授权。
- [后台连接宽限源码](https://github.com/milind-soni/OpenMausBot/blob/16ad4080f20fcd2fb310e27d527ce0f6a36e3724/android/app/src/main/kotlin/com/openmausbot/companion/lifecycle/SessionLingerController.kt)。25 秒窗口、断开与前台恢复。
- [设备凭据存储源码](https://github.com/milind-soni/OpenMausBot/blob/16ad4080f20fcd2fb310e27d527ce0f6a36e3724/android/app/src/main/kotlin/com/openmausbot/companion/storage/KeystoreTokenStore.kt)。Keystore 加密存储实现。
