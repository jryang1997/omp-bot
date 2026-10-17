# OMP Bot Android 伴侣应用

手机端的 OMP Bot：跟电脑上运行的 OMP Bot 设备入口配对，然后在手机上派活、看进度、
回答原生审批、上传资料、取回成果。

- 包名 `org.ompbot.companion`，应用名 **OMP Bot**
- `minSdk` 26（Android 8.0）、`compileSdk` / `targetSdk` 36
- 深链 scheme：`ompbot://pair?v=1&address=…&code=…`
- 两个模块：`:core`（协议与会话：HTTP/SSE/状态归约，纯 Kotlin）与 `:app`（Compose 界面与 Android 平台）

## 它做什么、不做什么

手机只跟电脑上的设备入口说话，电脑仍是唯一持有模型、任务执行、工作区与成果的一方。

- 做：配对与记住连接、只看被授权的 Bot、私聊历史、派活、流式进度、停止、补充指令
  （`steer` / `follow_up`）、原生审批（选项/确认/输入/多问题表单）、上传文档与图片、
  下载成果到手机或在系统里分享、可选的常驻连接与本地通知。
- 不做：不做第二个模型循环，不转发桌面网页，不代理所有者凭证，不发起群运行
  （设备目前没有群运行权限），不假装有离线推送。

## 构建

需要 JDK 17 与 Android SDK 36（`build-tools;36.0.0`）。Gradle 由 wrapper 提供。

```sh
npm run build:android
```

`assembleRelease` 在没有签名材料时产出**未签名** APK：

```
app/build/outputs/apk/release/app-release-unsigned.apk
```

仓库根的 `scripts/build-android.mjs` 使用用户缓存中的 keystore 对 APK 签名，校验包名与签名，并输出 `release/omp-bot-android.apk` 和 SHA-256 清单。已配置 Gradle 签名时，直接使用其签名产物。

要让 Gradle 自己签名，把材料放在仓库外，再通过环境变量 `OMPBOT_KEYSTORE_FILE`、`OMPBOT_KEYSTORE_PASSWORD`、`OMPBOT_KEYSTORE_ALIAS` 和可选的 `OMPBOT_KEYSTORE_KEY_PASSWORD` 引用。也支持已忽略的 `android/keystore.properties`。三项齐全才生效，缺一项直接失败。

## 与其他部分的关系

- 桌面侧：`/api/mobile` 控制设备入口，`/api/mobile/invitation` 生成二维码与配对码。
- 设备入口：默认 `0.0.0.0:3100`，只发布设备 API，公开 `/api/health` 与 APK 下载。
- 连接步骤见[使用指南](../docs/guide.md#安卓手机)。

## 目录

```
android/
├── core/    协议与会话：Api / SSE / 事件归约 / 原生帧解析 / 审批载荷 / 附件校验（纯 JVM，可单测）
├── app/     Compose 界面、二维码扫描、Keystore 存储、后台连接与通知、SAF/FileProvider
├── NOTICE   上游与第三方归属
└── PROVENANCE.md  哪些文件来自 OpenMausBot、哪些是改写
```

## 归属

界面原语、扫描器、Keystore 存储、SSE 解析与后台连接宽限的结构来自 OpenMausBot 的
Android 伴侣应用（Apache-2.0）。详见 [`PROVENANCE.md`](PROVENANCE.md) 与 [`NOTICE`](NOTICE)。
