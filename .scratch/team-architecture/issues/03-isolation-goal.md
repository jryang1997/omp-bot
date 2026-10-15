# 03 隔离要防到什么程度

Type: grilling
Label: wayfinder:grilling
Status: resolved
Blocked by:

## Question

隔离的目标是防误操作，还是防一个 bot 故意越界。

## Facts

- 宿主侧所有 omp 进程跑在同一个 Windows 用户下。bot 有本机 bash 就能读别的 bot 目录，也能读到虚拟机管理通道的凭据。宿主侧的隔离只能靠工作目录约定和审批档。
- 客机侧可以做真隔离。每 bot 一个 Linux 用户，home 设 0700，`/workspace` 归一个共享组。但宿主侧不设防，客机侧隔离也能被绕过。
- Grok Bot 官方明说 bot 之间不是安全边界。
- 用户希望 bot 在客机里自行发挥、自己装 pi。给免密 sudo，客机侧也就没有隔离了。

## Recommendation

目标定为防误操作。

- 每 bot 一个 Linux 用户，不给免密 sudo。
- 用户级安装随便装，例如 npm prefix、pipx、`~/.local`。pi 这类工具装在自己 home 里。
- 需要装系统包时走一条要审批的路，由用户点头。

要防恶意就得给每个 bot 单独的 Windows 账户，成本很高，我不建议。

## Need from user

同意推荐，或者给出想防的具体场景。

## Done when

隔离目标、客机用户模型、sudo 策略写进 Answer。

## Answer

用户 2026-10-15 确认只防误操作。

- 客机里每个 bot 一个 Linux 用户，home 设 0700。`/workspace` 归共享组 `team`，目录带 setgid，组内可读写。
- 不给免密 sudo。pi、npm 包、pipx 工具装在 bot 自己的 home 里。
- 装系统包走一条要用户审批的路，由宿主侧发起，以客机管理员身份执行。
- 每个 bot 的屏幕只接受它自己的 X 授权，别的 bot 默认连不上。
- 宿主侧不加新的强制隔离。bot 之间靠工作目录约定和审批档区分，这是有意的取舍。
- 不承诺防恶意。要防恶意得给每个 bot 单独的 Windows 账户，本 effort 不做。

## Comments