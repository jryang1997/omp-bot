<div align="center">

<img src="web/assets/app-icon.svg" alt="omp-bot" width="128" height="128">

# omp-bot

**一支住在你电脑上的 AI 助手团队。**

给每个助手起名字、捏个脸、分好工，私聊派活，或者拉进群里一起商量。

[使用指南](docs/guide.md) · [开发文档](docs/development.md) · [变更记录](CHANGELOG.md)

</div>

![omp-bot 工作台](docs/images/screenshot.png)

## 能做什么

- **一支团队，不是一个聊天框**：建几个助手，各有名字、头像和擅长的事。主助手负责协调。
- **私聊和群聊**：私聊直接派活；群里大家轮流发言，可以 @ 某个助手，主助手能替大家汇总。
- **助手之间互相派活**：一个助手可以把活交给另一个，做完交回来验收，整件事共用一份 token 预算。
- **一台共享电脑**：所有助手共用一台 Linux 虚拟机，每个助手一个独立座席，能开浏览器、跑命令、装软件。你随时可以看画面、接管鼠标键盘。
- **团队目录**：大家共用的规矩、技能库和共享文件夹，每个助手自己的身份和文件，都在一个 git 仓库里，改动有历史。
- **手机和飞书**：安卓 App 扫码配对后能在手机上派活、看回复、回答审批；也能接飞书。
- **权限三档**：只聊天、本机改东西先问我、全部放手。密钥和登录凭据所在的目录无论哪档都碰不到。

模型由 [omp](https://omp.sh)（oh-my-pi）驱动，用你自己在 omp 里配好的模型和登录。

## 支持的系统

| 系统 | 状态 |
|---|---|
| Windows x64 | 正式支持，有安装版和便携版。共享电脑需要开启 Windows Hypervisor Platform |
| Android 8.0 以上 | 伴侣 App，连接电脑上的 omp-bot 使用，不能单独跑 |
| macOS / Linux | 暂不支持。核心可能能从源码跑起来，但没验证过，没有安装包，共享电脑用不了 |

## 安装

**Windows**：在 `release/` 里任选一个。

- 安装版 `omp-bot-<版本>-setup.exe`：安装后从桌面或开始菜单打开。
- 便携版 `omp-bot-<版本>-portable.zip`：完整解压到一个固定文件夹，运行里面的 `omp-bot.exe`。
- 要用共享电脑，再下载 `omp-bot-computer-runtime.zip`，解压到 `%LOCALAPPDATA%\omp-bot\`，只需一次。只聊天和派活不需要它。

应用自带运行环境，不用另装 Node 或 omp。第一次用之前，在菜单「帮助 → 模型登录」登录一个模型。安装包还没有数字签名，Windows 可能提示未知发布者。

**安卓**：安装 `release/omp-bot-android.apk`，在电脑的「工作台 → 配对与设备」生成二维码，用手机扫码配对。

**从源码运行**：需要 Node 24 以上和 omp 18.10 以上，并且已经在 omp 里配好模型。

```sh
npm install
node ompbot.mjs serve
```

浏览器会自动打开 `http://127.0.0.1:3099`。命令行用法见 [开发文档](docs/development.md#命令行)。

## 上手三步

1. 点 ＋ 创建第一个助手，只填名字就行，形象可以顺手捏一下。
2. 在私聊里说你想做的事。需要运行命令或改文件时，助手会先弹卡片问你。
3. 再建几个助手，拉一个群，让它们一起干活。

## 权限

| 档位 | 能做什么 |
|---|---|
| 只聊天 | 不运行命令、不改文件、不用电脑 |
| 本机改东西先问我（默认） | 读写文件照常，运行命令和操作浏览器前先问你；共享电脑里除了装系统包都不问 |
| 全部放手 | 本机和共享电脑都不再逐次问，装系统包仍会问。选它要确认一次 |

飞书和手机发来的任务最多按「本机改东西先问我」跑。`~/.ssh`、云服务凭据、OMP 登录库这类位置任何一档都直接拦下。完整说明见 [使用指南](docs/guide.md#网页工作台)。

## 现在的状态

- 版本 0.2.0 还在开发中，变化见 [变更记录](CHANGELOG.md)。
- 共享电脑的几项关键流程只在沙盒里用真实组件跑过，还要在 Windows 加 WHPX 的真机上验，清单见 [开发文档](docs/development.md#实机验证)。
- 飞书还没用真实账号验收。
- 本项目不做自动更新。
- 其余限制见 [使用指南的已知限制](docs/guide.md#已知限制)。

## 致谢

- [DeepSeek-Bot](https://github.com/Fei2411/DeepSeek-Bot)：编排协议的设计来源，以及本项目实际移植的 GUI 样式和组件结构。复制源码保留 Apache-2.0 许可与署名。
- [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode)：bot=隔离 profile、每成员每群一会话、带署名的 bot 间消息格式。
- [OpenMausBot](https://github.com/milind-soni/OpenMausBot)：群聊轮次与 @mention 中继。
- [notion-avatar](https://github.com/Mayandev/notion-avatar)：头像的捏脸部件，插画是 Felix Wong 的 Noto avatar，按 CC0 使用。仿 Notion 风格，不是 Notion 官方素材。固定提交和取用范围见 [web/vendor/notion-avatar/NOTICE](web/vendor/notion-avatar/NOTICE)。
- [oh-my-pi / omp](https://github.com/can1357/oh-my-pi)：宿主 harness，提供 RPC 模式、host tool 回调、会话续接与原生压缩。

## 许可

本项目原创代码采用 MIT。移植的 DeepSeek-Bot 前端代码保留 Apache-2.0 许可；Markdown 渲染使用 marked，HTML 清理使用 DOMPurify。各组件的许可与固定版本见 [前端来源说明](web/vendor/README.md)。
