// What gets drawn, and when.
//
// The one place that knows every view exists. Components render themselves;
// this decides which to call, so no component has to import another just to
// refresh it — the reason the old file had render() reaching into everything
// from the middle of the calendar code.

import { on } from "./core/bus.js";
import { $, $$ } from "./core/dom.js";
import { categoryById, prefs, setPref } from "./core/state.js";
import { renderCalendar } from "./components/calendar.js";
import { renderFilters } from "./components/filters.js";
import { renderSidebar } from "./components/sidebar.js";
import { renderTasks } from "./components/task-list.js";

export function setView(next) {
  setPref("view", next);
  $$("#views button").forEach(
    (b) => b.classList.toggle("active", b.dataset.view === next));
  // Sorting is a list-only idea; the calendar is ordered by date.
  document.querySelector(".sort").hidden = next === "calendar";
  renderView();
}

/** Just the part that shows tasks — the cheap redraw. */
export function renderView() {
  const isCal = prefs.view === "calendar";
  $("task-groups").hidden = isCal;
  $("calendar").hidden = !isCal;
  if (isCal) renderCalendar(); else renderTasks();
}

/** Everything: the tree, the chips, the title and the tasks. Used after a data
 *  change, where counts and the category tree move too. */
export function render() {
  renderFilters();
  renderSidebar();   // draws the tag cloud too
  $("current-title").textContent =
    prefs.category === "all" ? "All tasks"
    : prefs.category === "none" ? "Uncategorized"
    : (categoryById(prefs.category)?.name ?? "Tasks");
  renderView();
}

on("data:changed", render);
on("view:changed", render);
