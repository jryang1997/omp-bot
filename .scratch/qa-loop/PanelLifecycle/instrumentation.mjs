// 一次性面板探针（throwaway）：页面侧插桩片段 + 每个缺陷的复现步骤。
// 用法：在任何 CDP 会话里对页面执行 Runtime.evaluate(表达式)，再按步骤点击/等待。
// 需要 Electron 以 --remote-debugging-port=9472 启动（同 .scratch/qa-loop/launch.mjs）。
// 注意：这些片段只读/记数，不改业务数据；配对码探针会在隔离 home 里生成一次性 ticket，可在「现有配对」里撤销。

/* ============================================================================
 * 片段 1：跟踪活动定时器（父级已验证过的技术，用于配对倒计时）
 * 步骤（缺陷 A：手机配对码倒计时在离开面板后继续跑）
 *   1. evaluate(TRACK_INTERVALS)
 *   2. 任务视图 → 连接手机 → 手机接入开启并运行 → 生成配对二维码（出现 .wb-code-countdown）
 *   3. 读 count()：期望 1（倒计时）
 *   4. 点 #drawer-close
 *   5. 等 1.5s 后读 count()：修复前 ≥1 且持续 >5s；修复后应为 0
 *      （修复后探针在关闭后第一次 tick 内自清；重新打开「连接手机」会整段重建面板，不再续跑）
 * ========================================================================= */
export const TRACK_INTERVALS = `(() => {
  if (!window.__probeIntervals) {
    const live = new Set();
    const si = window.setInterval, ci = window.clearInterval;
    window.setInterval = function (...a) { const id = si.apply(this, a); live.add(id); return id; };
    window.clearInterval = function (id) { live.delete(id); return ci.call(window, id); };
    window.__probeIntervals = { live, count: () => live.size };
  }
  return window.__probeIntervals.count();
})()`;

export const READ_COUNTDOWN = `document.querySelector(".wb-code-countdown")?.textContent ?? null`;

/* ============================================================================
 * 片段 2：对象 URL 记数（缺陷 B：接连刷新桌面时旧 blob URL 不再回收）
 * 步骤：
 *   1. evaluate(COUNT_BLOB_URLS)（在打开电脑面板之前）
 *   2. 打开 助手设置 → 电脑，电脑 running 且桌面打开，让它刷新 10+ 帧
 *      （真实路径：点两下桌面、等 3s 轮询；确定性路径：用 Fetch.enable 把 /computer/screen
 *       替换成一个超大有效 PNG 的合成响应，令解码慢于下一次取图，逼出竞态）
 *   3. 读 leaked()：修复后应 ≤ 2（当前显示的 + 一个待释放）；修复前竞态命中时单调增长
 *   4. 收起桌面 / 关闭抽屉后 leaked() 仍 ≤2（dispose 会释放当前帧）
 * 说明：/screen 的合成为合成响应，只在探针期间生效，关闭拦截即恢复真实画面。
 * ========================================================================= */
export const COUNT_BLOB_URLS = `(() => {
  if (!window.__probeUrls) {
    const live = new Set();
    const co = URL.createObjectURL.bind(URL), ro = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = function (blob) { const url = co(blob); live.add(url); return url; };
    URL.revokeObjectURL = function (url) { live.delete(url); return ro(url); };
    window.__probeUrls = { live, leaked: () => live.size };
  }
  return window.__probeUrls.leaked();
})()`;

