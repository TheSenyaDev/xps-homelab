import { api } from "../api.js";
import { el, money, replace, skeleton, toast } from "../dom.js";
import { loadCategories, state } from "../state.js";

const KINDS = ["expense", "income", "transfer"];

export async function renderManage(root, ctx = {}) {
  root.replaceChildren(skeleton({ panels: 2 }));

  async function reload() {
    const [cats, rules, suggestions] = await Promise.all([
      api.get("/api/categories"),
      api.get("/api/rules"),
      api.get("/api/rules/suggestions"),
    ]);
    state.categories = cats;
    replace(root,
      suggestions.length ? suggestionsPanel(suggestions, cats, reload) : null,
      categoriesPanel(cats, reload),
      rulesPanel(rules, cats, reload));
  }
  await reload();
}

// Repeated uncategorized merchants, biggest money first — the shortlist of
// rules actually worth writing, instead of hunting for them in the table.
function suggestionsPanel(rows, cats, reload) {
  const list = el("div", {});
  for (const s of rows.slice(0, 8)) {
    const cat = el("select", { class: "cat-select" },
      el("option", { value: "", text: "Categorize as…" }),
      ...cats.map((c) => el("option", { value: String(c.id), text: c.name })));

    cat.addEventListener("change", async () => {
      if (!cat.value) return;
      // The merchant string is the pattern: it's what these rows have in common.
      await api.post("/api/rules", {
        pattern: s.merchant, is_regex: false, category_id: Number(cat.value),
      });
      const res = await api.post("/api/rules/apply");
      toast(`Rule added · ${res.categorized} transaction(s) categorized`);
      reload();
    });

    list.append(el("div", { class: "row-item" },
      el("span", { class: "sug-merchant", text: s.merchant }),
      el("span", { class: "spacer" }),
      el("span", { class: "muted", style: "font-size:12px", text: `${s.tx_count}× · last ${s.last_seen}` }),
      el("span", { class: "amount", text: money(s.amount) }),
      cat));
  }

  return el("div", { class: "panel" },
    el("h2", { text: "Suggested rules" }),
    el("p", { class: "muted", style: "font-size:13px;margin-top:-6px",
      text: "Uncategorized merchants you've been charged by more than once. Pick a category to create the rule and apply it everywhere." }),
    list);
}

function categoriesPanel(cats, reload) {
  const list = el("div", {});
  for (const c of cats) {
    list.append(el("div", { class: "row-item" },
      el("span", { class: "dot", style: `background:${c.color}` }),
      el("span", { text: c.name }),
      el("span", { class: "kind-tag", text: c.kind }),
      el("span", { class: "spacer" }),
      el("span", { class: "muted", style: "font-size:12px", text: `${c.tx_count} tx` }),
      el("button", { class: "del", title: "Delete", onclick: async () => {
        if (!confirm(`Delete "${c.name}"? Its transactions become uncategorized.`)) return;
        await api.del(`/api/categories/${c.id}`); await loadCategories(); reload();
      } }, "🗑")));
  }

  const name = el("input", { type: "text", placeholder: "New category", maxlength: "40" });
  const color = el("input", { type: "color", value: "#6366f1" });
  const kind = el("select", {}, ...KINDS.map((k) => el("option", { value: k, text: k })));
  const add = el("button", { class: "btn", onclick: async () => {
    if (!name.value.trim()) return;
    try {
      await api.post("/api/categories", { name: name.value.trim(), color: color.value, kind: kind.value });
      await loadCategories(); reload();
    } catch { toast("That category already exists"); }
  } }, "Add");

  return el("div", { class: "panel" },
    el("h2", { text: "Categories" }),
    list.childElementCount ? list : el("div", { class: "empty", text: "No categories." }),
    el("div", { class: "inline-form" }, name, color, kind, add));
}

