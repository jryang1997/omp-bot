/*
 * Shared workbench primitives: DOM helpers, same-origin auth bootstrap, JSON API,
 * sanitized markdown, focus containment, status announcements and downloads.
 * Used by app.js and the workbench-* modules so there is one HTTP/auth path.
 */
import { marked } from "./vendor/marked/marked.esm.js";
import DOMPurify from "./vendor/dompurify/purify.es.js";

export const $ = (id) => document.getElementById(id);

export const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

export const svgIcon = (paths, viewBox = "0 0 24 24", attrs = {}) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("viewBox", viewBox);
  for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
};

export const button = (cls, text, onClick) => {
  const node = el("button", cls, text);
  node.type = "button";
  if (onClick) node.onclick = onClick;
  return node;
};

export function toast(message, isError = false) {
  const node = el("div", "toast" + (isError ? " err" : ""), message);
  if (isError) node.setAttribute("role", "alert");
  $("toast-wrap").append(node);
  setTimeout(() => node.remove(), isError ? 6000 : 3000);
}

/** Polite screen-reader announcement, separate from transient toasts. */
export function announce(message) {
  const region = $("sr-status");
  if (!region) return;
  region.textContent = "";
  queueMicrotask(() => { region.textContent = message; });
}

let bootstrapPromise = null;
/** Exchange a launch fragment token for the same-origin session cookie, once. */
export function bootstrapAuth() {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    const token = location.hash.startsWith("#") ? location.hash.slice(1) : "";
    if (!token) return;
    const res = await fetch("/api/session/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}",
    });
    if (!res.ok) throw new Error(`会话引导失败（${res.status}）`);
    history.replaceState(null, "", location.pathname + location.search);
  })();
  return bootstrapPromise;
}

export async function api(path, opts = {}) {
  const { method = "GET", body, headers } = opts;
  const init = { method, credentials: "same-origin", headers: { ...headers } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `${res.status} ${res.statusText}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

/** GET helper that returns null instead of throwing when an endpoint is absent. */
export async function apiOptional(path) {
  try { return await api(path); }
  catch (error) {
    if (error.status === 404 || error.status === 501) return null;
    throw error;
  }
}

const sanitizeOptions = {
  RETURN_DOM_FRAGMENT: true,
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "form", "button", "input", "textarea", "select", "iframe", "object", "embed"],
  FORBID_ATTR: ["style", "id", "name", "class"],
  ALLOW_DATA_ATTR: false,
};

export function markdownFragment(text) {
  return DOMPurify.sanitize(marked.parse(String(text ?? ""), { breaks: true }), sanitizeOptions);
}

/** Replace a node's children with sanitized markdown; returns the node. */
export function renderMarkdown(node, text) {
  node.replaceChildren(markdownFragment(text));
  for (const link of node.querySelectorAll("a[href]")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  return node;
}

export function downloadText(filename, text, mime = "text/markdown;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = el("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const RUN_STATES = {
  queued: "排队中",
  starting: "启动中",
  running: "执行中",
  waiting_input: "等待输入",
  waiting_approval: "待审批",
  cancelling: "取消中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  reconciliation_required: "需人工对账",
};
export const runStateLabel = (state) => RUN_STATES[state] || state || "未知";
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "interrupted", "reconciliation_required"]);
export const isLiveRun = (state) => !!state && !TERMINAL_STATES.has(state);

export function fmtTime(at) {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "";
}
export function fmtClock(at) {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : "";
}
export function fmtSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
export function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.floor(n / 60000)}m${Math.round((n % 60000) / 1000)}s`;
}

/** Tab containment for a modal region. Call from a keydown handler; returns true if handled. */
export function trapTab(event, container) {
  if (event.key !== "Tab") return false;
  const controls = [...container.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')]
    .filter((node) => !node.disabled && node.getClientRects().length);
  const first = controls[0];
  const last = controls.at(-1);
  const active = document.activeElement;
  if (!first) { event.preventDefault(); container.focus(); return true; }
  if (event.shiftKey && (active === first || active === container || !container.contains(active))) {
    event.preventDefault(); last.focus(); return true;
  }
  if (!event.shiftKey && (active === last || active === container || !container.contains(active))) {
    event.preventDefault(); first.focus(); return true;
  }
  return false;
}
