import { api } from "../api.js";
import { el, money, toast } from "../dom.js";
import { openMerchant } from "../drawer.js";
import { state } from "../state.js";

export async function renderTransactions(root, ctx = {}) {
  const params = ctx.params || {};
  const f = {
    account: "",
    category: params.uncategorized ? "uncat" : (params.category_id ? String(params.category_id) : ""),
    q: params.q || "",
    // Reviewing uncategorized (or following a link from another view) spans all
    // months — the point is to find the rows, wherever they are.
    allMonths: !!params.uncategorized || !!params.allMonths,
  };
  const accounts = await api.get("/api/accounts");

  let rows = [];                 // what's currently displayed
  const selected = new Set();    // transaction ids ticked for a bulk action

  const tableWrap = el("div");
  const bulkBar = el("div", { class: "bulkbar hidden" });
  root.replaceChildren(el("div", { class: "panel" }, buildFilters(), bulkBar, tableWrap));
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

    // Export hands back exactly the rows the filters produced — same query
    // string, so the file matches the screen rather than re-deriving "current".
    const exportBtn = el("button", {
      class: "ghost", title: "Download these rows as CSV",
      onclick: () => { window.location.href = "/api/export/transactions.csv?" + query(); },
    }, "↓ CSV");

    return el("div", { class: "filters" }, acct, cat, q,
      el("label", { class: "muted" }, amCb, " All months"),
      el("span", { class: "spacer", style: "margin-left:auto" }), exportBtn);
  }

  // One place builds the filter query, so the table and the export can't drift.
  function query(extra = {}) {
    const qs = new URLSearchParams();
    if (!f.allMonths && state.month) qs.set("month", state.month);
    if (f.account) qs.set("account", f.account);
    if (f.category === "uncat") qs.set("uncategorized", "1");
    else if (f.category) qs.set("category_id", f.category);
    if (f.q) qs.set("q", f.q);
    for (const [k, v] of Object.entries(extra)) qs.set(k, v);
    return qs.toString();
  }

  let debTimer;
  function debounce(fn) { clearTimeout(debTimer); debTimer = setTimeout(fn, 250); }

  async function refresh() {
    selected.clear();
    syncBulkBar();
    tableWrap.replaceChildren(el("div", { class: "skel skel-panel" }));
    rows = await api.get("/api/transactions?" + query({ limit: "500" }));
    renderTable();
  }

  // ---- bulk selection -----------------------------------------------------

  function syncBulkBar() {
    const n = selected.size;
    bulkBar.classList.toggle("hidden", n === 0);
    if (!n) return;

    const total = rows.filter((r) => selected.has(r.id)).reduce((s, r) => s + r.amount, 0);
    const cat = el("select", {},
      el("option", { value: "", text: "Set category…" }),
      el("option", { value: "clear", text: "— clear category —" }),
      ...state.categories.map((c) => el("option", { value: String(c.id), text: c.name })));

    cat.addEventListener("change", async () => {
      if (!cat.value) return;
      const categoryId = cat.value === "clear" ? null : Number(cat.value);
      const ids = [...selected];
      const res = await api.patch("/api/transactions/bulk", { ids, category_id: categoryId });
      toast(`${res.updated} transaction(s) updated`);
      refresh();
    });

    bulkBar.replaceChildren(
      el("span", { text: `${n} selected · ${money(total)}` }),
      el("span", { class: "spacer" }),
      cat,
      el("button", { class: "ghost", onclick: () => { selected.clear(); renderTable(); } }, "Clear"));
  }

  function renderTable() {
    if (!rows.length) {
      tableWrap.replaceChildren(el("div", { class: "empty", text: "No transactions match." }));
      return;
    }
    const allTicked = rows.every((r) => selected.has(r.id));
    const selectAll = el("input", { type: "checkbox", title: "Select all" });
    selectAll.checked = allTicked;
    selectAll.addEventListener("change", () => {
      if (selectAll.checked) rows.forEach((r) => selected.add(r.id));
      else selected.clear();
      renderTable();
    });

    const body = el("tbody");
    rows.forEach((r) => body.append(txRow(r)));
    const out = rows.filter((r) => r.direction === "out").reduce((s, r) => s + r.amount, 0);
    tableWrap.replaceChildren(
      el("div", { class: "muted small", style: "margin-bottom:10px" },
        `${rows.length} transaction${rows.length === 1 ? "" : "s"} · ${money(out)} out`),
      el("div", { class: "table-scroll" },
        el("table", {},
          el("thead", {}, el("tr", {},
            el("th", { class: "tick" }, selectAll),
            el("th", { text: "Date" }), el("th", { text: "Merchant" }), el("th", { text: "Account" }),
            el("th", { text: "Category" }), el("th", { class: "amt", text: "Amount" }))),
          body)));
    syncBulkBar();
  }

  function txRow(r) {
    const tick = el("input", { type: "checkbox" });
    tick.checked = selected.has(r.id);
    tick.addEventListener("change", () => {
      if (tick.checked) selected.add(r.id); else selected.delete(r.id);
      tr.classList.toggle("picked", tick.checked);
      syncBulkBar();
    });

    const sel = el("select", { class: "cat-select" },
      el("option", { value: "", text: "—" }),
      ...state.categories.map((c) => el("option", { value: String(c.id), text: c.name })));
    sel.value = r.category_id ? String(r.category_id) : "";

    const ruleBtn = el("button", {
      class: "linkbtn" + (r.category_id ? "" : " hidden"),
      title: "Make a rule so similar merchants auto-categorize",
      onclick: () => makeRule(r, sel),
    }, "＋rule");

    const tr = el("tr", { class: (r.category_id ? "" : "uncat") + (tick.checked ? " picked" : "") },
      el("td", { class: "tick" }, tick),
      el("td", { text: r.date }),
      el("td", { class: "merchant-link", text: r.merchant, title: "See everything from this merchant",
        onclick: () => openMerchant(r.merchant) }),
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

    // Say what it will hit before it hits it — a pattern typed from one row can
    // easily match far more than the person expects.
    const pv = await api.post("/api/rules/preview", { pattern: pattern.trim(), is_regex: false });
    const warn = pv.already_categorized
      ? `\n\n${pv.already_categorized} of them already have a category and will NOT be changed.` : "";
    if (!confirm(`"${pattern.trim()}" matches ${pv.count} transaction(s), ${money(pv.total_amount)} total.${warn}\n\nCreate this rule?`)) return;

    await api.post("/api/rules", { pattern: pattern.trim(), is_regex: false, category_id: cid });
    const res = await api.post("/api/rules/apply");
    toast(`Rule added · ${res.categorized} transaction(s) matched`);
    refresh();
  }
}
