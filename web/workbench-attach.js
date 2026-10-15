/*
 * Attachments (clipboard/drop/file → base64) and generated artifacts.
 * Files cross the trust boundary here: mime, size and previews are taken from the
 * server record, never from the raw File guess, and failures surface instead of faking success.
 */
import { el, button, toast, api, apiOptional, fmtSize, fmtTime, downloadText } from "./workbench-core.js";

const MAX_BYTES = 12 * 1024 * 1024;

export function createAttachmentTray() {
  const drafts = new Map(); // botId -> attachment records
  let botId = null;
  let imageCheck = null;
  let picker = null;

  function attachments(id = botId) {
    if (!drafts.has(id)) drafts.set(id, new Map());
    return drafts.get(id);
  }

  function setBot(id) {
    botId = id;
    render();
  }

  async function readBase64(file) {
    const buffer = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(binary);
  }

  async function upload(file) {
    const owner = botId;
    if (!botId) { toast("先选择一个 Bot 再添加附件", true); return null; }
    if (file.size > MAX_BYTES) { toast(`附件超过 ${fmtSize(MAX_BYTES)} 上限`, true); return null; }
    if (String(file.type || "").startsWith("image/") && imageCheck) {
      const problem = imageCheck();
      if (problem) { toast(problem, true); return null; }
    }
    try {
      const dataBase64 = await readBase64(file);
      const created = await api("/api/attachments", {
        method: "POST",
        body: { botId: owner, filename: file.name || "clipboard", mime: file.type || "application/octet-stream", dataBase64 },
      });
      const attachment = created.attachment || created;
      attachments(owner).set(attachment.id, attachment);
      render();
      return attachment;
    } catch (error) {
      toast(`附件上传失败：${error.message}`, true);
      return null;
    }
  }

  function addFiles(fileList) {
    const files = [...(fileList || [])];
    for (const file of files) void upload(file);
  }

  function chips() {
    return [...attachments().values()];
  }

  function ids() {
    return [...attachments().keys()];
  }

  function clear(owner = botId, sentIds = null) {
    const items = attachments(owner);
    if (sentIds) for (const id of sentIds) items.delete(id);
    else items.clear();
    render();
  }

  function remove(id) {
    attachments().delete(id);
    render();
  }

  let host = null;
  function render() {
    if (!host) return;
    const items = attachments();
    host.replaceChildren();
    host.classList.toggle("hidden", items.size === 0);
    for (const item of items.values()) {
      const chip = el("div", "wb-attach");
      chip.dataset.attachmentId = item.id;
      const isImage = String(item.mime || "").startsWith("image/");
      if (isImage) {
        const img = el("img", "bt-thumb wb-attach-thumb");
        img.src = `/api/attachments/${encodeURIComponent(item.id)}/preview`;
        img.alt = item.filename || "附件预览";
        img.onerror = () => img.replaceWith(el("span", "wb-attach-icon", "IMG"));
        chip.append(img);
      } else {
        chip.append(el("span", "wb-attach-icon", (item.filename || "file").split(".").pop().slice(0, 4).toUpperCase()));
      }
      const meta = el("div", "wb-attach-meta");
      meta.append(el("div", "wb-attach-name", item.filename || item.id));
      meta.append(el("div", "wb-attach-size", `${item.mime || "未知类型"} · ${fmtSize(item.size)}`));
      chip.append(meta);
      const del = button("bt-x", "×", () => {
        remove(item.id);
        void api(`/api/attachments/${encodeURIComponent(item.id)}`, { method: "DELETE" }).catch((error) => toast(`删除附件失败：${error.message}`, true));
      });
      del.setAttribute("aria-label", `移除附件 ${item.filename || item.id}`);
      chip.append(del);
      host.append(chip);
    }
  }

  function mount(hostEl, composerEl, inputEl, options = {}) {
    host = hostEl;
    if (options.imageCheck) imageCheck = options.imageCheck;
    if (!picker) {
      picker = el("input");
      picker.type = "file";
      picker.multiple = true;
      picker.hidden = true;
      picker.tabIndex = -1;
      picker.onchange = () => { addFiles(picker.files); picker.value = ""; };
      // Kept outside the tray host so render() can clear previews without dropping the picker.
      document.body.append(picker);
    }

    if (inputEl) {
      inputEl.addEventListener("paste", (event) => {
        const files = [...(event.clipboardData?.files || [])];
        if (!files.length) return;
        event.preventDefault();
        addFiles(files);
      });
    }
    if (composerEl) {
      let depth = 0;
      const stop = (event) => { event.preventDefault(); };
      composerEl.addEventListener("dragenter", (event) => { stop(event); depth += 1; composerEl.dataset.over = ""; });
      composerEl.addEventListener("dragover", stop);
      composerEl.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) delete composerEl.dataset.over; });
      composerEl.addEventListener("drop", (event) => {
        stop(event);
        depth = 0;
        delete composerEl.dataset.over;
        addFiles(event.dataTransfer?.files);
      });
    }
    return { picker, open: () => picker.click(), addFiles, ids, items: chips, clear, remove, render, setBot, upload };
  }

  return { mount, setBot, ids, items: chips, clear, upload, open: () => picker?.click() };
}

