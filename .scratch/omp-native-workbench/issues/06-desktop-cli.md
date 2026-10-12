# G与质量发布 桌面/CLI生命周期

Status: ready-for-human
Implementation: verified-local-with-release-prerequisites
Owner: DesktopCliOwner

## Scope

以 ../spec.md 和 ../contract.md 为实施契约，所有者仅改分配文件。原生OMP优先，禁止第二执行引擎。

## Acceptance

关窗隐藏、退出真停止，通知/CLI控制可用，本地安装包可启动，资料不被删除。

## Evidence

最终打包程序实跑内置 OMP，关窗后台完成、菜单恢复、退出释放锁通过。便携/NSIS 构建成功，哈希与引擎 provenance 已核对，NotSigned。托盘鼠标、系统通知投递、安装/卸载与更新未验收。详见 ../../../docs/research/2026-10-12-implementation-verification.md。

## Comments

用户授权逐项实施，主代理统一验收；外部账号/证书/基础设施缺失不得假成功。
