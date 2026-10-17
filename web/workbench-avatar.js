/*
 * Bot 头像：Notion 风格的捏脸（vendor/notion-avatar，来源和 CC0 许可见那里的 NOTICE），或者裁切好的上传图片。
 * 形象存在花名册的 bot.avatar 里，取值规则以服务端 src/domain.mjs 为准，这里只负责画和编辑。
 */
import { PARTS } from "./vendor/notion-avatar/parts.js";
import { el, button, toast, api, fmtSize } from "./workbench-core.js";

/** 叠放顺序和服务端 NOTION_PARTS 一致。 */
export const PART_IDS = Object.keys(PARTS);
export const PART_NAMES = {
  face: "脸型", nose: "鼻子", mouth: "嘴巴", eyes: "眼睛", eyebrows: "眉毛",
  glasses: "眼镜", hair: "发型", accessories: "配饰", details: "细节", beard: "胡子",
};
/** 这几种的 0 号是空白。 */
const SPARSE = new Set(["glasses", "accessories", "details", "beard"]);
export const AVATAR_COLORS = {
  green: "#009957", blue: "#377FE6", red: "#D94B52", orange: "#E78531", purple: "#8057C8",
  cyan: "#0EA5C6", pink: "#D84F8B", yellow: "#D8A729", teal: "#01A492", coral: "#E5634E",
};
export const AVATAR_COLOR_IDS = Object.keys(AVATAR_COLORS);
export const MAIN_AVATAR_COLOR = "#4D6BFE";
export const COLOR_NAMES = {
  green: "绿", blue: "蓝", red: "红", orange: "橙", purple: "紫",
  cyan: "青", pink: "粉", yellow: "黄", teal: "松石绿", coral: "珊瑚",
};
export const CROP_NAMES = { notion: "捏的脸", circle: "圆形", rounded: "圆角", square: "方形" };
const CROP_RADIUS = { circle: "50%", rounded: "22%", square: "0" };
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const FALLBACK_PARTS = Object.fromEntries(PART_IDS.map((id) => [id, 0]));
const FALLBACK = { parts: FALLBACK_PARTS, color: "green", crop: "notion", url: null, zoom: 1, focusX: 0.5, focusY: 0.5 };
/** 这几个运行状态算「工作中」。 */
export const BUSY_FACES = new Set(["thinking", "working", "alerting"]);

export const lookOf = (bot) => {
  const look = { ...FALLBACK, ...(bot?.avatar || {}) };
  return { ...look, parts: { ...FALLBACK_PARTS, ...(look.parts || {}) } };
};
const hexOf = (color) => AVATAR_COLORS[color] || (/^#[0-9a-f]{6}$/i.test(color) ? color : AVATAR_COLORS.green);
/** 名字等文字用的颜色。 */
export const colorOf = (bot) => hexOf(lookOf(bot).color);

function mix(hex, toward, t) {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(toward.slice(1), 16);
  const ch = (s) => Math.round(((a >> s) & 255) + ((((b >> s) & 255) - ((a >> s) & 255)) * t));
  return `#${[ch(16), ch(8), ch(0)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
/** 头像底色：助手颜色调淡，黑色线条在上面看得清。 */
export const tintOf = (color) => mix(hexOf(color), "#ffffff", 0.62);

/** 随机捏一张脸：空白部件大多不带，和服务端的默认分布一样。 */
export function randomParts() {
  const pick = (n) => Math.floor(Math.random() * n);
  return Object.fromEntries(PART_IDS.map((id) => {
    const n = PARTS[id].length;
    return [id, SPARSE.has(id) ? (Math.random() < 0.7 ? 0 : 1 + pick(n - 1)) : pick(n)];
  }));
}

// 白色描边滤镜和上游一样：线条外面一圈白，放在彩色底上不糊。
const FILTER = '<defs><filter id="f" x="-20%" y="-20%" width="140%" height="140%" filterUnits="objectBoundingBox" primitiveUnits="userSpaceOnUse" color-interpolation-filters="linearRGB"><feMorphology operator="dilate" radius="20 20" in="SourceAlpha" result="m"/><feFlood flood-color="#fff" result="w"/><feComposite in="w" in2="m" operator="in" result="c"/><feMerge><feMergeNode in="c"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>';
const faceCache = new Map();

/** 一张脸的图片地址。每张脸画成独立的 SVG 图片：一页几十个头像也不会让 id 和滤镜互相串。 */
export function faceUrl(parts) {
  const key = PART_IDS.map((id) => parts[id] ?? 0).join(".");
  let url = faceCache.get(key);
  if (!url) {
    const layers = PART_IDS.map((id) => {
      const svg = PARTS[id][parts[id]] ?? PARTS[id][0];
      return id === "face" ? `<g fill="#fff">${svg}</g>` : svg;
    }).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" fill="none">${FILTER}<g filter="url(#f)">${layers}</g></svg>`;
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    faceCache.set(key, url);
  }
  return url;
}