/** Read-only artifact index for one bot or run. */
export async function loadArtifacts({ botId, runId } = {}) {
  const query = new URLSearchParams();
  if (botId) query.set("botId", botId);
  if (runId) query.set("runId", runId);
  const data = await apiOptional(`/api/artifacts?${query}`);
  return data ? data.artifacts || [] : null;
}

export function artifactCard(artifact) {
  const card = el("div", "bt-connector wb-artifact");
  card.dataset.artifactId = artifact.id;
  const head = el("div", "bt-connector-head");
  head.append(el("span", "bt-connector-mark", "📄"));
  const text = el("div", "bt-connector-text");
  text.append(el("div", "bt-connector-name", artifact.name || artifact.relPath || artifact.path || "成果"));
  text.append(el("div", "bt-connector-status", [artifact.mime, fmtSize(artifact.size), fmtTime(artifact.createdAt)].filter(Boolean).join(" · ")));
  if (artifact.version > 1) {
    text.append(el("div", "bt-note", `第 ${artifact.version} 次登记：更早版本的内容可能已被覆盖，不能回退取回旧字节。`));
  }
  head.append(text);
  card.append(head);
  if (!artifact.id) return card;
  const actions = el("div", "bt-connector-actions");
  const link = el("a", "btn ghost", "下载");
  link.href = `/api/artifacts/${encodeURIComponent(artifact.id)}/download`;
  link.setAttribute("download", "");
  actions.append(link);
  actions.append(button("btn ghost", "预览", () => {
    const pane = card.querySelector(".wb-preview") || el("div", "wb-preview");
    if (!pane.isConnected) {
      const frame = el("iframe", "wb-preview-frame");
      frame.src = `/api/artifacts/${encodeURIComponent(artifact.id)}/preview`;
      frame.setAttribute("sandbox", "");
      frame.title = `${artifact.name || "成果"} 预览`;
      const fallback = el("div", "bt-note");
      const openLink = el("a", null, "在新标签打开预览");
      openLink.href = `/api/artifacts/${encodeURIComponent(artifact.id)}/preview`;
      openLink.target = "_blank";
      openLink.rel = "noopener noreferrer";
      fallback.append("预览被内嵌策略阻止时，可", openLink, "。");
      pane.append(frame, fallback, button("btn ghost", "关闭预览", () => pane.remove()));
      card.append(pane);
    }
  }));
  actions.append(button("btn ghost", "复制链接", async () => {
    try { await navigator.clipboard.writeText(new URL(link.href, location.href).href); toast("已复制下载链接"); }
    catch (error) { toast(`复制失败：${error.message}`, true); }
  }));
  card.append(actions);
  return card;
}

export function exportRunTranscript(run, messages = []) {
  const lines = [`# 运行 ${run.id}`, "", `- Bot: ${run.botId || "—"}`, `- 状态: ${run.state}`, `- 创建: ${fmtTime(run.createdAt)}`, `- 更新: ${fmtTime(run.updatedAt)}`, "", "## 请求", "", run.text || "", ""];
  if (run.reply) lines.push("## 回复", "", run.reply, "");
  if (run.error) lines.push("## 错误", "", String(run.error), "");
  if (messages.length) {
    lines.push("## 会话投影", "");
    for (const message of messages) lines.push(`- ${message.role || message.kind || "?"}: ${String(message.text || "").slice(0, 2000)}`);
    lines.push("");
  }
  downloadText(`run-${run.id}.md`, lines.join("\n"));
}
