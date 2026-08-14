// Merchant drill-down. Opened from any chart bar, legend row or table cell that
// names a merchant, so "what is this and how much do I actually spend there?"
// is always one click away and never costs you the view you were on.
import { api } from "./api.js";
import { el, money, dateLabel } from "./dom.js";
import { monthlyTrend } from "./charts.js";

const node = () => document.getElementById("drawer");
const scrim = () => document.getElementById("drawer-scrim");

export function closeDrawer() {
  node().classList.add("hidden");
  scrim().classList.add("hidden");
  node().replaceChildren();
}

export function initDrawer() {
  scrim().addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !node().classList.contains("hidden")) closeDrawer();
  });
}

export async function openMerchant(name, ctx = {}) {
  const d = node();
  scrim().classList.remove("hidden");
  d.classList.remove("hidden");
  d.replaceChildren(head(name), el("div", { class: "skel skel-panel" }));

  const m = await api.get("/api/merchants/detail?name=" + encodeURIComponent(name));
  d.replaceChildren(head(name));

  if (!m.tx_count) {
    d.append(el("div", { class: "empty", text: "No spending recorded for this merchant." }));
    return;
  }

  const months = m.monthly.length;
  d.append(el("div", { class: "stat-row" },
    stat("Total", money(m.total)),
    stat("Charges", String(m.tx_count)),
    stat("Average", money(m.avg_amount)),
    stat("Per month", money(m.total / Math.max(months, 1)))));

  d.append(el("div", { class: "muted small", style: "margin-bottom:18px" },
    `First seen ${dateLabel(m.first_seen)} · last ${dateLabel(m.last_seen)} · across ${months} month${months > 1 ? "s" : ""}`));

  if (months > 1) {
    d.append(el("div", { class: "panel inner", style: "margin-bottom:18px" },
      el("h2", { text: "Monthly" }),
      monthlyTrend(m.monthly.map((r) => ({ month: r.month, spending: r.amount })), null,
        ctx.onPickMonth && ((month) => { closeDrawer(); ctx.onPickMonth(month); }))));
  }

  d.append(el("h2", { text: "History" }),
    el("div", { class: "table-scroll" },
      el("table", {},
        el("thead", {}, el("tr", {},
          el("th", { text: "Date" }), el("th", { text: "Account" }),
          el("th", { text: "Category" }), el("th", { class: "amt", text: "Amount" }))),
        el("tbody", {}, ...m.transactions.map((t) => el("tr", {},
          el("td", { text: dateLabel(t.date) }),
          el("td", {}, el("span", { class: "acct-pill", text: t.account })),
          el("td", {}, t.category
            ? el("span", { class: "nm" },
              el("span", { class: "dot", style: { background: t.category_color } }), " ", t.category)
            : el("span", { class: "muted", text: "—" })),
          el("td", { class: "amt " + t.direction, text: (t.direction === "out" ? "-" : "+") + money(t.amount) })))))));
}

function head(name) {
  return el("div", { class: "drawer-head" },
    el("h3", { text: name }),
    el("button", { class: "icon-btn close", title: "Close", onclick: closeDrawer }, "✕"));
}

function stat(k, v) {
  return el("div", { class: "stat" }, el("div", { class: "k", text: k }), el("div", { class: "v", text: v }));
}
