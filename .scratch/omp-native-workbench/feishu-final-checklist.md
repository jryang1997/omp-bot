# 飞书最后闭环清单

用户已授权并完成真实账号接入。专用 OMP Bot 已发布，仅所有者可用；本机正式数据目录保存长连接配置及本人私聊白名单，不需要公网回调。

## 两条接入路径

工作台「飞书渠道」先选接入方式，两条路径共用同一套身份白名单、入站落库、去重、原生审批回答和投递记录。

- **官方长连接（界面默认）**：只填 App ID 与 App Secret。由飞书官方 SDK 在本机主动连出长连接，不需要公网域名、回调 URL、Verification Token、Encrypt Key 或回调端口，本服务也不建隧道。
- **本地回调 HTTP**：保留 App ID、App Secret、Verification Token、Encrypt Key 和固定回调端口，需要自备 HTTPS 入口。旧配置没有 transport 字段时按这条路径继续读。

## 回到电脑后需要提供的内容

1. 在飞书开放平台选择或创建测试机器人应用（本机已建 OMP Bot，App ID `cli_example_app_id`），启用机器人能力。不要把应用秘密贴进聊天。
2. 工作台进入「飞书渠道」，选「官方长连接」，只填 App ID 与 App Secret。秘密保存在本机配置；空白秘密字段保留旧值。
3. 在应用控制台订阅 `im.message.receive_v1`，开通 `im:message.p2p_msg:readonly` 和 `im:message:send_as_bot`。本次已实际配置并收到消息。
4. 发布版本并限制可用范围。本次为 1.0.0、仅所有者、不允许对外共享。长连接建立成功不等于事件权限和可用范围已经生效，仍须验证实际入站。
5. 指定一个测试用户和测试会话，填写 openId、chatId、botIds、permissions。界面显示当前 Bot 名称与 id。默认只授予 read/run，只有需要测试审批时才显式加入 approve；名单之外的发送者一律拒绝。可以先保存、后补身份。
6. 保存后点「启用」，状态的接入方式和连接状态显示真实长连接；应用缺少 App ID/App Secret 时后端错误原样显示。先运行自检：静态自检只查配置，显式勾选 live 才访问鉴权端点，不发业务消息。
7. 指定允许发送测试消息的会话后，交给主代理验证 `/run`、回复、`/cancel` 和 select/confirm 审批闭环。原生 ask/input 不通过 IM 猜答案，仍在网页回答。

### 改用本地回调 HTTP 时

1. 接入方式选「本地回调 HTTP」，填 Verification Token、Encrypt Key 和固定回调端口。
2. 用你授权的公网 HTTPS 入口把飞书事件路径 `/api/channels/feishu/events` 转发到该端口。只转发这个独立接收器，不转发 localhost 管理 API。服务不自动创建隧道。
3. 在应用控制台填写事件回调 URL 并订阅消息接收事件。控制台 URL 校验和真实事件形状尚未验收，以届时官方控制台为准。

身份映射示例只说明字段，实际值由控制台与界面提供。

```json
[
  {
    "openId": "你的测试用户 open_id",
    "chatId": "你的测试会话 chat_id",
    "botIds": ["界面列出的 Bot id"],
    "permissions": ["read", "run"]
  }
]
```

## 已经自动验收的部分

- 实际浏览器填写配置、保存、公开状态读回、秘密输入清空通过；不自动启用渠道。
- 公开状态不含 App Secret、Verification Token 或 Encrypt Key 的内容。
- Channels 34/34，覆盖 HTTP 签名、真实本地 receiver、长连接状态与关闭、落库失败不确认、按 message_id 去重、审批通知身份范围、未完成请求关闭、旧去重记录迁移及秒单位签名时间戳。
- 配对设备具备 read/run/approve 分档，撤销后的旧凭证和 SSE 失效。远端网络入口尚未启用，不把本地配对等同于手机已经连接。

## 不需要现在处理的内容

本机私有模型目录已实跑，不需要你配置认证代理来证明这个路径。OpenCode Flash max 双 Bot 私有记忆、重启新会话召回隔离、编辑和清理通过。本地原生浏览器人工输入、持久暂停恢复、归还后继续通过，不依赖飞书账号。签名证书、公网主机与手机入口不由本清单自动开通；官方长连接路径本身也不需要公网入口。

实际打包 EXE 已连上飞书，本人私聊 Run `run_mv5w1j0i_4e78ea9a` 完成并发出 `FEISHU_REAL_OK_6428`。Run `run_mv5wauad_6c625751` 的原生审批 `ui_mv5wawvi_1` 由真实飞书命令回答为 Approve，测试文件字节准确，批准与结果回执均有官方 message_id。自动取消验收使用本地签名 HTTP 入站、真实 OMP 和官方飞书出站，终态 cancelled、测试文件未创建、4 条回执确认投递。Runs 43/43、Channels 34/34 与 Shutdown 通过。真实平台入站取消尚未验收，无需用户继续执行测试命令。
