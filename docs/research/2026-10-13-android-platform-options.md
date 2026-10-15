# 安卓伴侣客户端：平台、框架与网络约束（官方文档取证）

范围：为 omp-bot 安卓伴侣比较 Kotlin+Compose / Expo React Native / Capacitor / PWA-WebView，取证 Android 通知与后台执行、FCM 与自建推送、Tailscale Serve 私网 HTTPS，并给出取舍。方法：只读官方文档与官方源码；未安装 Android 工具链、未构建、未跑真机、未启用 Serve。标注：【明确】= 官方文档或官方源码可直接核对；【推测】= 依赖未实测前提的判断；【未测】= 本轮未验证。「root 实测」引自主代理的隔离运行证据，非本轮复现。

## 一、结论

1. 选 Kotlin + Jetpack Compose 原生，与主代理方向一致。Android 官方推荐 Compose。浏览器原生 `EventSource` 不能带自定义请求头，网页扫码需要安全上下文，网页脚本不能直接使用 Android Keystore。非 GMS 设备需要另外评估推送提供者，不能把 FCM 当成所有安卓设备的默认能力。【明确】+【推测】
2. 传输用 Tailscale Serve 私网 HTTPS 加只服务设备的入口，不启用 Funnel。Serve 只向同一 tailnet 内设备提供本机服务，且要求 tailnet 开启 HTTPS 证书。【明确】
3. GMS 情况未知，建议核心流程不依赖 GMS。扫码可选不依赖 Google 服务的条码库。Android App Links 由系统查询网站的 `assetlinks.json` 完成验证，官方未把 Google Play 服务列为统一前提。私网域名的验证仍需真机检查，也可在 App 内扫码直接配对。【明确】+【推测】
4. 本地构建和签名 APK 不强制使用付费云构建。Capacitor Preferences 不加密，Ionic Secure Storage 是一种付费选择，也可用自有原生 Keystore 实现；不能由此推导整个 Capacitor 生态只有付费安全存储。【明确】+【推测】

## 二、四类客户端逐项对比

