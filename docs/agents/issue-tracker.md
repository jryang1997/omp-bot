# 本地 Markdown 问题跟踪器

本仓库的规格与工单保存到 `.scratch/`。

## 文件约定

- 每个功能使用一个目录 `.scratch/<feature-slug>/`。
- 规格保存到 `.scratch/<feature-slug>/spec.md`。
- 每张实施工单独立保存到 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号。
- 在工单顶部附近用 `Status:` 行记录 triage 状态。状态名称见 `triage-labels.md`。
- 在文件底部的 `## Comments` 标题下追加讨论记录。

## 发布与读取工单

当技能要求发布到问题跟踪器时，按上述约定创建规格或工单文件，并按需创建目录。

当技能要求读取相关工单时，读取指定路径的文件。如果只提供编号，在对应功能的 `issues/` 目录中查找该编号的文件。

## Wayfinder 操作

使用 `/wayfinder` 时，按以下约定记录探索任务。探索任务的 `claimed` 和 `resolved` 是工作状态，与实施工单的 triage 标签分开使用。

- 工作地图保存到 `.scratch/<effort>/map.md`，包含 Notes、Decisions-so-far 和 Fog。
- 每个子任务保存到 `.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 开始编号。在正文中记录问题，用 `Type:` 标明 `research`、`prototype`、`grilling` 或 `task`。
- 用顶部附近的 `Blocked by: NN, NN` 行记录依赖。所有依赖任务均为 `resolved` 时，该任务解除阻塞。
- 扫描 `issues/`，按编号选择尚未解决、未被领取且没有阻塞的任务。
- 开始工作前，设置 `Status: claimed` 并保存。
- 完成后，在 `## Answer` 下追加答案，设置 `Status: resolved`，并把答案摘要和文件链接追加到地图的 Decisions-so-far。