function face(look) {
  const frame = el("span", "omp-avatar-face");
  frame.style.background = tintOf(look.color);
  const img = el("img");
  img.alt = "";
  img.draggable = false;
  img.decoding = "async";
  img.src = faceUrl(look.parts);
  frame.append(img);
  return frame;
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

function mark(node, faceName, animate) {
  node.dataset.face = faceName || "idle";
  node.classList.toggle("is-moving", !!animate);
}

/**
 * 头像节点。animate 为真时轻轻晃动（在干活、有未读）；face 写在 data-face 上，样式按它区分工作中。
 * 图片加载失败（例如附件被删）时退回捏的脸。
 */
export function avatarNode(bot, { size = 36, face: faceName = "idle", animate = false } = {}) {
  const look = lookOf(bot);
  const wrap = el("span", "bt-mark omp-avatar");
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  wrap.setAttribute("aria-hidden", "true");
  if (look.crop !== "notion" && look.url) {
    wrap.append(picture(look, () => wrap.replaceChildren(face(look))));
  } else {
    wrap.append(face(look));
  }
  mark(wrap, faceName, animate);
  return wrap;
}

/** 已经画出来的头像跟着运行状态动或停，不重建节点。 */
export function updateAvatar(node, bot, { face: faceName = "idle", animate = false } = {}) {
  mark(node, faceName, animate);
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
 * 头像编辑：捏脸（每种部件左右翻、随机一张）、底色、上传图片、裁切和缩放。拖动预览里的图片换焦点，滚轮缩放。
 * 有 onSave 时改动先停在草稿里，点「保存形象」才提交 { avatar }。
 * 新建助手时传 onChange：每次改动都交出草稿，没有保存按钮；助手还不存在，不能传图片。
 */
export function avatarEditor(bot, { onSave, onChange } = {}) {
  const root = el("div", "omp-avatar-editor");
  const creating = !onSave;
  const saved = lookOf(bot);
  let draft = { ...saved };
  const stage = el("div", "omp-avatar-stage");
  const shuffle = button("btn ghost", "随机一张", () => set({ parts: randomParts() }));
  shuffle.type = "button";
  const stageRow = el("div", "omp-avatar-stage-row");
  stageRow.append(stage, shuffle);
  const partsGroup = choiceGroup("捏脸", "每一项左右翻着挑。");
  partsGroup.row.classList.add("omp-avatar-parts");
  const color = choiceGroup("底色", "名字也用这个颜色。");
  const pic = choiceGroup("图片", "PNG、JPEG、GIF 或 WebP，不超过 12MB。拖动预览里的图片调整位置，滚轮缩放。");
  const crop = choiceGroup("用哪个");
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
  root.append(stageRow, partsGroup.group, color.group);
  if (!creating) root.append(pic.group, crop.group, zoomWrap, file, actions);

  const isPicture = () => draft.crop !== "notion" && !!draft.url;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // 缩放和拖动只重画预览；其他改动重画整个编辑区，并把焦点还给刚点的那个按钮。
  const set = (patch, all = true) => {
    draft = { ...draft, ...patch };
    onChange?.({ ...draft });
    if (!all) { paintStage(); paintState(); return; }
    const key = root.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    paint();
    if (key) root.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
  };
  const step = (id, by) => {
    const n = PARTS[id].length;
    set({ parts: { ...draft.parts, [id]: (draft.parts[id] + by + n) % n } });
  };

  function paintStage() {
    stage.replaceChildren(avatarNode({ avatar: draft }, { size: 112 }));
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
    // 用图片时捏脸不起作用，先收起来；底色还用在名字上，留着。
    partsGroup.group.hidden = isPicture();
    shuffle.hidden = isPicture();
    partsGroup.row.replaceChildren();
    for (const id of PART_IDS) {
      const n = PARTS[id].length;
      const at = draft.parts[id];
      const line = el("div", "omp-avatar-part");
      const name = PART_NAMES[id] || id;
      const prev = button("omp-avatar-step", "‹", () => step(id, -1));
      const next = button("omp-avatar-step", "›", () => step(id, 1));
      Object.assign(prev, { type: "button", title: `上一个${name}` });
      Object.assign(next, { type: "button", title: `下一个${name}` });
      prev.dataset.key = `part:${id}:prev`;
      next.dataset.key = `part:${id}:next`;
      prev.setAttribute("aria-label", `上一个${name}`);
      next.setAttribute("aria-label", `下一个${name}`);
      const value = el("span", "omp-avatar-part-value", SPARSE.has(id) && at === 0 ? "不要" : `${SPARSE.has(id) ? at : at + 1}/${SPARSE.has(id) ? n - 1 : n}`);
      line.append(el("span", "omp-avatar-part-name", name), prev, value, next);
      partsGroup.row.append(line);
    }
    color.row.replaceChildren();
    const colors = bot?.isMain ? [MAIN_AVATAR_COLOR, ...AVATAR_COLOR_IDS] : AVATAR_COLOR_IDS;
    for (const id of colors) {
      const swatch = el("span", "omp-avatar-swatch");
      swatch.style.background = tintOf(id);
      swatch.style.boxShadow = `inset 0 0 0 3px ${hexOf(id)}`;
      const label = id === MAIN_AVATAR_COLOR ? "主助手蓝" : COLOR_NAMES[id] || id;
      choice(color.row, `color:${id}`, label, draft.color === id, () => set({ color: id }), swatch);
    }
    if (creating) { paintState(); return; }
    pic.row.replaceChildren();
    const upload = button("btn ghost", draft.url ? "换一张图片" : "上传图片", () => file.click());
    upload.type = "button";
    pic.row.append(upload);
    if (draft.url) {
      const drop = button("btn ghost", "去掉图片", () => set({ url: null, crop: "notion", zoom: 1, focusX: 0.5, focusY: 0.5 }));
      drop.type = "button";
      pic.row.append(drop);
    }
    crop.row.replaceChildren();
    for (const id of Object.keys(CROP_NAMES)) {
      const node = choice(crop.row, `crop:${id}`, CROP_NAMES[id], draft.crop === id, () => set({ crop: id }));
      node.classList.add("omp-avatar-text");
      if (id !== "notion" && !draft.url) { node.disabled = true; node.title = "先上传一张图片"; }
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
      set({ url: `/api/attachments/${encodeURIComponent(attachment.id)}/preview`, crop: draft.crop === "notion" ? "circle" : draft.crop, zoom: 1, focusX: 0.5, focusY: 0.5 });
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