function rulesPanel(rules, cats, reload) {
  const list = el("div", {});
  for (const r of rules) {
    list.append(el("div", { class: "row-item" },
      el("code", { text: r.pattern }),
      el("span", { class: "muted", text: "→" }),
      el("span", { class: "nm" }, el("span", { class: "dot", style: `background:${r.category_color}` }), r.category),
      r.is_regex ? el("span", { class: "kind-tag", text: "regex" }) : null,
      el("span", { class: "spacer" }),
      el("button", { class: "del", title: "Delete", onclick: async () => {
        await api.del(`/api/rules/${r.id}`); reload();
      } }, "🗑")));
  }

  const pattern = el("input", { type: "text", placeholder: "merchant contains… (e.g. COSTCO)" });
  const isRegex = el("input", { type: "checkbox" });
  const cat = el("select", {}, ...cats.map((c) => el("option", { value: String(c.id), text: c.name })));
  const preview = el("div", { class: "preview hidden" });

  // Typing a pattern shows what it would catch, live. A rule is cheap to add and
  // annoying to undo across hundreds of rows, so the check belongs before the save.
  let debTimer;
  pattern.addEventListener("input", () => {
    clearTimeout(debTimer);
    const value = pattern.value.trim();
    if (!value) { preview.classList.add("hidden"); return; }
    debTimer = setTimeout(async () => {
      try {
        const pv = await api.post("/api/rules/preview", { pattern: value, is_regex: isRegex.checked });
        preview.classList.remove("hidden");
        preview.replaceChildren(
          el("span", {}, el("strong", { text: String(pv.count) }), ` match · ${money(pv.total_amount)}`),
          pv.already_categorized
            ? el("span", { class: "muted", text: ` · ${pv.already_categorized} already categorized (left alone)` })
            : null,
          el("div", { class: "preview-sample" },
            ...pv.sample.slice(0, 5).map((s) =>
              el("div", { class: "muted", text: `${s.date}  ${s.merchant.slice(0, 58)}  ${money(s.amount)}` }))));
      } catch (e) {
        preview.classList.remove("hidden");
        preview.replaceChildren(el("span", { class: "chg bad", text: "Invalid pattern" }));
      }
    }, 300);
  });
  isRegex.addEventListener("change", () => pattern.dispatchEvent(new Event("input")));

  const add = el("button", { class: "btn", onclick: async () => {
    if (!pattern.value.trim()) return;
    await api.post("/api/rules", { pattern: pattern.value.trim(), is_regex: isRegex.checked, category_id: Number(cat.value) });
    pattern.value = ""; preview.classList.add("hidden"); reload();
  } }, "Add rule");

  const applyBtn = el("button", { class: "ghost", onclick: async () => {
    const res = await api.post("/api/rules/apply");
    toast(`${res.categorized} transaction(s) categorized`); reload();
  } }, "Apply to uncategorized");

  // Re-running over everything can overwrite categories set by hand, so it asks
  // first and says how many rows are at risk.
  const applyAllBtn = el("button", { class: "ghost", onclick: async () => {
    const labelled = cats.reduce((s, c) => s + (c.tx_count || 0), 0);
    if (!confirm(`Re-run every rule over ALL transactions?\n\n${labelled} transaction(s) already have a category and may be overwritten where a rule disagrees.\n\nThis cannot be undone.`)) return;
    const res = await api.post("/api/rules/apply?scope=all");
    toast(`${res.categorized} filled in · ${res.recategorized} changed`); reload();
  } }, "Re-apply to all");

  return el("div", { class: "panel" },
    el("h2", { text: "Auto-categorization rules" }),
    el("p", { class: "muted", style: "font-size:13px;margin-top:-6px", text: "First match wins (by priority). Patterns match the merchant text, case-insensitive." }),
    list.childElementCount ? list : el("div", { class: "empty", text: "No rules yet." }),
    el("div", { class: "inline-form" }, pattern, el("label", { class: "muted" }, isRegex, " regex"), cat, add, applyBtn, applyAllBtn),
    preview);
}
