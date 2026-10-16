import { el, button, toast, announce, api, fmtClock } from "./workbench-core.js";
import { artifactCard, loadArtifacts } from "./workbench-attach.js";

const STATE_LABELS = {
  unbound: "未绑定",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  stopped: "已停止",
  error: "出错",
};

const HOLDER_LABELS = { agent: "助手在用", human: "你在操作" };

const POLL_MS = 3000;
const MOVE_MIN_MS = 150;
const MAX_QUEUED_INPUTS = 8;
const SCROLL_MAX = 1200;

const MODIFIER_KEYS = new Set([
  "Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "NumLock", "ScrollLock", "Dead", "Unidentified",
]);
const NAMED_KEYS = {
  " ": "Space", Spacebar: "Space", Esc: "Escape", Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp",
  Down: "ArrowDown", Del: "Delete", Ins: "Insert", Return: "Enter", OS: "Meta", Win: "Meta",
};
const SHIFTED_SYMBOLS = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "minus", "+": "equal", "{": "bracketleft", "}": "bracketright", "|": "backslash", ":": "semicolon",
  "\"": "quote", "<": "comma", ">": "period", "?": "slash", "~": "grave",
};
const PLAIN_SYMBOLS = {
  "-": "minus", "=": "equal", "[": "bracketleft", "]": "bracketright", "\\": "backslash",
  ";": "semicolon", "'": "quote", "`": "grave", ",": "comma", ".": "period", "/": "slash",
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function keyChord(event) {
  if (MODIFIER_KEYS.has(event.key)) return "";
  let name = NAMED_KEYS[event.key] ?? event.key;
  let shifted = event.shiftKey;
  if (name.length === 1 && !/[a-z0-9]/.test(name)) {
    if (SHIFTED_SYMBOLS[name]) {
      name = SHIFTED_SYMBOLS[name];
      shifted = true;
    } else if (PLAIN_SYMBOLS[name]) name = PLAIN_SYMBOLS[name];
  }
  if (name.length === 1) name = name.toLocaleLowerCase();
  const mods = [];
  if (event.ctrlKey) mods.push("ctrl");
  if (event.altKey) mods.push("alt");
  if (shifted) mods.push("shift");
  if (event.metaKey) mods.push("meta");
  return mods.length ? `${mods.join("+")}+${name}` : name;
}

function warnBlock(title, text) {
  const box = el("div", "wb-warn");
  box.append(el("div", "wb-pending-title", title), el("div", "wb-warn-text", text));
  return box;
}

/**
 * 一个座席的电脑视图。deps.mode 是 "login" 时是登录屏：共享电脑里给人登录网站用的座席，不属于任何 Bot，
 * 只有打开、完成（发布登录）、关闭不保存三个动作，开着时控制方就是用户。
 */
export function createComputerView(bot, deps = {}) {
  const { section, row, kv, busy } = deps.ui;
  const login = deps.mode === "login";
  const base = login ? "/api/computer/login" : `/api/bots/${encodeURIComponent(bot.id)}/computer`;

  let computer = null;
  let unavailable = null;
  let lastError = null;
  let disposed = false;
  let desktopOpen = false;
  let userClosedDesktop = false;
  let zoomed = false;
  let stateBusy = false;
  let screenBusy = false;
  let actionBusy = false;
  let inputBusy = false;
  let pumping = false;
  let screenUrl = null;
  let previousUrl = null;
  let screenToken = 0;
  let screenAbort = null;
  let pollTimer = null;
  let refreshSoonTimer = null;
  // 状态新鲜度令牌：本地拿到更新的状态（POST/输入响应）后，在途的旧读取不得回写。
  let stateToken = 0;
  // 队列满丢弃输入时的单次提示标记；队列再次被消费后重置，避免连发提示。
  let dropNoticed = false;
  let lastScreenAt = 0;
  let lastMoveAt = 0;
  let lastMove = null;
  const queue = [];

  const canInput = () => !disposed && !!computer && computer.state === "running" && computer.holder === "human";


  const stateList = el("div", "wb-kv-list wb-computer-state");
  const stateHint = el("div", "bt-note wb-computer-hint");
  const errorBox = el("div", "wb-computer-errors");

  const bindButton = button("btn ghost", "绑定电脑", () => void runAction(bindButton, {
    label: "绑定中…", path: "bind", failure: "绑定失败", success: "已为这位助手开好电脑",
  }));
  const startButton = button("btn ghost", login ? "打开登录屏" : "启动", () => void runAction(startButton, login
    ? { label: "打开中…", path: "open", failure: "登录屏没打开", success: "登录屏已打开：在里面登录网站，好了点「完成」" }
    : { label: "启动中…", path: "start", failure: "启动失败", success: "电脑已启动" }));
  const stopButton = button("btn ghost", login ? "完成" : "停止", () => void runAction(stopButton, login
    ? { label: "发布中…", path: "done", failure: "登录没有发布", success: "登录已发布，所有助手下次打开浏览器都是登录状态" }
    : { label: "停止中…", path: "stop", failure: "停止失败", success: "已停止，文件都还在" }));
  const discardButton = button("btn ghost", "关闭不保存", () => void runAction(discardButton, {
    label: "关闭中…", path: "stop", failure: "关闭失败", success: "登录屏已关闭，这次的登录没有发布",
    question: "关掉登录屏，这次的登录不发布给助手。继续？",
  }));
  discardButton.hidden = true;
  const takeoverButton = button("btn ghost", "接管控制", () => void runAction(takeoverButton, {
    label: "接管中…", path: "takeover", failure: "接管失败", success: "已接管控制，输入会发送到这台电脑",
    question: "接管后助手暂停操作，你的点击和按键直接发到这台电脑。继续？",
  }));
  const releaseButton = button("btn ghost", "归还控制", () => void runAction(releaseButton, {
    label: "归还中…", path: "release", body: () => ({ generation: computer?.generation }), failure: "归还失败",
    success: "已归还控制，你的输入立即失效",
  }));
  const desktopButton = button("btn ghost", "打开桌面", () => setDesktopOpen(!desktopOpen));
  const zoomButton = button("btn ghost", "放大", () => openZoom());

  // 共享电脑规格：所有座席共用一台虚拟机，改了下次开机生效
  let machine = null;
  const cpuSelect = el("select");
  cpuSelect.setAttribute("aria-label", "共享电脑 vCPU 个数");
  const memorySelect = el("select");
  memorySelect.setAttribute("aria-label", "共享电脑内存");
  const machineNote = el("div", "bt-note");
  const saveMachineButton = button("btn ghost", "保存规格", () => void saveMachine());
  const machineActions = el("div", "bt-actions");
  machineActions.append(cpuSelect, memorySelect, saveMachineButton);
  const machineBox = el("div", "wb-machine");
  machineBox.append(machineNote, machineActions);

  function fillSelect(select, [min, max], value, unit) {
    select.replaceChildren();
    for (let n = min; n <= max; n += 1) {
      const option = el("option", "", `${n} ${unit}`);
      option.value = String(n);
      if (n === value) option.selected = true;
      select.append(option);
    }
  }

  function paintMachine() {
    if (!machine) {
      machineNote.textContent = "正在读取共享电脑规格…";
      machineActions.hidden = true;
      return;
    }
    machineActions.hidden = false;
    fillSelect(cpuSelect, machine.limits.cpus, machine.cpus, "vCPU");
    fillSelect(memorySelect, machine.limits.memoryGb, machine.memoryGb, "GiB 内存");
    machineNote.textContent = `现在是 ${machine.cpus} vCPU、${machine.memoryGb} GiB 内存、${machine.diskGb} GiB 磁盘，改了下次开机生效。`;
  }

  async function loadMachine() {
    try {
      const out = await api("/api/computer/shared-machine");
      if (disposed) return;
      machine = out?.machine ?? null;
    } catch (error) {
      if (disposed) return;
      machine = null;
      machineNote.textContent = `读不到共享电脑规格：${error.message}`;
      machineActions.hidden = true;
      return;
    }
    paintMachine();
  }

  async function saveMachine() {
    const body = { cpus: Number(cpuSelect.value), memoryGb: Number(memorySelect.value) };
    try {
      const out = await busy(saveMachineButton, api("/api/computer/shared-machine", { method: "PUT", body }), "保存中…");
      machine = out?.machine ?? machine;
      paintMachine();
      toast("规格已保存，共享电脑下次开机生效");
    } catch (error) {
      toast(`保存失败：${error.message}`, true);
    }
  }

  const powerActions = el("div", "bt-actions");
  powerActions.append(bindButton, startButton, stopButton, discardButton);
  const controlActions = el("div", "bt-actions");
  controlActions.append(takeoverButton, releaseButton);

  // 旧电脑：以前每个 Bot 一台的虚拟机，文件自动搬进座席的 ~/old-computer/，磁盘等用户点删除才删
  let oldItems = [];
  let oldBusy = false;
  const oldBox = el("div", "wb-old");
  const oldRow = row("旧电脑", "以前的单独电脑。文件会复制到 ~/old-computer/，旧磁盘留着，确认不要了再删。", oldBox);
  oldRow.hidden = true;

  function oldText(item) {
    if (item.state === "copying") return `正在复制：${item.step ?? "准备中"}`;
    if (item.state === "done") {
      const files = Number.isFinite(item.files) ? `${item.files} 个文件，` : "";
      return `已复制到 ~/old-computer/（${files}${item.copiedAt ? new Date(item.copiedAt).toLocaleString() : "时间未知"}）`;
    }
    if (item.state === "error") return `复制出错：${item.error?.message ?? "未知错误"}`;
    if (item.state === "orphan") return `${item.id}：它的助手已经删了，文件没有复制`;
    return "等共享电脑开机后自动复制";
  }

  function paintOld() {
    const mine = oldItems.filter((x) => x.botId === bot.id || x.state === "orphan");
    oldRow.hidden = mine.length === 0;
    oldBox.replaceChildren();
    for (const item of mine) {
      const line = el("div", "wb-old-item");
      line.dataset.state = item.state;
      line.append(el("div", "bt-note", oldText(item)));
      const actions = el("div", "bt-actions");
      if (item.state === "error") {
        actions.append(button("btn ghost", "重试复制", (ev) => void oldAction(ev.currentTarget, item, "copy", "重试中…", "已开始重新复制")));
      }
      if (item.state !== "copying") {
        actions.append(button("btn ghost danger", "删除旧电脑", (ev) => void oldAction(ev.currentTarget, item, "delete", "删除中…", "旧电脑已删除",
          `删除旧电脑 ${item.id}？它的磁盘和记录都会删掉，不能恢复。${item.state === "done" ? "已经复制到 ~/old-computer/ 的文件不受影响。" : "这台的文件还没有复制进共享电脑。"}`)));
      }
      line.append(actions);
      oldBox.append(line);
    }
  }

  async function loadOld() {
    if (login || oldBusy) return;
    try {
      const out = await api("/api/computer/old");
      if (disposed) return;
      oldItems = Array.isArray(out?.items) ? out.items : [];
    } catch {
      if (disposed) return;
      oldItems = [];
    }
    paintOld();
  }

  async function oldAction(control, item, action, label, success, question = null) {
    if (oldBusy || disposed) return;
    if (question && !confirm(question)) return;
    oldBusy = true;
    try {
      const out = await busy(control, api(`/api/computer/old/${encodeURIComponent(item.id)}/${action}`, { method: "POST", body: action === "delete" ? { confirm: true } : {} }), label);
      if (disposed) return;
      oldItems = Array.isArray(out?.items) ? out.items : oldItems;
      toast(success);
      announce(success);
    } catch (error) {
      if (disposed) return;
      const code = error.data?.code ? `（${error.data.code}）` : "";
      toast(`${action === "delete" ? "删除失败" : "重试失败"}${code}：${error.message}`, true);
    } finally {
      oldBusy = false;
      if (!disposed) paintOld();
    }
  }

  const statusCard = el("div", "bt-set-card");
  // 网站登录：在 Bot 的电脑面板里打开登录屏（登录屏自己不再套一层）
  const loginHost = el("div", "wb-computer-login");
  let loginView = null;
  const loginButton = button("btn ghost", "登录网站", () => toggleLogin());
  function toggleLogin() {
    if (loginView) {
      loginView.dispose();
      loginView = null;
      loginHost.replaceChildren();
      loginButton.textContent = "登录网站";
      return;
    }
    loginView = createComputerView({ id: "login", name: "登录屏" }, { ...deps, mode: "login", autoOpen: true });
    loginHost.append(loginView.node);
    loginButton.textContent = "收起登录屏";
  }

  if (login) {
    statusCard.append(
      stateList,
      stateHint,
      errorBox,
      row("登录屏", "在这里登录网站，点「完成」后所有助手都能用。只同步 cookie。", powerActions),
    );
  } else statusCard.append(
    stateList,
    stateHint,
    errorBox,
    row("电源", "这位助手在共享电脑上有自己的用户和主目录。停止后文件都在。", powerActions),
    row("控制", "接管后由你来操作，助手暂停。", controlActions),
    row("电脑配置", "所有助手共用这一台。", machineBox),
    row("网站登录", "所有助手共用，登录一次就行。", loginButton),
    oldRow,
  );


  const desktopSlot = el("div", "wb-computer-desktop");
  const desktopPlaceholder = el("div", "wb-screen-empty", "桌面未打开。点「打开桌面」查看这台电脑的实时画面。");
  const pane = el("div", "wb-screen");
  pane.tabIndex = 0;
  pane.setAttribute("role", "group");
  pane.setAttribute("aria-label", `${bot.name} 的电脑桌面：接管后点击与键盘会发送到电脑，按 Ctrl+Alt+Escape 退出键盘输入`);
  const screenImage = el("img", "wb-screen-img");
  screenImage.alt = login ? "登录屏当前画面" : "助手电脑当前桌面";
  screenImage.draggable = false;
  const screenChip = el("div", "wb-screen-status", "桌面未打开");
  const screenError = el("div", "wb-screen-error");
  pane.append(screenImage, screenChip, screenError);
  desktopSlot.append(desktopPlaceholder, pane);
  const desktopHint = el("div", "bt-note");
  const desktopHost = el("div", "wb-computer-desktop-host");
  desktopHost.append(desktopSlot);

  const desktopCard = el("div", "bt-set-card");
  const desktopActions = el("div", "bt-actions");
  desktopActions.append(desktopButton, zoomButton);
  desktopCard.append(
    row("桌面", login ? "直接在画面上点击和打字。" : "接管后才能点击和打字。", desktopActions),
    desktopHost,
    desktopHint,
  );


  const textInput = el("textarea", "bt-textarea wb-computer-text");
  textInput.rows = 2;
  textInput.placeholder = "要输入到电脑的文字，例如终端命令";
  textInput.setAttribute("aria-label", "发送到电脑的文字");
  const textSend = button("btn ghost", "发送文本", () => void sendText());
  const textField = el("div", "wb-computer-field");
  textField.append(textInput, textSend);

  const keyInput = el("input", "bt-input");
  keyInput.placeholder = "如 ctrl+alt+t 或 Enter";
  keyInput.setAttribute("aria-label", "发送按键");
  const keySend = button("btn ghost", "发送按键", () => void sendKey());
  const keyField = el("div", "wb-computer-field");
  keyField.append(keyInput, keySend);

  const quickKeys = el("div", "bt-actions");
  const quickKeyButtons = [];
  for (const [label, key] of [["回车", "Enter"], ["退出键", "Escape"], ["切换焦点", "Tab"]]) {
    const node = button("bt-soft-sm", label, () => enqueueDiscrete({ action: "key", key }));
    quickKeyButtons.push(node);
    quickKeys.append(node);
  }

  const inputHint = el("div", "bt-note");
  const inputCard = el("div", "bt-set-card");
  inputCard.append(
    inputHint,
    row("发送文本", "打到光标所在的位置，中文和长文本用这里。", textField),
    row("发送按键", "组合键用 + 连接，如 ctrl+alt+t。", keyField),
    row("常用按键", "回车、退出、切换焦点。", quickKeys),
  );


  const artifactList = el("div", "wb-artifact-list");
  const artifactNote = el("div", "bt-note", "加载中…");
  const artifactRefresh = button("btn ghost", "刷新", function () {
    return busy(this, loadBotArtifacts(), "刷新中…");
  });
  const artifactCardBox = el("div", "bt-set-card");
  artifactCardBox.append(
    row("成果", "电脑里发布的文件会出现在这里和任务详情里。", artifactRefresh),
    artifactList,
    artifactNote,
  );


  const readyBody = el("div", "wb-computer-body");
  if (login) readyBody.append(section("登录屏", statusCard), section("实时桌面", desktopCard), section("人工输入", inputCard));
  else readyBody.append(section("电脑", statusCard), loginHost, section("实时桌面", desktopCard), section("人工输入", inputCard), section("成果", artifactCardBox));
  if (!login && bot.executionMode === "chat") {
    readyBody.prepend(el("div", "wb-note", "它现在是「只聊天」，不会用这台电脑。要它在电脑里干活，去「使用权限」改一下。你自己接管不受影响。"));
  }

  const pendingBox = el("div", "wb-computer-pending");
  const pendingTitle = el("div", "wb-pending-title");
  const pendingText = el("div", "bt-note");
  const pendingRetry = button("btn ghost", "重试", () => void loadState());
  pendingBox.append(pendingTitle, pendingText, pendingRetry);
  pendingBox.classList.add("hidden");

  const root = el("div", "wb-panel-body wb-computer");
  root.append(pendingBox, readyBody);


  function loginHintText(state) {
    if (!computer) return "正在读取登录屏状态…";
    const published = computer.published?.at ? `上次发布于 ${fmtClock(Date.parse(computer.published.at))}。` : "还没有发布过登录。";
    if (state === "starting" || state === "stopping") return "正在切换登录屏，请稍候…";
    if (state === "running") return `在下面的桌面上打开网站、登录，好了点「完成」。${published}`;
    if (state === "error") return "登录屏出错，可尝试重新打开；下方是服务端返回的错误。";
    return `登录屏没开。${published}`;
  }

  function stateHintText(state) {
    if (login) return loginHintText(state);
    if (!computer) return "正在读取电脑状态…";
    if (!computer.bound) return "还没有绑定电脑。";
    if (state === "starting" || state === "stopping") return "正在切换电源，请稍候…";
    if (state === "running") {
      return canInput()
        ? "你正在操作：点击、滚轮、指针和键盘都会发送到这台电脑。"
        : "助手正在用，这里只能看。点「接管控制」由你来操作。";
    }
    if (state === "error") return "电脑出错，可尝试重新启动；下方是服务端返回的错误。";
    return computer.vm?.state === "running"
      ? "已停止，文件都还在。点「启动」继续。"
      : "已停止，文件都还在。点「启动」继续。";
  }

  function paint() {
    if (disposed) return;
    pendingBox.classList.toggle("hidden", !unavailable);
    readyBody.classList.toggle("hidden", !!unavailable);
    if (unavailable) {
      pendingTitle.textContent = unavailable.title;
      pendingText.textContent = unavailable.text;
      return;
    }

    const state = computer?.state ?? null;
    const running = state === "running";
    const human = running && computer?.holder === "human";

    stateList.replaceChildren();
    if (!computer) {
      stateList.append(kv("状态", "读取中…"));
    } else {
      stateList.append(kv("状态", STATE_LABELS[computer.state] || computer.state || "未知"));
      stateList.append(kv("控制方", HOLDER_LABELS[computer.holder] || (computer.bound ? "无" : "—")));
      if (login) {
        if (computer.vm) stateList.append(kv("共享电脑", STATE_LABELS[computer.vm.state] || computer.vm.state || "未知"));
        stateList.append(kv("上次发布", computer.published?.at ? fmtClock(Date.parse(computer.published.at)) : "还没有"));
      } else if (computer.bound) {
        stateList.append(kv("电脑编号", computer.id || "—"));
        stateList.append(kv("系统", `${computer.os === "linux" ? "Linux" : computer.os || "未知"}${computer.kind === "vm" ? "（共享电脑）" : ""}`));
        if (computer.vm) stateList.append(kv("共享电脑", STATE_LABELS[computer.vm.state] || computer.vm.state || "未知"));
        stateList.append(kv("分辨率", computer.display ? `${computer.display.width} × ${computer.display.height}` : "未知"));
        stateList.append(kv("数据", computer.persistent ? "保留（停止后主目录里的文件仍在）" : "不保留"));
        stateList.append(kv("控制代号", Number.isFinite(computer.generation) ? String(computer.generation) : "—"));
      }
    }
    stateHint.textContent = stateHintText(state);

    errorBox.replaceChildren();
    if (computer?.error) errorBox.append(warnBlock("电脑报错", `${computer.error.code}：${computer.error.message}`));
    if (lastError) errorBox.append(warnBlock(lastError.title, lastError.text));

    bindButton.hidden = login || !(computer && !computer.bound);
    startButton.hidden = !(computer && computer.bound && (state === "stopped" || state === "error"));
    stopButton.hidden = !(computer && computer.bound && (login ? state === "running" : (state === "starting" || state === "running")));
    discardButton.hidden = !(login && computer && (state === "starting" || state === "running"));
    if (!actionBusy) startButton.textContent = login ? (state === "error" ? "重新打开登录屏" : "打开登录屏") : (state === "error" ? "重新启动" : "启动");
    for (const node of [bindButton, startButton, stopButton, discardButton, takeoverButton, releaseButton]) node.disabled = actionBusy;
    takeoverButton.disabled = actionBusy || !running || human;
    releaseButton.disabled = actionBusy || !human;
    desktopButton.disabled = !running;
    desktopButton.textContent = desktopOpen ? "收起桌面" : "打开桌面";
    zoomButton.disabled = !running || !desktopOpen;

    inputHint.textContent = human
      ? "输入会立即发送到电脑。失去控制（归还或被接管）后，未发送的输入会被丢弃。"
      : "先点「接管控制」才能用。";
    textInput.disabled = !human;
    textSend.disabled = !human;
    keyInput.disabled = !human;
    keySend.disabled = !human;
    for (const node of quickKeyButtons) node.disabled = !human;

    paintDesktop();
  }

  function paintDesktop() {
    const human = canInput();
    desktopPlaceholder.classList.toggle("hidden", desktopOpen);
    pane.classList.toggle("hidden", !desktopOpen);
    pane.dataset.live = human ? "1" : "0";
    if (!desktopOpen) screenChip.textContent = "桌面未打开";
    else if (computer?.state !== "running") screenChip.textContent = "电脑未运行";
    else screenChip.textContent = `${human ? "你正在操作" : "只读预览"} · ${lastScreenAt ? `更新于 ${fmtClock(lastScreenAt)}` : "取图中…"}`;
    desktopHint.textContent = zoomed
      ? "桌面在放大窗口中显示：点击窗口外或按 × 关闭（Esc 会发送到电脑）。"
      : human
        ? "你正在操作：左键、右键、滚轮、指针移动和键盘都会发送到电脑；退出键盘输入按 Ctrl+Alt+Escape。"
        : "只读预览：点「接管控制」后才能操作这台电脑。";
  }


  function applyState(next) {
    // 这次写入比任何在途读取都新：令牌变化后，晚到的旧 GET 响应会被丢弃。
    stateToken += 1;
    if (computer?.generation !== next?.generation) {
      queue.length = 0;
      lastMove = null;
    }
    computer = next;
    if (!computer) return;
    if (computer.state === "running" && !desktopOpen && !userClosedDesktop && !zoomed) setDesktopOpen(true);
    if (computer.holder !== "human" && queue.length) queue.length = 0;
    paint();
  }

  async function loadState() {
    if (stateBusy || disposed) return;
    stateBusy = true;
    // 只应用「最新一次状态写入」对应的读取：轮询请求在途时用户点了接管/停止，
    // 旧快照不能把界面翻回上一次的状态。
    const token = ++stateToken;
    try {
      const out = await api(base);
      if (disposed || token !== stateToken) return;
      unavailable = null;
      applyState(out?.computer ?? null);
    } catch (error) {
      if (disposed || token !== stateToken) return;
      const code = error.data?.code ? `（${error.data.code}）` : "";
      if (error.status === 404 || error.status === 501) {
        computer = null;
        unavailable = {
          title: "电脑接口暂不可用",
          text: `后端未提供 ${base}（HTTP ${error.status}）。这里不放置假操作；接口就绪后点「重试」。`,
        };
      } else {
        lastError = { title: "状态读取失败", text: `${error.message}${code}` };
      }
      paint();
    } finally {
      stateBusy = false;
    }
  }


  async function runAction(control, { label, path, body = {}, question, success, failure }) {
    if (actionBusy || disposed) return;
    if (question && !confirm(question)) return;
    actionBusy = true;
    lastError = null;
    paint();
    try {
      const payload = typeof body === "function" ? body() : body;
      const out = await busy(control, api(`${base}/${path}`, { method: "POST", body: payload }), label);
      if (disposed) return;
      toast(success);
      announce(success);
      if (out?.computer) {
        applyState(out.computer);
        if (out.computer.state === "running" && desktopOpen) void refreshScreen();
      } else {
        await loadState();
      }
    } catch (error) {
      if (disposed) return;
      const code = error.data?.code ? `（${error.data.code}）` : "";
      lastError = { title: "操作未完成", text: `${error.message}${code}` };
      toast(`${failure}${code}：${error.message}`, true);
    } finally {
      actionBusy = false;
      if (!disposed) paint();
    }
  }


  function onInputError(error) {
    queue.length = 0;
    const code = error.data?.code ? `（${error.data.code}）` : "";
    lastError = { title: "输入未发送", text: `${error.message}${code}` };
    toast(`输入未发送${code}：${error.message}`, true);
    paint();
    void loadState();
  }

  async function runInput(action) {
    if (inputBusy || !canInput() || (action.generation !== undefined && action.generation !== computer.generation)) return false;
    inputBusy = true;
    try {
      const out = await api(`${base}/input`, { method: "POST", body: { generation: computer.generation, ...action } });
      if (!disposed && out?.computer) {
        applyState(out.computer);
      }
      if (action.action !== "move") scheduleScreenRefresh();
      return true;
    } catch (error) {
      if (!disposed) onInputError(error);
      return false;
    } finally {
      inputBusy = false;
      if (queue.length && !pumping && !disposed) void pumpQueue();
    }
  }

  async function pumpQueue() {
    if (pumping || inputBusy) return;
    pumping = true;
    try {
      while (queue.length && canInput() && !disposed) {
        const action = queue.shift();
        if (!(await runInput(action))) break;
      }
    } finally {
      pumping = false;
      if (!canInput()) queue.length = 0;
    }
  }

  function enqueueDiscrete(action) {
    if (!canInput()) return;
    if (queue.length >= MAX_QUEUED_INPUTS) {
      // 滚轮事件成串到达：队列满时把滚动量并入还没发出的最后一帧，距离不丢，顺序不变。
      const tail = queue.at(-1);
      if (action.action === "scroll" && tail?.action === "scroll") {
        tail.deltaX += action.deltaX;
        tail.deltaY += action.deltaY;
        return;
      }
      // 其余动作无法合并：如实告知这一次有输入没发出去，不假装已发送。
      if (!dropNoticed) {
        dropNoticed = true;
        toast("输入过快：部分点击或按键没有发送，请稍后再试", true);
      }
      return;
    }
    queue.push({ ...action, generation: computer.generation });
    dropNoticed = false;
    void pumpQueue();
  }

  function sendMove(x, y) {
    if (!canInput() || inputBusy || pumping || queue.length) return;
    if (lastMove && lastMove.x === x && lastMove.y === y) return;
    lastMove = { x, y };
    void runInput({ action: "move", x, y });
  }

  async function sendText() {
    if (!canInput()) return;
    const text = textInput.value;
    if (!text) return;
    textInput.disabled = true;
    try {
      if (await busy(textSend, runInput({ action: "type", text }), "发送中…")) textInput.value = "";
    } finally {
      if (!disposed) paint();
    }
  }

  async function sendKey() {
    if (!canInput()) return;
    const key = keyInput.value.trim();
    if (!key) return;
    try {
      if (await busy(keySend, runInput({ action: "key", key }), "发送中…")) keyInput.value = "";
    } finally {
      if (!disposed) paint();
    }
  }


  function screenSize() {
    const width = screenImage.naturalWidth || computer?.display?.width || 0;
    const height = screenImage.naturalHeight || computer?.display?.height || 0;
    return { width, height };
  }

  function screenScale() {
    const rect = screenImage.getBoundingClientRect();
    const { width, height } = screenSize();
    return { x: rect.width ? width / rect.width : 1, y: rect.height ? height / rect.height : 1 };
  }

  function pointFromEvent(event) {
    const rect = screenImage.getBoundingClientRect();
    const { width, height } = screenSize();
    if (!width || !height || !rect.width || !rect.height) return null;
    return {
      x: clamp(Math.floor((event.clientX - rect.left) * (width / rect.width)), 0, width - 1),
      y: clamp(Math.floor((event.clientY - rect.top) * (height / rect.height)), 0, height - 1),
    };
  }

  pane.addEventListener("click", (event) => {
    pane.focus();
    if (!canInput()) return;
    const point = pointFromEvent(event);
    if (point) enqueueDiscrete({ action: "click", x: point.x, y: point.y, button: "left" });
  });

  pane.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (!canInput()) return;
    const point = pointFromEvent(event);
    if (point) enqueueDiscrete({ action: "click", x: point.x, y: point.y, button: "right" });
  });

  pane.addEventListener("mousemove", (event) => {
    if (!canInput()) return;
    const now = performance.now();
    if (now - lastMoveAt < MOVE_MIN_MS) return;
    lastMoveAt = now;
    const point = pointFromEvent(event);
    if (point) sendMove(point.x, point.y);
  });

  pane.addEventListener("wheel", (event) => {
    if (!canInput()) return;
    event.preventDefault();
    const scale = screenScale();
    const deltaY = clamp(Math.round(event.deltaY * scale.y), -SCROLL_MAX, SCROLL_MAX);
    const deltaX = clamp(Math.round(event.deltaX * scale.x), -SCROLL_MAX, SCROLL_MAX);
    if (!deltaY && !deltaX) return;
    enqueueDiscrete({ action: "scroll", deltaX, deltaY });
  }, { passive: false });

  pane.addEventListener("keydown", (event) => {
    if (!canInput() || event.isComposing) return;
    if (event.ctrlKey && event.altKey && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      pane.blur();
      releaseButton.focus();
      announce("已退出键盘输入，按键不再发送到电脑");
      return;
    }
    const key = keyChord(event);
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    enqueueDiscrete({ action: "key", key });
  });


  async function refreshScreen() {
    if (disposed || screenBusy || !desktopOpen || computer?.state !== "running") return;
    screenBusy = true;
    const token = ++screenToken;
    const controller = new AbortController();
    screenAbort = controller;
    try {
      const res = await fetch(`${base}/screen`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (disposed || token !== screenToken) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        screenError.textContent = `桌面画面读取失败：${data.error || `HTTP ${res.status}`}`;
        return;
      }
      const blob = await res.blob();
      if (disposed || token !== screenToken) return;
      // 上一帧可能还没触发 load（刷新接连到来）：替换前先释放旧地址，
      // 否则 previousUrl 被覆盖后再无人回收，blob 会一直挂着。
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
        previousUrl = null;
      }
      previousUrl = screenUrl;
      screenUrl = URL.createObjectURL(blob);
      screenImage.src = screenUrl;
      lastScreenAt = Date.now();
      screenError.textContent = "";
      paintDesktop();
    } catch (error) {
      if (!disposed && error.name !== "AbortError") screenError.textContent = `桌面画面读取失败：${error.message}`;
    } finally {
      if (screenAbort === controller) screenAbort = null;
      screenBusy = false;
    }
  }

  screenImage.addEventListener("load", () => {
    // 面板离开后旧图可能才加载完：不再回写隐藏面板，地址也已由 dispose 释放。
    if (disposed) return;
    if (previousUrl) {
      URL.revokeObjectURL(previousUrl);
      previousUrl = null;
    }
    paintDesktop();
  });

  function scheduleScreenRefresh(delay = 200) {
    if (disposed || !desktopOpen || computer?.state !== "running") return;
    clearTimeout(refreshSoonTimer);
    refreshSoonTimer = setTimeout(() => { void refreshScreen(); }, delay);
  }

  function setDesktopOpen(open) {
    if (desktopOpen === open) return;
    desktopOpen = open;
    if (!open) {
      userClosedDesktop = true;
      screenToken += 1;
      screenAbort?.abort();
      clearTimeout(refreshSoonTimer);
      refreshSoonTimer = null;
    }
    paint();
    if (open) void refreshScreen();
  }

  function openZoom() {
    if (zoomed || !deps.openModal || disposed) return;
    zoomed = true;
    desktopSlot.classList.add("wb-screen-zoomed");
    deps.openModal(login ? "登录屏" : "助手电脑桌面", desktopSlot, () => {
      zoomed = false;
      desktopSlot.classList.remove("wb-screen-zoomed");
      if (!disposed) {
        desktopHost.append(desktopSlot);
        paint();
      }
    });
    pane.focus();
  }


  async function loadBotArtifacts() {
    try {
      const list = await loadArtifacts({ botId: bot.id });
      if (disposed) return;
      artifactList.replaceChildren();
      if (list === null) {
        artifactNote.textContent = "成果接口暂不可用（HTTP 404）。";
        return;
      }
      if (!list.length) {
        artifactNote.textContent = "还没有登记成果。";
        return;
      }
      artifactNote.textContent = `共 ${list.length} 项。`;
      for (const artifact of list) artifactList.append(artifactCard(artifact));
    } catch (error) {
      if (!disposed) artifactNote.textContent = `成果读取失败：${error.message}`;
    }
  }


  function tick() {
    if (disposed) return;
    if (!root.isConnected) {
      dispose();
      return;
    }
    if (document.hidden) return;
    void loadState();
    void loadOld();
    if (desktopOpen) void refreshScreen();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    loginView?.dispose();
    loginView = null;
    clearInterval(pollTimer);
    pollTimer = null;
    clearTimeout(refreshSoonTimer);
    refreshSoonTimer = null;
    screenAbort?.abort();
    queue.length = 0;
    if (screenUrl) URL.revokeObjectURL(screenUrl);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    screenUrl = null;
    previousUrl = null;
    if (zoomed) {
      zoomed = false;
      desktopSlot.classList.remove("wb-screen-zoomed");
      deps.closeModal?.();
    }
  }

  paint();
  pollTimer = setInterval(tick, POLL_MS);
  if (login) {
    // 「登录网站」点开就直接打开登录屏，不用再点一次
    void loadState().then(() => {
      if (deps.autoOpen && !disposed && computer && computer.state !== "running" && computer.state !== "starting") startButton.click();
    });
  } else {
    paintMachine();
    void loadState();
    void loadMachine();
    void loadOld();
    void loadBotArtifacts();
  }

  return { node: root, dispose };
}
