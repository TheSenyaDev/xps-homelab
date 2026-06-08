import { api } from "../api.js";
import { el, money, toast } from "../dom.js";
import { state } from "../state.js";

export async function renderTransactions(root, ctx = {}) {
  const params = ctx.params || {};
  const f = {
    account: "",
    category: params.uncategorized ? "uncat" : (params.category_id ? String(params.category_id) : ""),
    q: "",
    allMonths: !!params.uncategorized, // reviewing uncategorized spans all months
  };
  const accounts = await api.get("/api/accounts");

  const tableWrap = el("div");
  root.replaceChildren(el("div", { class: "panel" }, buildFilters(), tableWrap));
  refresh();

  function buildFilters() {
    const acct = el("select", { onchange: (e) => { f.account = e.target.value; refresh(); } },
      el("option", { value: "", text: "All accounts" }),
      ...accounts.map((a) => el("option", { value: a, text: a })));
    acct.value = f.account;

    const cat = el("select", { onchange: (e) => { f.category = e.target.value; refresh(); } },
      el("option", { value: "", text: "All categories" }),
      el("option", { value: "uncat", text: "⚠ Uncategorized only" }),
      ...state.categories.map((c) => el("option", { value: String(c.id), text: c.name })));
    cat.value = f.category;

    const q = el("input", { class: "search", type: "text", placeholder: "Search merchant…" });
    q.value = f.q;
    q.addEventListener("input", () => { f.q = q.value; debounce(refresh); });

    const amCb = el("input", { type: "checkbox" });
    amCb.checked = f.allMonths;
    amCb.addEventListener("change", () => { f.allMonths = amCb.checked; refresh(); });

    return el("div", { class: "filters" }, acct, cat, q,
      el("label", { class: "muted" }, amCb, " All months"));
  }

  let debTimer;
  function debounce(fn) { clearTimeout(debTimer); debTimer = setTimeout(fn, 250); }

  async function refresh() {
    const qs = new URLSearchParams();
    if (!f.allMonths && state.month) qs.set("month", state.month);
    if (f.account) qs.set("account", f.account);
    if (f.category === "uncat") qs.set("uncategorized", "1");
    else if (f.category) qs.set("category_id", f.category);
    if (f.q) qs.set("q", f.q);
    qs.set("limit", "500");
    tableWrap.replaceChildren(el("div", { class: "empty", text: "Loading…" }));
    renderTable(await api.get("/api/transactions?" + qs.toString()));
  }

  function renderTable(rows) {
    if (!rows.length) {
      tableWrap.replaceChildren(el("div", { class: "empty", text: "No transactions match." }));
      return;
    }
    const body = el("tbody");
    rows.forEach((r) => body.append(txRow(r)));
    tableWrap.replaceChildren(
      el("div", { class: "muted", style: "margin-bottom:8px;font-size:13px", text: `${rows.length} transaction(s)` }),
      el("table", {},
        el("thead", {}, el("tr", {},
          el("th", { text: "Date" }), el("th", { text: "Merchant" }), el("th", { text: "Account" }),
          el("th", { text: "Category" }), el("th", { class: "amt", text: "Amount" }))),
        body));
  }

  function txRow(r) {
    const sel = el("select", { class: "cat-select" },
      el("option", { value: "", text: "—" }),
      ...state.categories.map((c) => el("option", { value: String(c.id), text: c.name })));
    sel.value = r.category_id ? String(r.category_id) : "";

    const ruleBtn = el("button", {
      class: "linkbtn" + (r.category_id ? "" : " hidden"),
      title: "Make a rule so similar merchants auto-categorize",
      onclick: () => makeRule(r, sel),
    }, "＋rule");

    const tr = el("tr", { class: r.category_id ? "" : "uncat" },
      el("td", { text: r.date }),
      el("td", { text: r.merchant }),
      el("td", {}, el("span", { class: "acct-pill", text: r.account })),
      el("td", {}, sel, ruleBtn),
      el("td", { class: "amt " + r.direction, text: (r.direction === "out" ? "-" : "+") + money(r.amount) }));

    sel.addEventListener("change", async () => {
      const val = sel.value ? Number(sel.value) : null;
      await api.patch(`/api/transactions/${r.id}`, { category_id: val });
      r.category_id = val;
      tr.classList.toggle("uncat", !val);
      ruleBtn.classList.toggle("hidden", !val);
    });
    return tr;
  }

  async function makeRule(r, sel) {
    const cid = sel.value ? Number(sel.value) : null;
    if (!cid) { toast("Pick a category first"); return; }
    const pattern = window.prompt("Auto-categorize transactions whose merchant contains:", r.merchant);
    if (!pattern || !pattern.trim()) return;
    await api.post("/api/rules", { pattern: pattern.trim(), is_regex: false, category_id: cid });
    const res = await api.post("/api/rules/apply");
    toast(`Rule added · ${res.categorized} transaction(s) matched`);
    refresh();
  }
}
