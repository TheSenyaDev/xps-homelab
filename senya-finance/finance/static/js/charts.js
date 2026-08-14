// Charts built from DOM, CSS and inline SVG — no charting library, so there is
// nothing to keep up to date and nothing external for a CSP to allow.
import { el, money, moneyShort, monthLabel, dateLabel } from "./dom.js";

const FALLBACK = "var(--accent)";

// Horizontal bar list: items = [{label, amount, color, sub, onClick?}]
export function barList(items, { max: forcedMax } = {}) {
  if (!items.length) return el("div", { class: "empty", text: "No data." });
  const max = forcedMax || Math.max(...items.map((i) => i.amount), 1);
  const wrap = el("div", { class: "barlist" });
  for (const it of items) {
    const fill = el("span", { style: { width: `${(it.amount / max) * 100}%`, background: it.color || FALLBACK } });
    const row = el("div", { class: "barrow" + (it.onClick ? " clickable" : ""), title: it.sub || "" },
      el("div", { class: "head" },
        el("span", { class: "nm" },
          el("span", { class: "dot", style: { background: it.color || FALLBACK } }),
          el("span", { text: it.label })),
        el("span", { class: "amount", text: money(it.amount) })),
      el("div", { class: "bar" }, fill));
    if (it.onClick) row.addEventListener("click", it.onClick);
    wrap.append(row);
  }
  return wrap;
}

// Donut + clickable legend. items = [{label, amount, color, onClick?}].
// A conic-gradient rather than SVG arcs: the slices are just colour stops, so
// there is no path maths to get subtly wrong at the wrap-around point.
export function donut(items, { centerLabel = "Total" } = {}) {
  const shown = items.filter((i) => i.amount > 0);
  if (!shown.length) return el("div", { class: "empty", text: "No spending this month." });

  const total = shown.reduce((s, i) => s + i.amount, 0);
  let at = 0;
  const stops = shown.map((it) => {
    const start = (at / total) * 360;
    at += it.amount;
    const end = (at / total) * 360;
    return `${it.color || FALLBACK} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`;
  });

  const ring = el("div", { class: "ring", style: { background: `conic-gradient(${stops.join(",")})` } });
  const chart = el("div", { class: "donut" }, ring,
    el("div", { class: "hole" },
      el("div", {},
        el("div", { class: "big", text: moneyShort(total) }),
        el("div", { class: "cap", text: centerLabel }))));

  const legend = el("div", { class: "legend-list" },
    ...shown.map((it) => {
      const row = el("div", { class: "legend-row" },
        el("span", { class: "dot", style: { background: it.color || FALLBACK } }),
        el("span", { class: "nm", text: it.label }),
        el("span", { class: "amount", text: money(it.amount) }),
        el("span", { class: "pct", text: `${Math.round((it.amount / total) * 100)}%` }));
      if (it.onClick) row.addEventListener("click", it.onClick);
      return row;
    }));

  return el("div", { class: "donut-wrap" }, chart, legend);
}

// Tiny trend line for the back of a stat tile. values = [number, …].
// Under four points there is no shape to read — two months of history drawn as
// a line reads as a trend that isn't there — so it draws nothing instead.
export function sparkline(values, { color = "var(--accent)" } = {}) {
  if (values.length < 4) return null;
  const max = Math.max(...values, 1);
  const w = 100, h = 30;
  const pts = values.map((v, i) => [
    (i / (values.length - 1)) * w,
    h - (v / max) * (h - 3) - 1.5,
  ]);
  const line = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `0,${h} ${line} ${w},${h}`;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const fill = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  fill.setAttribute("points", area);
  fill.setAttribute("fill", color);
  fill.setAttribute("opacity", "0.16");
  const stroke = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  stroke.setAttribute("points", line);
  stroke.setAttribute("fill", "none");
  stroke.setAttribute("stroke", color);
  stroke.setAttribute("stroke-width", "1.6");
  stroke.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(fill, stroke);
  return svg;
}

