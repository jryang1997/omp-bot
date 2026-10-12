# 领域文档

本仓库采用 single-context 布局，使用一份根目录词汇表和一组架构决策记录。

## 探索前读取

- 读取根目录 `GLOSSARY.md`。
- 读取根目录 `docs/adr/` 中与当前工作相关的架构决策记录。

如果文件或目录尚不存在，直接继续。由 `/domain-modeling` 在术语或决策实际确定时按需创建，不提前创建空文档。`/grill-with-docs` 和 `/improve-codebase-architecture` 也可通过 `/domain-modeling` 记录结果。

## 文档位置

- `GLOSSARY.md` 定义本仓库的领域术语。
- `docs/adr/` 保存架构决策记录，使用 `0001-<slug>.md` 形式的文件名。

## 使用词汇表中的术语

在工单标题、重构建议、假设或测试名称中提到领域概念时，使用 `GLOSSARY.md` 定义的名称。

词汇表没有所需概念时，先检查该名称是否符合项目用语。确有缺口时，记录给 `/domain-modeling`。

## 明确说明决策冲突

如果建议与已有架构决策记录冲突，指出对应 ADR、冲突内容和重新讨论的理由。
