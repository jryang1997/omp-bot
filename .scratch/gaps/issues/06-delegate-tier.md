# 06: 派活分档

**What to build:** 让派活的 bot 能把简单活派给便宜模型、难活派给强模型。

**Blocked by:** 无

**Status:** done

## Comments

- 方案改了：不给 `delegate_bot` 加 `tier` 参数。每个 bot 本来就有自己的模型，跑在自己的 OMP 进程和会话里。按次切模型要么改对方常驻会话的模型（打乱它的缓存和上下文），要么另起进程，都比问题本身重。
- 更直接的做法：`list_bots` 输出带上每个队友的模型，`delegate_bot` 说明里提示"简单、量大的活优先派给用便宜模型的队友"。分档就是挑人，主人建一个便宜模型的队友即可。bot 自己的轻活还可以用 OMP 原生 `task` 子代理和 `modelRoles`，不用宿主管。
- 测试 `test/delegation.mjs` 18/18（新增 1 条）。去掉模型输出的变异被抓到。回归 runs 45/45、team 32/32。
