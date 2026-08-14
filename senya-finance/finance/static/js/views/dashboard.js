// One month at a glance: what it cost, how that compares, and where it went.
import { api } from "../api.js";
import { el, money, moneyShort, monthLabel, dateLabel, changeChip, skeleton } from "../dom.js";
import { barList, donut, dailyBars, monthlyTrend, sparkline, progressTrack } from "../charts.js";
import { openMerchant } from "../drawer.js";
import { state } from "../state.js";

function tile(label, value, cls, { sub, spark } = {}) {
  const card = el("div", { class: "card" },
    el("div", { class: "label", text: label }),
    el("div", { class: `value ${cls || ""}`, text: value }),
    sub && el("div", { class: "sub" }, ...(Array.isArray(sub) ? sub : [sub])));
  if (spark) card.append(spark);
  return card;
}

function insight(mark, title, detail, tone) {
  return el("div", { class: "insight " + (tone || "") },
    el("span", { class: "mark", text: mark }),
    el("div", { class: "body" },
      el("div", { class: "t", text: title }),
      el("div", { class: "d", text: detail })));
}

export async function renderDashboard(root, ctx = {}) {
  const goTo = ctx.goTo || (() => {});
  const qs = state.month ? `?month=${state.month}` : "";
  root.replaceChildren(skeleton({ cards: 4, panels: 2 }));

  const [ov, monthly, ins, budgets] = await Promise.all([
    api.get("/api/overview" + qs),
    api.get("/api/summary/monthly?months=12"),
    api.get("/api/insights" + qs),
    api.get("/api/budgets" + qs),
  ]);

  root.replaceChildren();
  if (!ov.month) {
    root.append(el("div", { class: "empty" },
      "No transactions yet. Click ⟳ Import to load statements from the import folder."));
    return;
  }

  const goToMonth = (m) => {
    state.month = m;
    const sel = document.getElementById("month-select");
    if (sel) sel.value = m;
    renderDashboard(root, ctx);
  };
  const showMerchant = (name) => openMerchant(name, { onPickMonth: goToMonth });

  // ---- stat tiles ----------------------------------------------------------

  const net = ov.income - ov.spending;
  const history = monthly.map((m) => m.spending);
  root.append(el("div", { class: "cards" },
    tile("Spending", money(ov.spending), "", {
      sub: ins.spending_change_pct != null
        ? [changeChip(ins.spending_change_pct), el("span", { text: "vs last month" })]
        : el("span", { text: "no previous month" }),
      spark: sparkline(history),
    }),
    tile("Income", money(ov.income), "income", {
      sub: el("span", { text: ins.prev_income ? `last month ${moneyShort(ins.prev_income)}` : "—" }),
    }),
    tile(net >= 0 ? "Saved" : "Overspent", money(Math.abs(net)), net >= 0 ? "net-pos" : "net-neg", {
      sub: el("span", { text: ins.savings_rate != null ? `${ins.savings_rate}% of income` : "no income recorded" }),
    }),
    tile("Uncategorized", String(ov.uncategorized), ov.uncategorized ? "warn" : "", {
      sub: el("span", { text: ov.uncategorized ? "affects every total" : "all labelled" }),
    })));

  if (ov.uncategorized > 0) {
    root.append(el("div", { class: "banner" },
      el("span", { text: `${ov.uncategorized} uncategorized transaction${ov.uncategorized > 1 ? "s" : ""} this month — label them for accurate totals.` }),
      el("button", { class: "btn", onclick: () => goTo("transactions", { uncategorized: true }) }, "Review")));
  }

  // ---- insight strip -------------------------------------------------------

  const strip = [];
  if (ins.projection) {
    const p = ins.projection;
    strip.push(insight("◷", `On track for ${moneyShort(p.projected)}`,
      `${money(p.per_day)}/day over ${p.days_elapsed} of ${p.days_in_month} days`,
      ins.baseline_spending && p.projected > ins.baseline_spending ? "warn" : ""));
  }
  if (ins.baseline_spending) {
    const over = ins.vs_baseline_pct > 0;
    strip.push(insight(over ? "▲" : "▼",
      `${Math.abs(Math.round(ins.vs_baseline_pct))}% ${over ? "above" : "below"} your usual`,
      `6-month average is ${moneyShort(ins.baseline_spending)}`,
      over ? "bad" : "good"));
  }
  const mover = ins.movers?.[0];
  if (mover) {
    strip.push(insight(mover.delta > 0 ? "↑" : "↓",
      `${mover.category} ${mover.delta > 0 ? "up" : "down"} ${moneyShort(Math.abs(mover.delta))}`,
      `${money(mover.prev_amount)} → ${money(mover.amount)} vs last month`,
      mover.delta > 0 ? "bad" : "good"));
  }
  if (ins.new_merchants?.length) {
    const n = ins.new_merchants;
    strip.push(insight("✦", `${n.length} new merchant${n.length > 1 ? "s" : ""}`,
      n.slice(0, 3).map((m) => m.merchant).join(", "), ""));
  }
  if (strip.length) root.append(el("div", { class: "insights" }, ...strip));

  // ---- breakdown -----------------------------------------------------------

  const toCategory = (c) => () => c.category_id
    ? goTo("transactions", { category_id: c.category_id })
    : goTo("transactions", { uncategorized: true });

  root.append(el("div", { class: "grid2 wide-left" },
    el("div", { class: "panel" },
      el("h2", { text: `Where it went · ${monthLabel(ov.month)}` }),
      donut(ov.by_category.map((c) => ({
        label: c.category, amount: c.amount, color: c.color, onClick: toCategory(c),
      })), { centerLabel: "Spent" })),
    el("div", { class: "panel" },
      el("div", { class: "section-head" },
        el("h2", { text: "Top merchants" }),
        el("span", { class: "spacer" }),
        el("button", { class: "linkbtn", onclick: () => goTo("merchants") }, "all")),
      barList(ov.top_merchants.map((m) => ({
        label: m.merchant, amount: m.amount,
        sub: `${m.tx_count} charge${m.tx_count > 1 ? "s" : ""}`,
        onClick: () => showMerchant(m.merchant),
      }))))));

  // ---- budgets + daily -----------------------------------------------------

  const tracked = budgets.budgets.filter((b) => b.amount);
  const panels = [];
  if (tracked.length) {
    panels.push(el("div", { class: "panel" },
      el("div", { class: "section-head" },
        el("h2", { text: "Budgets" }),
        el("span", { class: "spacer" }),
        el("button", { class: "linkbtn", onclick: () => goTo("budgets") }, "manage")),
      ...tracked.slice(0, 5).map((b) => el("div", { class: "budget-row" },
        el("div", { class: "budget-head" },
          el("span", { class: "dot", style: { background: b.color } }),
          el("span", { text: b.category })),
        el("div", { class: "budget-amt" },
          el("span", { class: "spent", text: moneyShort(b.spent) }),
          el("span", { class: "muted", text: ` / ${moneyShort(b.amount)}` })),
        progressTrack(b.spent, b.amount, b.pace, b.color)))));
  }
  panels.push(el("div", { class: "panel" },
    el("h2", { text: "Daily spending" }),
    dailyBars(ins.daily)));

  root.append(panels.length === 2
    ? el("div", { class: "grid2" }, ...panels)
    : panels[0]);

  // ---- history -------------------------------------------------------------

  root.append(el("div", { class: "panel" },
    el("div", { class: "section-head" },
      el("h2", { text: "Monthly spending" }),
      el("span", { class: "spacer" }),
      el("span", { class: "muted small", text: "click a month to jump to it" })),
    monthlyTrend(monthly, ov.month, goToMonth)));

  if (ins.largest?.length) {
    root.append(el("div", { class: "panel" },
      el("h2", { text: "Biggest charges this month" }),
      el("div", { class: "table-scroll" },
        el("table", {},
          el("thead", {}, el("tr", {},
            el("th", { text: "Date" }), el("th", { text: "Merchant" }),
            el("th", { text: "Category" }), el("th", { class: "amt", text: "Amount" }))),
          el("tbody", {}, ...ins.largest.map((t) => el("tr", {},
            el("td", { text: dateLabel(t.date) }),
            el("td", { class: "merchant-link", text: t.merchant, onclick: () => showMerchant(t.merchant) }),
            el("td", {}, el("span", { class: "nm" },
              el("span", { class: "dot", style: { background: t.color } }), " ", t.category)),
            el("td", { class: "amt", text: money(t.amount) }))))))));
  }
}
