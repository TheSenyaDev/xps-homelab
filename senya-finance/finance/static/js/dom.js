// Terse element builder + small formatting helpers shared by all views.
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

export const money = (n) =>
  (n < 0 ? "-" : "") + "$" + Math.abs(Number(n) || 0).toLocaleString(undefined,
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// "2026-05" -> "May 2026"
export function monthLabel(m) {
  if (!m) return "—";
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function toast(msg) {
  const t = el("div", { class: "toast", text: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}
