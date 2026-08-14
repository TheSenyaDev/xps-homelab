// Year view: how this year compares to the last one, month by month and
// category by category. The dashboard covers "this month" — this covers "is it
// getting worse?", which needs something to compare against.
import { api } from "../api.js";
import { el, money } from "../dom.js";
import { comparisonTrend } from "../charts.js";

const tile = (label, value, cls, sub) =>
  el("div", { class: "card" },
    el("div", { class: "label", text: label }),
    el("div", { class: `value ${cls || ""}`, text: value }),
    sub ? el("div", { class: "sub", text: sub }) : null);

// "+12.4%" / "−8.1%" with the colour meaning "is this good?" — for spending,
// up is bad; the caller says which way round it is.
function deltaTag(pct, upIsBad = true) {
  if (pct === null || pct === undefined) return el("span", { class: "chg new", text: "new" });
  const cls = pct === 0 ? "" : (pct > 0) === upIsBad ? "bad" : "good";
  return el("span", { class: `chg ${cls}`, text: `${pct > 0 ? "+" : ""}${pct}%` });
}

export async function renderTrends(root, ctx = {}) {
  root.replaceChildren(el("div", { class: "empty", text: "Loading…" }));
  const years = await api.get("/api/trends/years");
  if (!years.length) {
    root.replaceChildren(el("div", { class: "empty", text: "No transactions yet." }));
    return;
  }

  let year = years[0].year;
  const wrap = el("div");

  const picker = el("select", { onchange: (e) => { year = e.target.value; draw(); } },
    ...years.map((y) => el("option", { value: y.year, text: y.year })));

  root.replaceChildren(
    el("div", { class: "panel" },
      el("div", { class: "filters" },
        el("label", { class: "muted" }, "Year ", picker),
        el("span", { class: "spacer" })),
      wrap));
  await draw();

  async function draw() {
    wrap.replaceChildren(el("div", { class: "empty", text: "Loading…" }));
    const [monthly, cats] = await Promise.all([
      api.get(`/api/trends/monthly?year=${year}`),
      api.get(`/api/trends/by-category?year=${year}`),
    ]);

    const row = years.find((y) => y.year === year) || {};
    const prev = years.find((y) => Number(y.year) === Number(year) - 1);
    const spendPct = prev && prev.spending
      ? Math.round(((row.spending - prev.spending) / prev.spending) * 1000) / 10
      : null;

    const months = monthly.months || [];
    const withSpend = months.filter((m) => m.spending > 0);
    const avg = withSpend.length
      ? withSpend.reduce((s, m) => s + m.spending, 0) / withSpend.length : 0;
    const busiest = withSpend.reduce((a, b) => (b.spending > (a?.spending || 0) ? b : a), null);

    wrap.replaceChildren(
      el("div", { class: "cards" },
        tile("Spent in " + year, money(row.spending || 0), "spend",
          prev ? `vs ${money(prev.spending || 0)} in ${prev.year}` : null),
        tile("Income", money(row.income || 0), "income"),
        tile("Net", money(row.net || 0), (row.net || 0) >= 0 ? "net-pos" : "net-neg"),
        tile("Avg / month", money(avg), "spend",
          busiest ? `highest ${busiest.month.slice(5)} · ${money(busiest.spending)}` : null)),

      el("div", { class: "panel inner" },
        el("h2", {}, `Monthly spending · ${year} `,
          spendPct === null ? null : deltaTag(spendPct),
          el("span", { class: "legend" },
            el("span", { class: "key cur" }), " this year ",
            el("span", { class: "key prev" }), ` ${Number(year) - 1}`)),
        comparisonTrend(months)),

      el("div", { class: "panel inner" },
        el("h2", { text: `By category · ${year} vs ${Number(year) - 1}` }),
        categoryTable(cats.categories || [])));
  }
}

function categoryTable(rows) {
  if (!rows.length) return el("div", { class: "empty", text: "Nothing spent this year." });
  const max = Math.max(...rows.map((r) => r.amount), 1);
  const body = el("tbody");
  for (const r of rows) {
    const fill = el("span");
    fill.style.width = (r.amount / max) * 100 + "%";
    fill.style.background = r.color;
    body.append(el("tr", {},
      el("td", {},
        el("span", { class: "nm" }, el("span", { class: "dot", style: `background:${r.color}` }), r.category)),
      el("td", { class: "barcell" }, el("div", { class: "bar" }, fill)),
      el("td", { class: "amt", text: money(r.amount) }),
      el("td", { class: "amt muted", text: r.prev_amount ? money(r.prev_amount) : "—" }),
      el("td", { class: "amt" }, deltaTag(r.change_pct))));
  }
  return el("table", { class: "trend-table" },
    el("thead", {}, el("tr", {},
      el("th", { text: "Category" }), el("th", {}),
      el("th", { class: "amt", text: "This year" }),
      el("th", { class: "amt", text: "Last year" }),
      el("th", { class: "amt", text: "Change" }))),
    body);
}
