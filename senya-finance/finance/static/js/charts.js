// Dependency-free charts built from DOM/CSS (no external libs → CSP-friendly).
import { el, money, monthLabel } from "./dom.js";

// Horizontal bar list: items = [{label, amount, color, onClick?}]
export function barList(items) {
  if (!items.length) return el("div", { class: "empty", text: "No data." });
  const max = Math.max(...items.map((i) => i.amount), 1);
  const wrap = el("div", { class: "barlist" });
  for (const it of items) {
    const fill = el("span");
    fill.style.width = (it.amount / max) * 100 + "%";
    fill.style.background = it.color || "var(--accent)";
    const head = el("div", { class: "head" },
      el("span", { class: "nm" },
        el("span", { class: "dot", style: `background:${it.color || "var(--accent)"}` }),
        it.label),
      el("span", { class: "amount", text: money(it.amount) }));
    const row = el("div", { class: "barrow" }, head, el("div", { class: "bar" }, fill));
    if (it.onClick) { row.style.cursor = "pointer"; row.addEventListener("click", it.onClick); }
    wrap.append(row);
  }
  return wrap;
}

// Monthly spending trend: data = [{month, spending}], optional active month + click.
export function monthlyTrend(data, activeMonth, onPick) {
  if (!data.length) return el("div", { class: "empty", text: "No history yet." });
  const max = Math.max(...data.map((d) => d.spending), 1);
  const chart = el("div", { class: "trend" });
  for (const d of data) {
    const stack = el("div", { class: "stack", title: `${monthLabel(d.month)}: ${money(d.spending)}` });
    stack.style.height = Math.max((d.spending / max) * 100, 1) + "%";
    const col = el("div", { class: "col" + (d.month === activeMonth ? " active" : "") },
      stack, el("div", { class: "ml", text: d.month.slice(5) + "/" + d.month.slice(2, 4) }));
    if (onPick) { col.style.cursor = "pointer"; col.addEventListener("click", () => onPick(d.month)); }
    chart.append(col);
  }
  return chart;
}
