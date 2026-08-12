// The chrome around the views: the new-task form, the category form, search,
// sort, the sidebar toggle, export, the view switch and month navigation, and
// the keyboard shortcuts.
//
// Grouped because they are all one-line wirings onto elements that already
// exist in the markup — splitting them further would mean a file per button.

import { api } from "../core/api.js";
import { reload } from "../core/actions.js";
import { emit, on } from "../core/bus.js";
import { $, $$, el } from "../core/dom.js";
import { iso, today } from "../core/format.js";
import {
  getCategories, getMeta, getTasks, prefs, setPref, setQuery,
} from "../core/state.js";
import { render, renderView, setView } from "../view.js";

let categories = [];
on("data:changed", () => { categories = getCategories(); });

export function init() {
  $("task-form").onsubmit = async (e) => {
    e.preventDefault();
    const input = $("task-title");
    const title = input.value.trim();
    if (!title) return;
    const dueEl = $("task-due");
    try {
      await api.send("POST", "/api/tasks", {
        title,
        priority: $("task-priority").value,
        due_date: dueEl.value || null,
        category_id: typeof activeCategory === "number" ? activeCategory : null,
        tags: tagFilter ? [tagFilter] : [],
      });
    } catch (err) {
      alert(err.message);
      return;
    }
    input.value = "";
    dueEl.value = "";
    await reload();
    input.focus();
  };

  $("category-form").onsubmit = async (e) => {
    e.preventDefault();
    const nameEl = $("category-name");
    const name = nameEl.value.trim();
    if (!name) return;
    const parentVal = $("category-parent").value;
    try {
      const cat = await api.send("POST", "/api/categories", {
        name,
        color: $("category-color").value,
        parent_id: parentVal ? Number(parentVal) : null,
      });
      nameEl.value = "";
      activeCategory = cat.id;
      store.set("category", cat.id);
      await reload();
    } catch (err) {
      alert(err.message);
    }
  };

  const search = $("search");
  search.oninput = () => { query = search.value; renderView(); };

  const sortSel = $("sort-by");
  sortSel.value = sortBy;
  sortSel.onchange = () => { sortBy = sortSel.value; store.set("sort", sortBy); renderView(); };

  const app = document.querySelector(".app");

  // Narrow screens get an off-canvas drawer; wide ones collapse the column.
  // Keep the breakpoint in step with the mobile block in style.css.
  const isNarrow = () =>
    window.matchMedia?.("(max-width: 760px)").matches ?? window.innerWidth <= 760;
  const toggleSidebar = () => {
    if (isNarrow()) {
      app.classList.toggle("drawer-open");
      return;
    }
    app.classList.toggle("collapsed");
    store.set("sidebar-collapsed", app.classList.contains("collapsed"));
  };
  const closeDrawer = () => app.classList.remove("drawer-open");

  $("sidebar-toggle").onclick = toggleSidebar;
  $("sidebar-show").onclick = toggleSidebar;
  document.querySelector(".drawer-scrim")?.addEventListener("click", closeDrawer);
  if (store.get("sidebar-collapsed", false)) app.classList.add("collapsed");

  // Collapse a date input to its picker icon while it's empty (see style.css).
  function watchDateInput(el) {
    const sync = () => el.classList.toggle("has-value", !!el.value);
    el.addEventListener("input", sync);
    el.addEventListener("change", sync);
    sync();
  }
  document.querySelectorAll('input[type="date"]').forEach(watchDateInput);

  // Export exactly what's on screen: the search box and tag chips filter
  // client-side, so the ids are the only faithful description of the view.
  $("btn-export").onclick = () => {
    const ids = visibleTasks().map((t) => t.id);
    if (!ids.length) { alert("Nothing to export in this view."); return; }
    // An anchor with `download` saves the file without navigating away, so the
    // page keeps its scroll position and open panels.
    const a = document.createElement("a");
    a.href = `/api/export?download=1&ids=${ids.join(",")}`;
    a.download = "";
    document.body.append(a);
    a.click();
    a.remove();
  };

  for (const btn of document.querySelectorAll("#views button")) {
    btn.onclick = () => setView(btn.dataset.view);
  }
  const shiftMonth = (delta) => {
    calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + delta, 1);
    activeDay = null;
    renderCalendar();
  };
  $("cal-prev").onclick = () => shiftMonth(-1);
  $("cal-next").onclick = () => shiftMonth(1);
  $("cal-today").onclick = () => {
    const now = new Date();
    calCursor = new Date(now.getFullYear(), now.getMonth(), 1);
    activeDay = null;
    renderCalendar();
  };

    if (e.key === "Escape" && !syncModal.hidden) { syncModal.hidden = true; return; }
    if (e.key === "Escape" && !modal.hidden) { closeImport(); return; }
    if (e.key === "Escape" && !typing && expanded.size) { expanded.clear(); renderTasks(); return; }
    if (!modal.hidden || !syncModal.hidden) return;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); search.focus(); }
    if (e.key === "n") { e.preventDefault(); $("task-title").focus(); }
    if (e.key === "\\") { e.preventDefault(); toggleSidebar(); }
    if (e.key === "c") { e.preventDefault(); setView(view === "calendar" ? "list" : "calendar"); }
    if (view === "calendar" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      shiftMonth(e.key === "ArrowLeft" ? -1 : 1);
    }
  };

  // Restore the stored view after the first render, so the toggle, the sort
  // visibility and the rendered pane all start out agreeing with each other.
  load().then(() => setView(view));

}
