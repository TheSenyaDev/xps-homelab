import { api } from "../api.js";
import { el, toast } from "../dom.js";
import { loadCategories, state } from "../state.js";

const KINDS = ["expense", "income", "transfer"];

export async function renderManage(root, ctx = {}) {
  root.replaceChildren(el("div", { class: "empty", text: "Loading…" }));

  async function reload() {
    const [cats, rules] = await Promise.all([api.get("/api/categories"), api.get("/api/rules")]);
    state.categories = cats;
    root.replaceChildren(categoriesPanel(cats, reload), rulesPanel(rules, cats, reload));
  }
  await reload();
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
  const add = el("button", { class: "btn", onclick: async () => {
    if (!pattern.value.trim()) return;
    await api.post("/api/rules", { pattern: pattern.value.trim(), is_regex: isRegex.checked, category_id: Number(cat.value) });
    pattern.value = ""; reload();
  } }, "Add rule");
  const applyBtn = el("button", { class: "ghost", onclick: async () => {
    const res = await api.post("/api/rules/apply");
    toast(`${res.categorized} transaction(s) categorized`); reload();
  } }, "Apply to uncategorized");

  return el("div", { class: "panel" },
    el("h2", { text: "Auto-categorization rules" }),
    el("p", { class: "muted", style: "font-size:13px;margin-top:-6px", text: "First match wins (by priority). Patterns match the merchant text, case-insensitive." }),
    list.childElementCount ? list : el("div", { class: "empty", text: "No rules yet." }),
    el("div", { class: "inline-form" }, pattern, el("label", { class: "muted" }, isRegex, " regex"), cat, add, applyBtn));
}