/* ============================================================================
 * 片段 3：读电脑面板状态行（缺陷 C：在途的旧 GET 覆盖更新的接管/停止结果）
 * 选择器：根 .wb-computer；状态行 .wb-computer .wb-kv-list .bt-kv（两个 span=键、值）
 * 步骤（需要 bound+running 的电脑）：
 *   1. 打开 助手设置 → 电脑，确认「控制方」= Bot 自动控制，「控制代号」= G
 *   2. CDP Fetch.enable 只拦截 method=GET 且 url 含 /computer 的请求；
 *      每遇到一次先 sleep 1500ms 再 Fetch.continueRequest（真实响应被延迟）
 *   3. 点「接管控制」并确认
 *   4. 立即（POST 已返回后 300ms）读 readState()：期望 控制方=你在操作、代号=G+1
 *      修复前：被延迟的旧 GET 随后落地，控制方翻回「Bot 自动控制」、代号回 G，
 *      接管按钮重新可点（服务端其实已是人工）；修复后：旧响应被丢弃，保持「你在操作」
 *   5. 点「归还控制」，readState() 期望 控制方=Bind 自动控制 / 无人工
 * 变体（无需真机 VM 的合成版）：用 Fetch.fulfillRequest 给 POST /computer/takeover 返回
 *   {computer:{...holder:"human",generation:G+1}}、给 GET 返回 {computer:{...holder:"agent",generation:G}}，
 *   再断言 reconcile 后界面为「你在操作」。
 * ========================================================================= */
export const READ_COMPUTER_STATE = `(() => {
  const rows = [...document.querySelectorAll(".wb-computer .wb-kv-list .bt-kv")]
    .map((r) => [...r.querySelectorAll("span")].map((s) => s.textContent).join("="));
  const btn = (label) => [...document.querySelectorAll(".wb-computer button")].find((b) => b.textContent === label);
  return JSON.stringify({ rows, takeoverDisabled: btn("接管控制")?.disabled ?? null, chip: document.querySelector(".wb-screen-status")?.textContent ?? null });
})()`;

/* ============================================================================
 * 片段 4：设置保存失败不得显示成未保存的选择（缺陷 D：保存失败后控件停在错误值）
 * 选择器：抽屉页签 #drawer-body .bt-tabs .bt-tab（文本「使用权限」）；
 *         行 = #drawer-body .bt-set-row，其中 .bt-set-copy 文本含「助手能做什么」
 * 步骤：
 *   1. 打开 助手设置 → 使用权限，记下 select 当前值（如 supervised）
 *   2. CDP Fetch.enable 拦截 PATCH /api/bots/* 并 Fetch.failRequest(503)（或 fulfill 500）
 *   3. setSelect("只聊天")（见下方 JS：设 value + dispatch change）
 *   4. 等出现「保存失败」toast 后读 select 值：修复后应回到服务端真值（如 supervised，面板整页重绘）；
 *      修复前停在「只聊天」，用户会以为已经保存
 *   5. 同样的步骤对「记忆开关」复选框（PATCH 409 memory_prereq_missing 时不再停在勾选态）
 * ========================================================================= */
export const SET_EXECUTION_MODE = `(() => {
  const row = [...document.querySelectorAll("#drawer-body .bt-set-row")]
    .find((r) => r.querySelector(".bt-set-copy")?.textContent.includes("助手能做什么"));
  const sel = row?.querySelector("select");
  if (!sel) return "no-select";
  sel.value = "chat";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return sel.value;
})()`;

export const READ_EXECUTION_MODE = `(() => {
  const row = [...document.querySelectorAll("#drawer-body .bt-set-row")]
    .find((r) => r.querySelector(".bt-set-copy")?.textContent.includes("助手能做什么"));
  return row?.querySelector("select")?.value ?? null;
})()`;

/* ============================================================================
 * 片段 5：输入队列满时不静默（缺陷 E：连续滚轮/点击超过队列上限会被悄悄丢弃）
 * 步骤（电脑 running 且已接管，桌面打开）：
 *   1. 打开 助手设置 → 电脑，点「接管控制」
 *   2. 注入 CDP 延迟（Network.emulateNetworkConditions latency 400ms 或拦截 /input 延迟）
 *   3. 在 5s 内快速点击桌面 10 次、并连续滚轮 30 次
 *   4. 修复后：滚轮并入待发帧（不丢距离、不提示）；点击超出 8 个待发时会弹一次
 *      「输入过快：部分点击或按键没有发送」；队列消费后再次超出会再提示一次
 *   5. 关掉延迟后点击全部送达（同一提示不再出现）
 * ========================================================================= */
