// Set a monthly ceiling per category and see how the selected month is tracking.
//
// Editing is inline and immediate — there is no save button, because a budget is
// one number and a form around it would be more ceremony than the change.
import { api } from "../api.js";
import { el, money, moneyShort, monthLabel, toast, skeleton } from "../dom.js";
import { progressTrack } from "../charts.js";
import { state } from "../state.js";

export async function renderBudgets(root, ctx = {}) {
  const goTo = ctx.goTo || (() => {});
  root.replaceChildren(skeleton({ cards: 3, panels: 1 }));
  const qs = state.month ? `?month=${state.month}` : "";
  let data = await api.get("/api/budgets" + qs);

  function draw() {
    root.replaceChildren();
    if (!data.month) {
      root.append(el("div", { class: "empty", text: "Import some transactions first." }));
      return;
    }

    const t = data.totals;
    const left = t.budget ? t.remaining : 0;
    root.append(el("div", { class: "cards" },
      card("Budgeted", money(t.budget), "", `${data.budgets.filter((b) => b.amount).length} categories`),
      card("Spent", money(t.spent), t.budget && t.spent > t.budget ? "net-neg" : "",
        t.pct != null ? `${t.pct}% of budget` : "no budgets set"),
      card(left >= 0 ? "Left" : "Over", money(Math.abs(left)), left >= 0 ? "net-pos" : "net-neg",
        `day ${data.days_elapsed} of ${data.days_in_month}`),
      card("Unbudgeted", money(t.unbudgeted_spent), t.unbudgeted_spent ? "warn" : "",
        "spending outside any budget")));

    if (t.over_count) {
      root.append(el("div", { class: "banner" },
        el("span", { text: `${t.over_count} categor${t.over_count > 1 ? "ies are" : "y is"} over budget this month.` })));
    }

    const budgeted = data.budgets.filter((b) => b.amount);
    const rest = data.budgets.filter((b) => !b.amount);

    root.append(el("div", { class: "panel" },
      el("div", { class: "section-head" },
        el("h2", { text: `Tracking · ${monthLabel(data.month)}` }),
        el("span", { class: "spacer" }),
        el("span", { class: "muted small", text: "the marker shows an even pace to today" })),
      budgeted.length
        ? el("div", {}, ...budgeted.map(row))
        : el("div", { class: "empty", text: "No budgets yet — set one below." })));

    root.append(el("div", { class: "panel" },
      el("div", { class: "section-head" },
        el("h2", { text: "Not budgeted" }),
        el("span", { class: "spacer" }),
        el("span", { class: "muted small", text: "suggestions are your median of the last 6 months" })),
      rest.length
        ? el("div", {}, ...rest.map(row))
        : el("div", { class: "empty", text: "Every expense category has a budget." })));
  }

  function row(b) {
    const input = el("input", {
      class: "budget-input", type: "number", min: "0", step: "10",
      placeholder: b.suggested ? String(Math.round(b.suggested)) : "—",
      value: b.amount ?? "",
      title: "Monthly budget — blank to remove",
    });
    input.addEventListener("change", () => save(b, input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });

    const head = el("div", { class: "budget-head" },
      el("span", { class: "dot", style: { background: b.color } }),
      el("span", { class: "merchant-link", text: b.category,
        onclick: () => goTo("transactions", { category_id: b.category_id }) }));

    // An unbudgeted category with a usable history gets a one-click way in;
    // typing the number you were about to be shown anyway is busywork.
    if (!b.amount && b.suggested) {
      head.append(el("button", {
        class: "linkbtn", title: `Set ${money(b.suggested)}/month`,
        onclick: () => save(b, b.suggested),
      }, `use ${moneyShort(b.suggested)}`));
    }

    const cells = [head,
      el("div", { class: "budget-amt" },
        b.spent ? el("span", { class: "spent", text: moneyShort(b.spent) }) : el("span", { class: "muted", text: "—" }),
        el("span", { class: "muted", text: " / " }),
        input)];

    if (b.amount) {
      cells.push(progressTrack(b.spent, b.amount, b.pace, b.color));
      const over = b.spent - b.amount;
      cells.push(el("div", { class: "budget-meta" },
        el("span", { text: `${b.pct}% used` }),
        el("span", { text: over > 0 ? `${money(over)} over` : `${money(-over)} left` }),
        b.pace != null && el("span", {
          text: b.spent > b.pace ? `${money(b.spent - b.pace)} ahead of pace` : "on pace",
        }),
        el("span", { text: `${b.tx_count} charge${b.tx_count === 1 ? "" : "s"}` })));
    }
    return el("div", { class: "budget-row" }, ...cells);
  }

  async function save(b, raw) {
    const amount = raw === "" || raw == null ? null : Number(raw);
    if (amount != null && (Number.isNaN(amount) || amount < 0)) { toast("Enter a positive amount"); return; }
    await api.put(`/api/budgets/${b.category_id}`, { amount });
    toast(amount ? `${b.category}: ${money(amount)}/month` : `${b.category} budget removed`);
    data = await api.get("/api/budgets" + qs);
    draw();
  }

  draw();
}

function card(label, value, cls, sub) {
  return el("div", { class: "card" },
    el("div", { class: "label", text: label }),
    el("div", { class: `value ${cls}`, text: value }),
    el("div", { class: "sub" }, el("span", { text: sub })));
}
