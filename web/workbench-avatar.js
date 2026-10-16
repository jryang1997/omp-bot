/*
 * Bot 头像：<omp-mascot> 吉祥物（vendor/mascot，来源和许可见那里的 NOTICE），或者裁切好的上传图片。
 * 形象存在花名册的 bot.avatar 里，取值规则以服务端 src/domain.mjs 为准，这里只负责画和编辑。
 */
import { MASCOT_BODY_IDS, MASCOT_COLORS, MASCOT_COLOR_IDS, MASCOT_EXPRESSIONS, gradientOf } from "./vendor/mascot/omp-mascot.js";
import { el, button, toast, api, fmtSize } from "./workbench-core.js";

export const BODY_NAMES = {
  cursor: "光标", blob: "团子", circle: "圆", squircle: "圆角方", capsule: "胶囊",
  drop: "水滴", shield: "盾牌", hexagon: "六边形", diamond: "菱形", star: "星星",
};
export const COLOR_NAMES = {
  green: "绿", blue: "蓝", red: "红", orange: "橙", purple: "紫",
  cyan: "青", pink: "粉", yellow: "黄", teal: "松石绿", coral: "珊瑚",
};
export const EXPRESSION_NAMES = {
  idle: "平静", happy: "开心", curious: "好奇", drowsy: "犯困", working: "干活",
  thinking: "思考", listening: "倾听", sleeping: "睡觉", suspicious: "怀疑", proud: "得意",
};
export const CROP_NAMES = { mascot: "吉祥物", circle: "圆形", rounded: "圆角", square: "方形" };
const CROP_RADIUS = { circle: "50%", rounded: "22%", square: "0" };
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** 小于这个尺寸的吉祥物降到 30 帧，看不出差别，省一半绘制。 */
const SMALL = 48;
const FALLBACK = { body: "cursor", color: "green", expression: null, crop: "mascot", url: null, zoom: 1, focusX: 0.5, focusY: 0.5 };
/** 这几个运行状态算「工作中」：头像动起来，固定表情也让位给 working。 */
export const BUSY_FACES = new Set(["thinking", "working", "alerting"]);

