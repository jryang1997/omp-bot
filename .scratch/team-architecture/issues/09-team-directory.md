# 09 team 目录放哪、怎么管

Type: grilling
Label: wayfinder:grilling
Status: open
Blocked by: 06, 07, 08

## Question

team 目录放在哪，要不要 git，用户怎么查看和编辑，旧数据怎么迁过来。

## Points

- 放在 `.ompbot/` 下面，还是用户看得见的位置。
- git init 给 omp 一个确定的仓库边界，也让用户能看到"这周学会了什么"，学错了能回滚。要定谁来 commit、多大粒度。
- 旧的 `bots/<id>/<scope>/{work,sessions,agent}` 怎么迁。sessions 仍按 scope 分开；work 和记忆合成一份时怎么去重。

## Done when

目录树、git 规则、迁移步骤写进 Answer。

## Comments