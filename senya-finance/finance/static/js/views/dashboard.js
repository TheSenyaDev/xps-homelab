import { api } from "../api.js";
import { el, money, monthLabel } from "../dom.js";
import { barList, monthlyTrend } from "../charts.js";
import { state } from "../state.js";

const tile = (label, value, cls) =>
  el("div", { class: "card" },
    el("div", { class: "label", text: label }),
    el("div", { class: `value ${cls}`, text: value }));

export async function renderDashboard(root, ctx = {}) {
  const goTo = ctx.goTo || (() => {});
  root.replaceChildren(el("div", { class: "empty", text: "Loading…" }));

  const [ov, monthly] = await Promise.all([
    api.get("/api/overview" + (state.month ? `?month=${state.month}` : "")),
    api.get("/api/summary/monthly?months=12"),
  ]);

  root.replaceChildren();
  if (!ov.month) {
    root.append(el("div", { class: "empty" },
      "No transactions yet. Click ⟳ Import to load from the SMB folder."));
    return;
  }

  const net = ov.income - ov.spending;
  root.append(el("div", { class: "cards" },
    tile("Spending", money(ov.spending), "spend"),
    tile("Income", money(ov.income), "income"),
    tile("Net", money(net), net >= 0 ? "net-pos" : "net-neg"),
    tile("Uncategorized", String(ov.uncategorized), ov.uncategorized ? "net-neg" : "spend")));

  if (ov.uncategorized > 0) {
    root.append(el("div", { class: "banner" },
      el("span", { text: `${ov.uncategorized} uncategorized transaction${ov.uncategorized > 1 ? "s" : ""} this month — label them for accurate totals.` }),
      el("button", { class: "btn", onclick: () => goTo("transactions", { uncategorized: true }) }, "Review")));
  }

  root.append(el("div", { class: "grid2" },
    el("div", { class: "panel" },
      el("h2", { text: `Spending by category · ${monthLabel(ov.month)}` }),
      barList(ov.by_category.map((c) => ({
        label: c.category, amount: c.amount, color: c.color,
        onClick: () => c.category_id
          ? goTo("transactions", { category_id: c.category_id })
          : goTo("transactions", { uncategorized: true }),
      })))),
    el("div", { class: "panel" },
      el("h2", { text: "Top merchants" }),
      barList(ov.top_merchants.map((m) => ({ label: m.merchant, amount: m.amount }))))));

  root.append(el("div", { class: "panel" },
    el("h2", { text: "Monthly spending" }),
    monthlyTrend(monthly, ov.month, (m) => {
      state.month = m;
      const sel = document.getElementById("month-select");
      if (sel) sel.value = m;
      renderDashboard(root, ctx);
    })));
}