export const lookOf = (bot) => ({ ...FALLBACK, ...(bot?.avatar || {}) });
const hexOf = (color) => MASCOT_COLORS[color] || (/^#[0-9a-f]{6}$/i.test(color) ? color : MASCOT_COLORS.green);
/** 名字等文字用的颜色。 */
export const colorOf = (bot) => hexOf(lookOf(bot).color);

/** 运行状态到表情。用户固定了表情时，只在工作中换成 working。 */
export function faceFor(look, runFace = "idle") {
  if (!look.expression) return runFace || "idle";
  return BUSY_FACES.has(runFace) ? "working" : look.expression;
}

function mascot(look, size, face, animate) {
  const node = document.createElement("omp-mascot");
  node.setAttribute("body", look.body);
  node.setAttribute("color", look.color);
  node.setAttribute("size", String(size));
  node.setAttribute("state", face);
  if (size < SMALL) node.setAttribute("fps", "30");
  if (!animate) node.setAttribute("paused", "");
  return node;
}

function picture(look, onError) {
  const frame = el("span", "omp-avatar-pic");
  frame.style.borderRadius = CROP_RADIUS[look.crop] ?? "50%";
  const img = el("img");
  img.alt = "";
  img.draggable = false;
  img.decoding = "async";
  const origin = `${look.focusX * 100}% ${look.focusY * 100}%`;
  Object.assign(img.style, { objectPosition: origin, transformOrigin: origin, transform: look.zoom === 1 ? "" : `scale(${look.zoom})` });
  img.addEventListener("error", onError, { once: true });
  img.src = look.url;
  frame.append(img);
  return frame;
}

/**
 * 头像节点。图片头像不动；吉祥物按 face 显示表情，animate 为假时静止。
 * 图片加载失败（例如附件被删）时退回吉祥物。
 */
export function avatarNode(bot, { size = 36, face = "idle", animate = false } = {}) {
  const look = lookOf(bot);
  const wrap = el("span", "bt-mark omp-avatar");
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  wrap.setAttribute("aria-hidden", "true");
  if (look.crop !== "mascot" && look.url) {
    wrap.append(picture(look, () => wrap.replaceChildren(mascot(look, size, faceFor(look, face), animate))));
  } else {
    wrap.append(mascot(look, size, faceFor(look, face), animate));
  }
  return wrap;
}

/** 已经画出来的头像跟着运行状态换表情、动或停，不重建节点，动画不断。 */
export function updateAvatar(node, bot, { face = "idle", animate = false } = {}) {
  const m = node.querySelector("omp-mascot");
  if (!m) return;
  const next = faceFor(lookOf(bot), face);
  if (m.getAttribute("state") !== next) m.setAttribute("state", next);
  if (m.hasAttribute("paused") === animate) m.toggleAttribute("paused", !animate);
}

async function readBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function choiceGroup(label, hint) {
  const group = el("div", "field omp-avatar-group");
  const title = el("div", "omp-avatar-legend", label);
  title.id = `omp-avatar-legend-${Math.random().toString(36).slice(2, 9)}`;
  const row = el("div", "omp-avatar-choices");
  row.setAttribute("role", "group");
  row.setAttribute("aria-labelledby", title.id);
  group.append(title, row);
  if (hint) group.append(el("div", "hint", hint));
  return { group, row };
}

function choice(row, key, label, selected, onPick, content) {
  const node = button("omp-avatar-choice", null, onPick);
  node.dataset.key = key;
  node.type = "button";
  node.setAttribute("aria-label", label);
  node.setAttribute("aria-pressed", String(selected));
  node.title = label;
  if (content) node.append(content);
  else node.textContent = label;
  row.append(node);
  return node;
}

/**
 * 头像编辑：身体、颜色、表情、上传图片、裁切和缩放。拖动预览里的图片换焦点，滚轮缩放。
 * 改动先停在草稿里，点「保存形象」才提交 { avatar }。主助手的形象固定，不给编辑。
 */
export function avatarEditor(bot, { onSave }) {
  const root = el("div", "omp-avatar-editor");
  if (bot.isMain) {
    root.append(el("p", "hint", "主助手的形象是固定的，好让你一眼认出它。"));
    return root;
  }
  const saved = lookOf(bot);
  let draft = { ...saved };
  const stage = el("div", "omp-avatar-stage");
  const body = choiceGroup("身体");
  const color = choiceGroup("颜色");
  const face = choiceGroup("表情", "选「跟着状态」时会随思考、干活、等你处理、出错和完成变化；固定表情只在工作中换成干活的样子。");
  const pic = choiceGroup("图片", "PNG、JPEG、GIF 或 WebP，不超过 12MB。拖动预览里的图片调整位置，滚轮缩放。");
  const crop = choiceGroup("裁切");
  const zoomWrap = el("div", "field omp-avatar-group");
  const zoomLabel = el("label", "omp-avatar-legend", "缩放");
  const zoom = Object.assign(el("input"), { type: "range", min: "1", max: "3", step: "0.05" });
  zoom.id = `omp-avatar-zoom-${Math.random().toString(36).slice(2, 9)}`;
  zoomLabel.htmlFor = zoom.id;
  const zoomValue = el("span", "omp-avatar-zoom-value");
  const zoomRow = el("div", "omp-avatar-zoom");
  zoomRow.append(zoom, zoomValue);
  zoomWrap.append(zoomLabel, zoomRow);
  const file = Object.assign(el("input"), { type: "file", accept: IMAGE_TYPES.join(","), hidden: true });
  const save = button("btn primary", "保存形象", null);
  save.type = "button";
  const reset = button("btn ghost", "撤销改动", null);
  reset.type = "button";
  const actions = el("div", "omp-avatar-actions");
  actions.append(reset, save);
  root.append(stage, body.group, color.group, face.group, pic.group, crop.group, zoomWrap, file, actions);

  const isPicture = () => draft.crop !== "mascot" && !!draft.url;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // 缩放和拖动只重画预览；其他改动重画整个编辑区，并把焦点还给刚点的那个选项。
  const set = (patch, all = true) => {
    draft = { ...draft, ...patch };
    if (!all) { paintStage(); paintState(); return; }
    const key = root.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    paint();
    if (key) root.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
  };

  function paintStage() {
    stage.replaceChildren(avatarNode({ avatar: draft }, { size: 112, face: draft.expression || "idle", animate: true }));
    stage.classList.toggle("is-picture", isPicture());
  }
  function paintState() {
    zoom.value = String(draft.zoom);
    zoom.disabled = !isPicture();
    zoomValue.textContent = `${Math.round(draft.zoom * 100)}%`;
    const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
    save.disabled = !dirty;
    reset.disabled = !dirty;
  }
  function paint() {
    paintStage();
    // 用图片时身体和表情不起作用，先收起来；颜色还用在名字上，留着。
    body.group.hidden = isPicture();
    face.group.hidden = isPicture();
    body.row.replaceChildren();
    for (const id of MASCOT_BODY_IDS) {
      choice(body.row, `body:${id}`, BODY_NAMES[id] || id, draft.body === id, () => set({ body: id }),
        avatarNode({ avatar: { ...draft, body: id, crop: "mascot" } }, { size: 32 }));
    }
    color.row.replaceChildren();
    for (const id of MASCOT_COLOR_IDS) {
      const swatch = el("span", "omp-avatar-swatch");
      const [light, mid, dark] = gradientOf(id);
      swatch.style.background = `linear-gradient(225deg, ${light}, ${mid} 55%, ${dark})`;
      choice(color.row, `color:${id}`, COLOR_NAMES[id] || id, draft.color === id, () => set({ color: id }), swatch);
    }
    face.row.replaceChildren();
    choice(face.row, "face:auto", "跟着状态", !draft.expression, () => set({ expression: null }), el("span", "omp-avatar-auto", "跟着状态"));
    for (const id of MASCOT_EXPRESSIONS) {
      choice(face.row, `face:${id}`, EXPRESSION_NAMES[id] || id, draft.expression === id, () => set({ expression: id }),
        avatarNode({ avatar: { ...draft, crop: "mascot", expression: id } }, { size: 32 }));
    }
    pic.row.replaceChildren();
    const upload = button("btn ghost", draft.url ? "换一张图片" : "上传图片", () => file.click());
    upload.type = "button";
    pic.row.append(upload);
    if (draft.url) {
      const drop = button("btn ghost", "去掉图片", () => set({ url: null, crop: "mascot", zoom: 1, focusX: 0.5, focusY: 0.5 }));
      drop.type = "button";
      pic.row.append(drop);
    }
    crop.row.replaceChildren();
    for (const id of Object.keys(CROP_NAMES)) {
      const node = choice(crop.row, `crop:${id}`, CROP_NAMES[id], draft.crop === id, () => set({ crop: id }));
      node.classList.add("omp-avatar-text");
      if (id !== "mascot" && !draft.url) { node.disabled = true; node.title = "先上传一张图片"; }
    }
    paintState();
  }

  zoom.addEventListener("input", () => set({ zoom: Math.round(Number(zoom.value) * 100) / 100 }, false));
  stage.addEventListener("wheel", (event) => {
    if (!isPicture()) return;
    event.preventDefault();
    set({ zoom: Math.round(clamp(draft.zoom + (event.deltaY < 0 ? 0.08 : -0.08), 1, 3) * 100) / 100 }, false);
  }, { passive: false });
  let drag = null;
  stage.addEventListener("pointerdown", (event) => {
    if (!isPicture() || event.button !== 0) return;
    stage.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, focusX: draft.focusX, focusY: draft.focusY, id: event.pointerId };
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const span = 112 * draft.zoom;
    set({
      focusX: Math.round(clamp(drag.focusX - (event.clientX - drag.x) / span, 0, 1) * 1000) / 1000,
      focusY: Math.round(clamp(drag.focusY - (event.clientY - drag.y) / span, 0, 1) * 1000) / 1000,
    }, false);
  });
  const endDrag = () => { drag = null; };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  file.addEventListener("change", async () => {
    const picked = file.files?.[0];
    file.value = "";
    if (!picked) return;
    if (!IMAGE_TYPES.includes(picked.type)) { toast("头像只支持 PNG、JPEG、GIF 和 WebP 图片", true); return; }
    if (picked.size > MAX_IMAGE_BYTES) { toast(`图片超过 ${fmtSize(MAX_IMAGE_BYTES)} 上限`, true); return; }
    try {
      const created = await api("/api/attachments", {
        method: "POST",
        body: { botId: bot.id, filename: picked.name || "avatar", mime: picked.type, dataBase64: await readBase64(picked) },
      });
      const attachment = created.attachment || created;
      set({ url: `/api/attachments/${encodeURIComponent(attachment.id)}/preview`, crop: draft.crop === "mascot" ? "circle" : draft.crop, zoom: 1, focusX: 0.5, focusY: 0.5 });
    } catch (error) {
      toast(`图片上传失败：${error.message}`, true);
    }
  });
  reset.onclick = () => { draft = { ...saved }; paint(); };
  // 预览也能用键盘挪图片：方向键和拖动一样，往哪边按图片往哪边走，每次 5%。
  stage.tabIndex = 0;
  stage.setAttribute("role", "img");
  stage.setAttribute("aria-label", "头像预览。有图片时可以用方向键挪位置");
  stage.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!step || !isPicture()) return;
    event.preventDefault();
    set({ focusX: clamp(Math.round((draft.focusX - step[0] * 0.05) * 1000) / 1000, 0, 1), focusY: clamp(Math.round((draft.focusY - step[1] * 0.05) * 1000) / 1000, 0, 1) }, false);
  });
  save.onclick = async () => {
    save.disabled = true;
    save.textContent = "保存中…";
    try {
      await onSave({ avatar: { ...draft } });
    } catch (error) {
      toast(error.message, true);
      save.textContent = "保存形象";
      save.disabled = false;
    }
  };
  paint();
  return root;
}
