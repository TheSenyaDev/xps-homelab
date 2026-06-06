// Shared DOM + data helpers used across sections.

export const REL = "noopener noreferrer";
const DEFAULT_ICON = "icons/_default.svg";

// Terse element builder: el("div", { class: "x", text: "hi", onclick: fn }, child, …).
// Props: `class`, `text`, `html`, `title`, `on<event>` handlers, else setAttribute.
// Children may be nodes, strings, or arrays (flattened); null/undefined skipped.
export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

export function link(text, url, cls) {
  return el("a", { class: cls, href: url, target: "_blank", rel: REL, text });
}

// <img> for a local icon: icons/<slug>.png, falling back to the default on 404.
// The error handler is attached in JS (not inline) to satisfy the strict CSP.
export function iconImg(slug) {
  const img = el("img", {
    class: "ico", alt: "", loading: "lazy",
    src: slug ? `icons/${slug}.png` : DEFAULT_ICON,
  });
  img.addEventListener("error", function onErr() {
    img.removeEventListener("error", onErr); // avoid a loop if the default is missing
    img.src = DEFAULT_ICON;
  });
  return img;
}

export async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// localStorage that never throws (private mode / blocked storage / sandboxed
// iframe). A failure here previously took the whole page down with it.
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
};
