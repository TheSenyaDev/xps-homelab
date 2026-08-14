// Subscriptions view: what bills you again and again, what it adds up to, and
// what quietly went up in price. Detection lives in the backend (recurring.py);
// this only presents it.
import { api } from "../api.js";
import { el, money, replace, skeleton } from "../dom.js";

const CADENCE_LABEL = {
  weekly: "every week", biweekly: "every 2 weeks", monthly: "monthly",
  quarterly: "every 3 months", yearly: "yearly",
};

const tile = (label, value, cls, sub) =>
  el("div", { class: "card" },
    el("div", { class: "label", text: label }),
    el("div", { class: `value ${cls || ""}`, text: value }),
    sub ? el("div", { class: "sub", text: sub }) : null);

// "in 4 days" / "3 days ago", counted from the last imported statement rather
// than from today — see as_of_date() in recurring.py for why.
function relativeDay(iso, asOf) {
  const base = new Date((asOf || new Date().toISOString().slice(0, 10)) + "T00:00:00");
  const days = Math.round((new Date(iso + "T00:00:00") - base) / 86400000);
  if (days === 0) return "due";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

export async function renderRecurring(root, ctx = {}) {
  const goTo = ctx.goTo || (() => {});
  root.replaceChildren(skeleton({ cards: 4, panels: 1 }));

  let showInactive = false;
  const data = await api.get("/api/recurring?years=3");
  const { summary, series, as_of: asOf } = data;

  if (!series.length) {
    root.replaceChildren(el("div", { class: "empty" },
      "No recurring charges detected. Needs at least 3 evenly-spaced charges from the same merchant."));
    return;
  }

  const listWrap = el("div");
  const toggle = el("label", { class: "muted" });
  const cb = el("input", { type: "checkbox" });
  cb.addEventListener("change", () => { showInactive = cb.checked; drawList(); });
  toggle.append(cb, ` Show lapsed (${summary.inactive_count})`);

  replace(root,
    el("div", { class: "cards" },
      tile("Active subscriptions", String(summary.active_count), "spend"),
      tile("Per month", money(summary.monthly_total), "spend", "recurring charges only"),
      tile("Per year", money(summary.yearly_total), "net-neg"),
      tile("Price increases", String(summary.price_increases.length),
        summary.price_increases.length ? "net-neg" : "spend")),
    summary.price_increases.length ? hikeBanner(summary.price_increases) : null,
    el("div", { class: "panel" },
      el("div", { class: "filters" },
        el("h2", { style: "margin:0", text: "Recurring charges" }),
        el("span", { class: "muted", style: "font-size:12px", text: `as of ${asOf} (latest import)` }),
        el("span", { class: "spacer" }), toggle),
      listWrap));

  drawList();

  function drawList() {
    const rows = showInactive ? series : series.filter((s) => s.active);
    listWrap.replaceChildren(...rows.map((s) => card(s, goTo, asOf)));
  }
}

function hikeBanner(hikes) {
  return el("div", { class: "banner" },
    el("span", {},
      `${hikes.length} subscription${hikes.length > 1 ? "s" : ""} went up in price: `,
      hikes.map((h) => `${h.display.slice(0, 28)} ${money(h.price_change.from)} → ${money(h.price_change.to)}`)
        .join(" · ")));
}

function card(s, goTo, asOf) {
  const chips = el("div", { class: "chips" },
    el("span", { class: "kind-tag", text: CADENCE_LABEL[s.cadence] || s.cadence }),
    s.category
      ? el("span", { class: "nm" }, el("span", { class: "dot", style: `background:${s.category_color}` }), s.category)
      : el("span", { class: "kind-tag warn", text: "uncategorized" }),
    el("span", { class: "muted", text: `${s.occurrences}× since ${s.first_seen.slice(0, 7)}` }),
    s.account ? el("span", { class: "acct-pill", text: s.account }) : null);

  const next = s.active
    ? el("span", { class: "muted", text: `next ${s.next_due} · ${relativeDay(s.next_due, asOf)}` })
    : el("span", { class: "chg bad", text: `lapsed · last seen ${s.last_seen}` });

  return el("div", { class: "sub-row" + (s.active ? "" : " inactive") },
    el("div", { class: "sub-main" },
      el("div", { class: "sub-title" },
        el("span", { class: "sub-name", text: s.display }),
        s.price_change
          ? el("span", { class: "chg bad", text: `+${s.price_change.percent}%` })
          : null),
      chips,
      next),
    el("div", { class: "sub-amt" },
      el("div", { class: "amount big", text: money(s.typical_amount) }),
      s.cadence !== "monthly"
        ? el("div", { class: "muted small", text: `${money(s.monthly_equivalent)}/mo` })
        : el("div", { class: "muted small", text: `${money(s.yearly_equivalent)}/yr` }),
      el("button", {
        class: "linkbtn",
        title: "Show these transactions",
        onclick: () => goTo("transactions", { q: s.display, allMonths: true }),
      }, "view")));
}
