# 来源与改写说明

本目录（`android/`）是 omp_bot 自己的 Android 伴侣应用。它**直接复用**了 OpenMausBot
的 Android 实现中的若干文件，并按 Apache-2.0 的要求保留归属。

- 上游项目：`github.com/milind-soni/OpenMausBot`
- 上游分支/标签：`android-release/v1.5.0`（tag `android-v1.5.0`）
- 上游提交：`16ad4080f20fcd2fb310e27d527ce0f6a36e3724`（2026-09-27）
- 上游许可：Apache-2.0（见 [`LICENSE-APACHE-2.0.txt`](LICENSE-APACHE-2.0.txt)）
- 上游 NOTICE：见 [`NOTICE`](NOTICE)

只读校验用的上游检出留在本机临时目录，没有改动，也不随本仓库分发。

## 逐文件对照

“同源”= 结构、控制流与关键注释都在，只改了包名、类型名与对接的协议；“改写”= 借用了
取舍与写法，代码主体为新写。

| 本仓库文件 | 上游文件 | 关系 |
|---|---|---|
| `core/.../core/Sse.kt` | `core/.../core/Sse.kt` | 同源：`SSEParser` 的面向行语义与“坏帧只丢一帧”的流实现 |
| `core/.../core/Connection.kt`（在 `PairingLink.kt` / `Storage.kt` 中） | `core/.../core/Connection.kt` | 改写：沿用地址解析的严格规则（无凭据/路径/查询、`hosts` 上限、名称清洗）与连接记录形状，换成 omp_bot 的 `ompbot://` 邀请与一次性 `ompcode_` 码 |
| `core/.../core/ServerTransport.kt`（在 `PairingLink.kt` 中） | `core/.../core/ServerTransport.kt` | 同源规则：HTTPS 或本机/`.local`/`.ts.net`/环回/链路本地/私网字面量才允许明文，且不为判定做 DNS 解析；另加 Tailscale CGNAT `100.64/10` |
| `core/.../core/Models.kt` 的状态机标签 | `core/.../core/Connection.kt` 的 `Status` | 改写：`Unpaired/Connecting/Live/Unauthorized/Offline` 五态照搬语义，落到 omp_bot 的 `ConnectionStatus` |
| `core/.../core/CompanionState.kt` | `core/.../core/Store.kt` / `Session.kt` | 改写：保留事件归约与重复丢弃，游标按实际消费的授权事件推进；裁剪后补历史或重新读取任务与成果，形状使用 omp_bot 的 `RuntimeEvent` |
| `core/.../core/Frames.kt` 的 `NativeFrames` | 桌面 `web/workbench-native.js` 的 `parseNativeFrame`（同一上游仓库的另一个端） | 移植：键优先级、工具帧子任务（`partialResult/result.details.progress|jobs`）、todo/goal 规则逐条对应 |
| `app/.../storage/KeystoreTokenStore.kt` | `app/.../storage/KeystoreTokenStore.kt` | 同源：EncryptedSharedPreferences + AES256 MasterKey、`commit()` 同步落盘、写失败语义与取消不吞 |
| `app/.../lifecycle/SessionLingerController.kt` | `app/.../lifecycle/SessionLingerController.kt` | 同源：25 秒宽限、token 代号、`onAnchorLost`、前台/常驻连接的互斥处理与注释里的取舍 |
| `app/.../lifecycle/SessionLingerService.kt` | `app/.../lifecycle/SessionLingerService.kt` | 同源：普通 started service 作进程锚、`START_NOT_STICKY`、进程静态 watcher |
| `app/.../lifecycle/ServiceProcessAnchor.kt` | `app/.../lifecycle/ServiceProcessAnchor.kt` | 同源：`startService` 被拒视为“没有窗口” |
| `app/.../lifecycle/AlwaysOnConnectionService.kt` | `app/.../lifecycle/AlwaysOnConnectionService.kt` | 同源：前台服务、`connectedDevice`、常驻低优先通知、`START_STICKY` 与宽限窗口；新增系统拒绝启动时的错误反馈 |
| `app/.../lifecycle/AlwaysOnBootReceiver.kt` | `app/.../lifecycle/AlwaysOnBootReceiver.kt` | 同源：开机按用户开关恢复 |
| `app/.../lifecycle/AlwaysOnConnectionState.kt` | 同名文件 | 同源，新增启动失败的观察流 |
| `app/.../notifications/NotificationPolicy.kt` | `notifications/NotificationMapping.kt` + `NotificationText.kt` | 改写：通道划分与去重 id 的思路保留，通知集合按 omp_bot 的事件（审批、运行结束/失败、凭证撤销）重写 |
| `app/.../notifications/NotificationIntents.kt` | 同名文件 | 同源：PendingIntent 相等性只看 `filterEquals`，所以身份放进 data URI 而不是 extras |
| `app/.../notifications/LocalNotificationPoster.kt` | 同名文件 | 改写：通道与权限检查保留，通知内容按本项目的短摘要与脱敏重写 |
| `app/.../ui/QrScannerScreen.kt` | `ui/QrScannerScreen.kt` | 同源：CameraX 取帧 + ML Kit 内置模型、`CameraLifecycle` 的“先注册再绑定”、单帧锁载荷与重试延迟、扫描器从不自行配对 |
| `app/.../ui/Chrome.kt` / `CompanionTheme.kt` | `ui/Chrome.kt` / `CompanionTheme.kt` / `Haptics.kt` | 改写：顶部栏/空态/状态药丸等原语的写法与信息层级借鉴，颜色与文案换成 OMP Bot |
| `app/.../AndroidManifest.xml` | 同名文件 | 改写：权限集合、深链 trampoline（`persistNever`/`noHistory`/空 affinity/taskAffinity）、两个服务与 boot receiver、FileProvider 的取舍与注释沿用 |
| `android/gradle/wrapper/*`、`gradlew`、`gradlew.bat` | 同名文件 | 原样：Gradle wrapper（distributionUrl 指到本项目选用的 Gradle 版本） |
| `android/LICENSE-APACHE-2.0.txt`、`android/NOTICE` | `LICENSE`、`NOTICE` | 原样：上游许可与归属声明 |

## 没有带过来的东西

上游是一个完整产品客户端，这里只留 omp_bot 真的有的功能，未引入：通话与语音备忘录、
语音输入、NSD/mDNS 发现、浏览器（Chrome Custom Tabs）云桌面、例行任务（routines）、
任务清单与文件分区、连接器（catalog/授权）、头像生成、Claude 更新卡、模型目录、
`openmausbot://` 协议、`/api/pair`、HPKE 凭据录入、伴侣 sidecar 路由与它的端点多路由。

## 依赖许可

- Kotlin / kotlinx（Apache-2.0）、OkHttp（Apache-2.0）、AndroidX（Apache-2.0）
  —— 传输、协程、Compose、DataStore、security-crypto、CameraX。
- **ML Kit `barcode-scanning`（ML Kit Terms of Service，非开源）**：只用于扫配对二维码。
  选它是因为配对常发生在没有 Google Play services 的手机上，内置模型不需要临时下载。
- 测试：JUnit 4（EPL-1.0）、`mockwebserver`（Apache-2.0）。
