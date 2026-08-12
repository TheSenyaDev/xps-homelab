// Sidebar: the category tree and the tag cloud.
//
// The tree is the only place categories are drawn, so it owns collapse state
// and the delete affordance. Selecting a category is a view change, announced
// on the bus rather than calling the renderer directly — the sidebar should not
// need to know a calendar exists.

import { api } from "../core/api.js";
import { emit } from "../core/bus.js";
import { $, el } from "../core/dom.js";
import {
  childrenOf, descendantIds, getCategories, getTags, getTasks, openCountForSubtree,
  orderedTree, prefs, setPref,
} from "../core/state.js";
import { reload } from "../core/actions.js";

function renderSidebar() {
  const list = document.getElementById("category-list");
  list.innerHTML = "";

  const addRow = (id, name, color, depth, { deletable = false, hasKids = false } = {}) => {
    const row = document.createElement("div");
    row.className = "cat" + (String(prefs.category) === String(id) ? " active" : "");
    row.style.paddingLeft = `${6 + depth * 11}px`;
    const count =
      id === "all" ? getTasks().filter((t) => !t.done).length
      : id === "none" ? getTasks().filter((t) => !t.done && t.category_id == null).length
      : openCountForSubtree(id);

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.textContent = hasKids ? (prefs.collapsed.has(id) ? "▶" : "▼") : "";
    if (hasKids) {
      twisty.onclick = (e) => {
        e.stopPropagation();
        prefs.collapsed.has(id) ? prefs.collapsed.delete(id) : prefs.collapsed.add(id);
        setPref("collapsed", prefs.collapsed);
        renderSidebar();
      };
    }

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = color;

    const label = document.createElement("span");
    label.className = "name";
    label.textContent = name;

    const n = document.createElement("span");
    n.className = "count";
    n.textContent = count || "";

    row.append(twisty, dot, label, n);
    row.onclick = () => {
      setPref("category", id);
      emit("drawer:close");
      emit("view:changed");
    };

    if (deletable) {
      const del = document.createElement("button");
      del.className = "icon-btn del";
      del.textContent = "✕";
      del.title = "Delete category";
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${name}"? Subcategories go too; their getTasks() become uncategorized.`)) return;
        await api.del(`/api/getCategories()/${id}`);
        if (descendantIds(id).has(prefs.category)) setPref("category", "all");
        await reload();
      };
      row.append(del);
    }
    list.append(row);
  };

  addRow("all", "All tasks", "#6366f1", 0);
  const sep = document.createElement("div");
  sep.className = "sep";
  list.append(sep);
  for (const { cat, depth, hasKids } of orderedTree()) {
    addRow(cat.id, cat.name, cat.color, depth, { deletable: true, hasKids });
  }
  addRow("none", "Uncategorized", "#6b7280", 0);

  // parent picker
  const parentSel = document.getElementById("category-parent");
  const prev = parentSel.value;
  parentSel.innerHTML = '<option value="">— top level —</option>';
  const walkAll = (pid, depth) => {
    for (const c of childrenOf(pid)) {
      parentSel.append(new Option(`${"· ".repeat(depth)}${c.name}`, c.id));
      walkAll(c.id, depth + 1);
    }
  };
  walkAll(null, 0);
  parentSel.value = prev;

  renderTagCloud();
}

function renderTagCloud() {
  const box = document.getElementById("tag-cloud");
  box.innerHTML = "";
  for (const tag of getTags()) {
    if (!tag.task_count) continue;
    const b = document.createElement("button");
    b.className = "chip tag" + (prefs.tag === tag.name ? " on" : "");
    b.textContent = `#${tag.name} ${tag.task_count}`;
    b.onclick = () => {
      setPref("tag", prefs.tag === tag.name ? null : tag.name);
      emit("view:changed");
    };
    box.append(b);
  }
}

export { renderSidebar, renderTagCloud };
