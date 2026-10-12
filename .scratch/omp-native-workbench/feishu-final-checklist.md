# 飞书最后闭环清单

用户已明确延后真实飞书账号接入。F/G 和本地设备、回调检查继续执行，不等待本清单。

## 回到电脑后需要提供的内容

1. 在飞书开放平台选择或创建一个测试机器人应用，启用机器人能力。不要把应用秘密贴进聊天。
2. 打开 omp-bot 的工作台，进入「飞书渠道」，在本机表单填 App ID、App Secret、Verification Token、Encrypt Key 和一个固定回调端口。秘密保存在本机配置；空白秘密字段保留旧值。
3. 指定一个测试用户和测试会话，填写 openId、chatId、botIds、permissions。界面显示当前 Bot 名称与 id。默认只授予 read/run，只有需要测试审批时才显式加入 approve。
4. 用你授权的公网 HTTPS 入口转发飞书事件路径 `/api/channels/feishu/events` 到固定回调端口。只转发这个独立接收器，不转发 localhost 管理 API。服务不自动创建隧道。
5. 在飞书应用控制台填写事件回调 URL，订阅消息接收事件并配置相应消息读取/机器人回复权限。控制台 URL 校验和真实事件形状尚未验收，以届时官方控制台为准。
6. 在工作台保存、启用渠道，先运行自检。静态自检检查配置；显式勾选 live 后才访问飞书鉴权端点，不会发送业务消息。
7. 指定允许发送测试消息的会话后，交给主代理验证 `/run`、回复、`/cancel` 和 select/confirm 审批闭环。原生 ask/input 不通过 IM 猜答案，仍在网页回答。

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
- Channels 25/25，包含加密与签名、重复事件、入站写失败、重启中断、scope 与审批载荷、真实本地 HTTP receiver。
- 配对设备具备 read/run/approve 分档，撤销后的旧凭证和 SSE 失效。远端网络入口尚未启用，不把本地配对等同于手机已经连接。

## 不需要现在处理的内容

本机私有模型目录已实跑，不需要你配置认证代理来证明这个路径。OpenCode Flash max 双 Bot 私有记忆、重启新会话召回隔离、编辑和清理通过。本地原生浏览器人工输入、持久暂停恢复、归还后继续通过，不依赖飞书账号。签名证书、公网主机与手机入口不由本清单自动开通。

证据见 `.scratch/omp-native-workbench/feishu-setup-proof.json`、`keyless-private-proof.json`。真实账号测试会在用户回到电脑并指定测试会话后执行。
