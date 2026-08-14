// Terse element builder + the formatting helpers every view shares.

export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    // Styles go through the CSSOM rather than a style="…" attribute, so an
    // object of properties works and a future CSP can drop 'unsafe-inline'
    // without silently blanking every chart bar.
    else if (k === "style") { if (typeof v === "string") n.style.cssText = v; else Object.assign(n.style, v); }
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

// replaceChildren() with conditional children dropped.
//
// The native call takes Nodes *or strings*, so a `cond ? panel : null` argument
// is stringified and renders a literal "null" on the page rather than nothing.
// `el()` already filters its children; this is the same guarantee for the
// top-level swap every view does.
export function replace(node, ...kids) {
  node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  return node;
}

export const money = (n) =>
  (n < 0 ? "-" : "") + "$" + Math.abs(Number(n) || 0).toLocaleString(undefined,
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Axis labels and chips, where two decimals of a four-figure number are noise.
export const moneyShort = (n) => {
  const v = Math.abs(Number(n) || 0);
  const sign = n < 0 ? "-" : "";
  if (v >= 10000) return `${sign}$${(v / 1000).toFixed(1)}k`;
  if (v >= 1000) return `${sign}$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `${sign}$${v.toFixed(v < 100 ? 2 : 0)}`;
};

export const pct = (n, digits = 0) =>
  n == null ? "—" : `${n > 0 ? "+" : ""}${Number(n).toFixed(digits)}%`;

// "2026-05" -> "May 2026"
export function monthLabel(m) {
  if (!m) return "—";
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// "2026-05" -> "May"  ·  "2026-05-04" -> "May 4"
export const monthShort = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: "short" });
};

export const dateLabel = (d) => {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

// Up/down chip. `goodWhenDown` because spending more is bad while earning more
// is good, and the colour has to follow the meaning rather than the sign.
export function changeChip(changePct, { goodWhenDown = true } = {}) {
  if (changePct == null) return el("span", { class: "chg new", text: "new" });
  const rounded = Math.round(changePct);
  if (rounded === 0) return el("span", { class: "chg flat", text: "0%" });
  const isBad = goodWhenDown ? rounded > 0 : rounded < 0;
  return el("span", { class: `chg ${isBad ? "bad" : "good"}`, text: pct(rounded) });
}

export function toast(msg) {
  document.querySelector(".toast")?.remove();
  const t = el("div", { class: "toast", text: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

// Placeholder in the shape of the real thing, so loading doesn't collapse the
// page and then push it back open.
export function skeleton({ cards = 0, panels = 1 } = {}) {
  const frag = document.createDocumentFragment();
  if (cards) {
    frag.append(el("div", { class: "cards" },
      ...Array.from({ length: cards }, () => el("div", { class: "skel skel-card" }))));
  }
  for (let i = 0; i < panels; i++) frag.append(el("div", { class: "skel skel-panel", style: "margin-bottom:16px" }));
  return frag;
}
