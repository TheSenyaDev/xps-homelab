// DOM helpers. Deliberately tiny — this app has no framework and does not need
// one; what it needs is for element creation and escaping to look the same
// everywhere so no component invents its own.

export const $ = (id) => document.getElementById(id);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** el("div", {class: "x", text: "hi"}, child, …) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "class") node.className = v;
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

/** Escape for the few places that still build HTML strings. */
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function safeJson(s, fallback = {}) {
  try {
    const v = JSON.parse(s || "null");
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function safeList(s) {
  const v = safeJson(s, []);
  return Array.isArray(v) ? v : [];
}
