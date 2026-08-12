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

    if (typeof id === "number") {
      row.dataset.catId = String(id);
      row.dataset.depth = String(depth);
      row.addEventListener("pointerdown", (e) => startCatDrag(e, row));
    }

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

// ---- drag to reorder and nest ----
//
// Pointer Events, because HTML5 drag never fires on touch. Two drop targets in
// one gesture: releasing near a row's vertical middle nests inside it, nearer
// an edge drops between rows. That is the whole interaction — a separate
// "nest" mode would mean explaining a mode.

const NEST_BAND = 0.5;      // middle 50% of a row's height nests

let drag = null;            // {row, id, from, moved, marker, target}

function startCatDrag(e, row) {
  // The twisty and the delete button own their clicks.
  if (e.target.closest("button, .twisty")) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  drag = { row, id: Number(row.dataset.catId),
           from: { x: e.clientX, y: e.clientY }, moved: false,
           marker: null, target: null, mode: null };
  const h = e.currentTarget;
  h.setPointerCapture(e.pointerId);
  h.addEventListener("pointermove", onCatMove);
  h.addEventListener("pointerup", endCatDrag);
  h.addEventListener("pointercancel", endCatDrag);
}

function onCatMove(e) {
  if (!drag) return;
  if (!drag.moved) {
    // A threshold, so selecting a category still works as a plain click.
    if (Math.hypot(e.clientX - drag.from.x, e.clientY - drag.from.y) < 5) return;
    drag.moved = true;
    drag.row.classList.add("dragging");
    document.body.classList.add("cat-dragging");
    drag.marker = el("div", { class: "cat-drop-line" });
  }
  e.preventDefault();
  clearHints();

  const rows = [...$("category-list").querySelectorAll(".cat[data-cat-id]")]
    .filter((r) => r !== drag.row && !inSubtree(Number(r.dataset.catId), drag.id));
  const over = rows.find((r) => {
    const b = r.getBoundingClientRect();
    return e.clientY >= b.top && e.clientY <= b.bottom;
  });
  if (!over) { drag.target = null; drag.mode = null; return; }

  const b = over.getBoundingClientRect();
  const rel = (e.clientY - b.top) / b.height;
  drag.target = over;
  if (rel > (1 - NEST_BAND) / 2 && rel < 1 - (1 - NEST_BAND) / 2) {
    drag.mode = "nest";
    over.classList.add("drop-into");
  } else {
    drag.mode = rel <= 0.5 ? "before" : "after";
    drag.marker.style.marginLeft = `${6 + Number(over.dataset.depth) * 11}px`;
    over.parentNode.insertBefore(drag.marker,
      drag.mode === "before" ? over : over.nextSibling);
  }
}

function clearHints() {
  $("category-list").querySelectorAll(".drop-into")
    .forEach((n) => n.classList.remove("drop-into"));
  drag?.marker?.remove();
}

/** Is `id` inside `rootId`'s subtree? Dropping a category into its own subtree
 *  would orphan it, so those rows are not offered as targets at all. */
function inSubtree(id, rootId) {
  let cur = getCategories().find((c) => c.id === id);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    if (cur.id === rootId) return true;
    seen.add(cur.id);
    cur = getCategories().find((c) => c.id === cur.parent_id);
  }
  return false;
}

async function endCatDrag(e) {
  const h = e.currentTarget;
  h.releasePointerCapture?.(e.pointerId);
  h.removeEventListener("pointermove", onCatMove);
  h.removeEventListener("pointerup", endCatDrag);
  h.removeEventListener("pointercancel", endCatDrag);
  if (!drag) return;
  const { id, moved, target, mode } = drag;
  clearHints();
  drag.row.classList.remove("dragging");
  document.body.classList.remove("cat-dragging");
  drag = null;
  if (!moved || !target || !mode) return;

  const targetId = Number(target.dataset.catId);
  const cats = getCategories();
  const moving = cats.find((c) => c.id === id);
  const onto = cats.find((c) => c.id === targetId);
  if (!moving || !onto) return;

  const parent = mode === "nest" ? targetId : onto.parent_id ?? null;
  // Rebuild the destination sibling list with the dragged row in place, then
  // renumber it — sending only the moved row would leave its new siblings with
  // stale positions and the order would settle differently on next load.
  const siblings = cats
    .filter((c) => (c.parent_id ?? null) === (parent ?? null) && c.id !== id)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  let at = siblings.length;
  if (mode !== "nest") {
    const i = siblings.findIndex((c) => c.id === targetId);
    at = mode === "before" ? i : i + 1;
  }
  siblings.splice(at, 0, moving);

  try {
    await api.post("/api/categories/reorder", {
      items: siblings.map((c, i) => ({ id: c.id, parent_id: parent, position: i + 1 })),
    });
    if (mode === "nest") prefs.collapsed.delete(targetId);   // reveal the drop
    await reload();
  } catch (err) {
    alert(`Could not move that category: ${err.message}`);
    await reload();          // put the sidebar back the way the server sees it
  }
}

export { renderSidebar, renderTagCloud };
