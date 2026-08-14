// Where the money actually goes, ranked by merchant rather than by category.
//
// Categories say "$800 on groceries"; this says which shops that was. Spans a
// month, a year or everything, because the useful question changes with the
// window — one month finds an odd charge, all-time finds the standing drains.
import { api } from "../api.js";
import { el, money, moneyShort, monthLabel } from "../dom.js";
import { barList } from "../charts.js";
import { openMerchant } from "../drawer.js";
import { state } from "../state.js";

export async function renderMerchants(root) {
  let scope = "all";     // all | year | month
  let rows = [];

  const scopeSel = el("select", { onchange: (e) => { scope = e.target.value; load(); } },
    el("option", { value: "all", text: "All time" }),
    el("option", { value: "year", text: "This year" }),
    el("option", { value: "month", text: "Selected month" }));

  const search = el("input", { class: "search", type: "text", placeholder: "Filter merchants…" });
  search.addEventListener("input", draw);

  const body = el("div");
  root.replaceChildren(el("div", { class: "panel" },
    el("div", { class: "filters" }, scopeSel, search), body));
  load();

  async function load() {
    body.replaceChildren(el("div", { class: "skel skel-panel" }));
    const qs = new URLSearchParams({ limit: "60" });
    // The month selector is hidden on this view, so "selected month" means the
    // last month you were looking at elsewhere — still the most recent by default.
    if (scope === "month" && state.month) qs.set("month", state.month);
    if (scope === "year" && state.month) qs.set("year", state.month.slice(0, 4));
    rows = await api.get("/api/merchants?" + qs);
    draw();
  }

  function draw() {
    const q = search.value.trim().toLowerCase();
    const shown = q ? rows.filter((r) => r.merchant.toLowerCase().includes(q)) : rows;
    if (!shown.length) {
      body.replaceChildren(el("div", { class: "empty", text: "No merchants match." }));
      return;
    }
    const total = shown.reduce((s, r) => s + r.amount, 0);
    const label = scope === "month" ? monthLabel(state.month)
      : scope === "year" ? state.month?.slice(0, 4) : "all time";

    body.replaceChildren(
      el("div", { class: "muted small", style: "margin-bottom:12px" },
        `${shown.length} merchant${shown.length > 1 ? "s" : ""} · ${money(total)} · ${label}`),
      barList(shown.map((r) => ({
        label: r.merchant,
        amount: r.amount,
        color: r.color,
        sub: `${r.tx_count} charge${r.tx_count > 1 ? "s" : ""} · ${r.category} · avg ${moneyShort(r.amount / r.tx_count)}`,
        onClick: () => openMerchant(r.merchant),
      }))));
  }
}