// One column per day of the month. days = [{date, amount}] (zeros included).
export function dailyBars(days, onPick) {
  if (!days.length) return el("div", { class: "empty", text: "No data." });
  const max = Math.max(...days.map((d) => d.amount), 1);
  const chart = el("div", { class: "daily" });
  for (const d of days) {
    const weekend = [0, 6].includes(new Date(d.date + "T12:00:00").getDay());
    const bar = el("div", {
      class: "d" + (d.amount ? (weekend ? " weekend" : "") : " zero"),
      style: { height: `${Math.max((d.amount / max) * 100, 2)}%` },
      title: `${dateLabel(d.date)}: ${money(d.amount)}`,
    });
    if (onPick) { bar.style.cursor = "pointer"; bar.addEventListener("click", () => onPick(d)); }
    chart.append(bar);
  }
  const last = days[days.length - 1].date.slice(8);
  return el("div", {}, chart,
    el("div", { class: "daily-axis" },
      el("span", { text: "1" }),
      el("span", { text: String(Math.ceil(days.length / 2)) }),
      el("span", { text: last })));
}

// Two-series monthly bars: this year solid, last year faint behind it.
export function comparisonTrend(data, onPick) {
  if (!data.length) return el("div", { class: "empty", text: "No history yet." });
  const max = Math.max(...data.flatMap((d) => [d.spending, d.prev_spending]), 1);
  const chart = el("div", { class: "trend compare" });
  for (const d of data) {
    const cur = el("div", { class: "stack", style: { height: `${Math.max((d.spending / max) * 100, 1)}%` } });
    const prev = el("div", { class: "stack prev", style: { height: `${Math.max((d.prev_spending / max) * 100, 1)}%` } });
    const delta = d.prev_spending > 0 ? (d.spending - d.prev_spending) / d.prev_spending : null;
    const col = el("div", {
      class: "col",
      title: `${monthLabel(d.month)}: ${money(d.spending)}`
        + (d.prev_spending ? ` · last year ${money(d.prev_spending)}`
          + (delta === null ? "" : ` (${delta >= 0 ? "+" : ""}${Math.round(delta * 100)}%)`) : ""),
    },
      el("div", { class: "pair" }, prev, cur),
      el("div", { class: "ml", text: d.month.slice(5) }));
    if (onPick) { col.style.cursor = "pointer"; col.addEventListener("click", () => onPick(d.month)); }
    chart.append(col);
  }
  return chart;
}

// Monthly spending trend: data = [{month, spending}], optional active month + click.
export function monthlyTrend(data, activeMonth, onPick) {
  if (!data.length) return el("div", { class: "empty", text: "No history yet." });
  const max = Math.max(...data.map((d) => d.spending), 1);
  const chart = el("div", { class: "trend" });
  for (const d of data) {
    const stack = el("div", {
      class: "stack",
      style: { height: `${Math.max((d.spending / max) * 100, 1)}%` },
      title: `${monthLabel(d.month)}: ${money(d.spending)}`,
    });
    const col = el("div", { class: "col" + (d.month === activeMonth ? " active" : "") },
      stack, el("div", { class: "ml", text: d.month.slice(5) + "/" + d.month.slice(2, 4) }));
    if (onPick) { col.style.cursor = "pointer"; col.addEventListener("click", () => onPick(d.month)); }
    chart.append(col);
  }
  return chart;
}

// Budget progress bar with a pace marker. Colour follows how close to the limit
// it is, so a row that needs attention is obvious without reading the numbers.
export function progressTrack(spent, budget, pace, color) {
  const ratio = budget ? spent / budget : 0;
  const over = spent > budget;
  const fillColor = over ? "var(--bad)" : ratio > 0.85 ? "var(--warn)" : (color || FALLBACK);
  const fill = el("span", {
    class: "fill" + (over ? " over" : ""),
    style: { width: `${Math.min(ratio * 100, 100)}%`, background: fillColor },
  });
  const track = el("div", { class: "budget-track" }, fill);
  if (pace != null && budget && pace < budget) {
    track.append(el("span", {
      class: "pace",
      style: { left: `${(pace / budget) * 100}%` },
      title: `Even pace to date: ${money(pace)}`,
    }));
  }
  return track;
}