| 能力 | Kotlin + Compose | Expo RN | Capacitor | PWA / WebView |
|---|---|---|---|---|
| 二维码配对 | 系统相机 + 条码库直接解码 | `expo-camera` 的 `CameraView` 内置条码识别 | 官方 `@capacitor/barcode-scanner`，minSdk 26，可选 ZXING 或 MLKIT | 需摄像头 API，必须安全上下文 |
| token 安全存储 | Keystore 密钥不可导出、可绑 TEE/StrongBox，密文放应用私有目录 | `expo-secure-store`：SharedPreferences + Android Keystore 加密；卸载即丢 | 核心 `@capacitor/preferences` 只是 SharedPreferences，不提供加密，官方把加密存储指向订阅制 Ionic Secure Storage | 网页只能用 localStorage/IndexedDB |
| 带 Bearer 的 SSE | 流式 HTTP 可直接带 `Authorization` | RN 网络层只有 fetch/XHR/WebSocket，无 EventSource；官方把 fetch 的 cookie 认证列为不稳定 | WebView 的 EventSource 同样不能带头；fetch 跨源要 CORS，而服务端明确不开 CORS | 同左 |
| 键盘/返回/安全区 | targetSdk 35 在 Android 15+ 强制 edge-to-edge，用 WindowInsetsCompat 处理系统栏、挖孔与 IME；返回用 `BackHandler` 拦截 | 【未测】 | Keyboard 插件 `resize` 只在 iOS 生效，Android 需 `resizeOnFullScreen` 变通；SystemBars 插件注入 `--safe-area-inset-*` | 同 WebView |
| 附件与成果 | SAF 选文件/另存为，无需存储权限 | 走 Expo SDK 的文件与分享模块（本轮只取证了 camera/notifications/securestore） | 官方 Filesystem/Share/File Transfer/File Viewer 插件；WebView 内选择与下载需桥接 | 依赖浏览器能力，保存位置受限 |
| 通知与深链 | 原生通知 + intent-filter 深链 | Android 远程推送自 SDK 53 起需 development build，测试设备需 Google Play services | 官方 push 插件走 FCM SDK，需 google-services.json；进程被杀时 data-only 消息不回调 | WebView 的通知需宿主实现；PWA Web Push 依赖浏览器推送服务 |
| Windows 构建与签名 | Android Studio 出包；debug 证书自动生成在用户目录 `.android\` | 官方文档给 Windows 的 `keytool` 步骤（JDK bin、管理员）与 Gradle signingConfig，产物默认 AAB | CLI `buildOptions` 可配 keystorePath/alias/releaseType(AAB\|APK)/signingType | 无构建环节 |

补充事实。全部 APK 安装前必须签名，Play App Signing 只在上架路径需要，旁加载只需自有 release 签名（[签名](https://developer.android.com/studio/publish/app-signing)、[RN 发布](https://reactnative.dev/docs/signed-apk-android)）。expo 本地编译可用 `npx expo run:android`，但 release 产物未签名（[本地构建](https://docs.expo.dev/guides/local-app-development)）。Capacitor 的 Android 支持面是 API 24+ 与 Chrome 60+ 的 WebView，Android 10+ 用系统 WebView；官方建议 `server.hostname` 保持 `localhost`，因为它是安全上下文，`getUserMedia` 这类 API 才可用（[Android](https://capacitorjs.com/docs/android)、[config](https://capacitorjs.com/docs/config)）。

配对侧现状（读源码）：配对码是 `ompcode_` 加 32 字符 base64url，可直接放进二维码；`POST /api/pairing/redeem` 未认证、按 `socket.remoteAddress` 限流（`src/pairing.mjs`、`src/server.mjs`）。SSE 接口接受设备 Bearer，root 实测原生 Bearer SSE 收到带 seq 的事件且范围过滤生效。

## 三、通知与后台：活跃流不等于关闭态推送

- 【明确】Android 13+ 的通知是运行时权限 `POST_NOTIFICATIONS`，新装默认关闭；用户拒绝后前台服务通知只进任务管理器；用户可从任务管理器停掉前台服务（[通知权限](https://developer.android.com/develop/ui/views/notifications/notification-permission)）。
- 【明确】Doze 挂起网络、忽略 wake lock、推迟闹钟；官方明确建议需要实时消息就用 FCM，而不是自建持久连接（[Doze](https://developer.android.com/training/monitoring-device-state/doze-standby)）。
- 【明确】Android 12+ 后台启动前台服务受限，例外含收到 FCM 高优先级消息、用户关闭该应用电池优化、持有 `SYSTEM_ALERT_WINDOW`（Android 15 起还需有可见悬浮窗）（[后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)）。
- 【明确】Android 14+ 每个前台服务必须声明类型与对应权限；Android 15 起 targetSdk 35 的 `dataSync` 前台服务每 24 小时累计只能跑 6 小时，超时回调 `onTimeout`，不 `stopSelf` 会抛异常；`BOOT_COMPLETED` 不能启动 `dataSync` 等类型（[FGS 类型](https://developer.android.com/develop/background-work/services/fgs/service-types)、[Android 15 变更](https://developer.android.com/about/versions/15/behavior-changes-15)）。
- 【明确】FCM 客户端要求设备装有 Google Play 商店；Capacitor 与 expo 的 Android 推送都绑 FCM 及其凭据（[FCM](https://firebase.google.com/docs/cloud-messaging/android/get-started)、[expo push](https://docs.expo.dev/push-notifications/push-notifications-setup)）。

结论是活跃连接不等于 App 进程未运行时的推送。FCM 是已取证的一种推送路径，UnifiedPush 能经独立 distributor 唤起目标应用。不同提供者及厂商系统的可达性、保活和强制停止行为需实测，不能宣称安卓推送只有 FCM，也不能承诺用户强制停止后仍可收到消息。

自建推送：【明确】UnifiedPush 需要安装 distributor、应用集成 connector、服务端集成 Web Push 库。distributor 与推送服务器保持连接，再转交给目标 App，其实现不由 UnifiedPush 协议统一规定，见 [官方介绍](https://unifiedpush.org/developers/intro/)。可自托管 ntfy、NextPush、Sunup。ntfy 的 instant delivery 使用带常驻通知的前台服务，关闭后可能延迟；其 F-Droid 版不使用 Firebase，见 [ntfy 安卓说明](https://docs.ntfy.sh/subscribe/phone/)。【未测】本轮没有验证 distributor 的具体前台服务类型、Android 15 限制和厂商电池策略，也没有普查厂商推送。

## 四、Tailscale Serve 私网 HTTPS

- 【明确】Serve 把本机服务只提供给 tailnet 内设备；需启用 HTTPS 证书（在 tailnet DNS 上签发）与 MagicDNS；DNS 名限定在 tailnet 域；反代目标只支持 `http://127.0.0.1`；会注入 `Tailscale-User-Login` 等身份头（Funnel 不注入）；访问控制照常生效；不加 `-bg` 时重启后需手动恢复（[Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)）。
- 【明确·源码】反代保留原始 Host（`r.Out.Host = r.In.Host`），并加 `X-Forwarded-Host/Proto/For`；后端看到 `机器名.tailnet.ts.net`，拨号来自回环（[serve.go](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go#L992)，该文件最后修改于 2026-09-25 的 `3d62394`）。
- 【明确·root 实测】现有 server 对 `Host`/`Origin` 为 `research.example.ts.net` 一律 403：`hostOk` 只接受回环或显式绑定名且端口必须相同，`originOk` 要求同源同端口。HTTPS:443 反代到 3099 在现有检查下不可用，且不应为此放宽检查。
- 【明确·root 实测】对临时实例发顶层 HTTP 导航即可拿到 owner 会话 cookie；设备 Bearer 与 owner cookie 同时存在时按 cookie 判定，返回两个 Bot。远端入口必须排除桌面静态页、bootstrap、owner cookie 与 owner 凭据，只收设备 token，与主代理方向一致。
- 【明确】Funnel 是公网暴露且需要节点属性，同一端口不能同时 Serve 与 Funnel，不启用（[Funnel](https://tailscale.com/docs/features/tailscale-funnel)）。手机侧要安装 Tailscale 并登录，支持 Android 8+（[安卓安装](https://tailscale.com/docs/install/android)）。
- 【推测】主机休眠或关机时不可达：Serve 在主机上运行，官方未给休眠可达性说明，传输层本身也不产生推送、不唤醒主机。

## 五、建议与取舍

首选 Kotlin + Compose。token 用 Keystore 密钥加密后存应用私有目录，认证使用设备 Bearer，复用配对与撤销。SSE 使用带认证头的流式 HTTP，附件与成果使用 SAF。前台流程必须完整，后台推送作为单独交付项目按目标机型选择。有 GMS 可评估 FCM，非 GMS 可评估 UnifiedPush 和厂商推送，不在未验证时指定唯一渠道。UnifiedPush 服务端应复用现有 Web Push 库，不自行实现加密协议。PWA、Capacitor 和 Expo 的取舍依据上表，均未经过本机构建与真机比较。【推测】

## 六、来源

| 事实组 | 来源 |
|---|---|
| Android：通知权限、Doze、FGS 类型与后台启动限制、Android 15 时限、edge-to-edge、返回、SAF、App Links、Keystore、APK 签名、WebViewAssetLoader | Android Developers（`notification-permission`、`doze-standby`、`fgs/service-types`、`fgs/restrictions-bg-start`、`about/versions/15/behavior-changes-15`、`ui/views/layout/edge-to-edge`、`guide/navigation/custom-back`、`training/data-storage/shared/documents-files`、`training/app-links`、`privacy-and-security/keystore`、`studio/publish/app-signing`、`reference/androidx/webkit/WebViewAssetLoader`） |
| SSE 不能带自定义头 | [WHATWG HTML 规范](https://html.spec.whatwg.org/multipage/server-sent-events.html) |
| App Links 自动验证 | [Android 系统域名验证流程](https://developer.android.com/training/app-links/verify-applinks) |
| UnifiedPush 角色与库 | [官方介绍](https://unifiedpush.org/developers/intro/) |
| Expo | `docs.expo.dev/versions/latest/sdk/{securestore,camera,notifications}`、`push-notifications/push-notifications-setup`、`guides/local-app-development` |
| RN | `reactnative.dev/docs/network`、`docs/signed-apk-android` |
| Capacitor 与 Ionic | `capacitorjs.com/docs/{android,config,apis,apis/push-notifications,apis/preferences,apis/barcode-scanner,apis/keyboard,apis/app}`、`ionic.io/docs/secure-storage` |
| FCM | `firebase.google.com/docs/cloud-messaging/android/get-started` |
| UnifiedPush 与 ntfy | `unifiedpush.org/users/distributors`、`unifiedpush.org/developers/implementations`、`docs.ntfy.sh/subscribe/phone` |
| Tailscale | `tailscale.com/docs/{features/tailscale-serve,reference/tailscale-cli/serve,features/tailscale-funnel,how-to/set-up-https-certificates,install/android}`、`github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go` |

## 七、未测与不确定

- 【未测】全部 Android 运行时行为：未装 SDK、未构建 APK、未跑真机或模拟器；键盘避让、后台回收、推送到达、断连重连均未实测。
- 【未测】GMS 可用性未知，未确认目标机型与系统版本；App Links 自动验证在私网域名上的实际行为未验证；tailnet 未登录核对，Serve 未启用，Serve 的 Host 保留与身份头只在源码层面确认。
- 【推测】经 Serve 反代后 `socket.remoteAddress` 变为回环会让兑换限流退化成共享桶，此为读码推断；RN 与 Capacitor 的 SSE 替代路径（第三方 polyfill、native HTTP 插件对流式响应的支持）也未取证，不能假定可用。
- 【未测】PWA Web Push 在 Android 上依赖系统推送服务的直接官方原句未取到；本轮只确认 FCM 的设备前提与 ntfy 对 Android 推送现状的描述。
