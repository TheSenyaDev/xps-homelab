// DOM helpers. No framework here and none needed; what is needed is for element
// creation to look the same everywhere so no component invents its own.

export const $ = (id) => document.getElementById(id);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** el("span", {class: "x", text: "hi", onclick: fn}, child, …) */
export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k === "class") n.className = v;
    else if (k === "dataset") Object.assign(n.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") n[k.toLowerCase()] = v;
    else if (v === true) n.setAttribute(k, "");
    else n.setAttribute(k, v);
  }
  n.append(...kids.filter((k) => k != null));
  return n;
}
