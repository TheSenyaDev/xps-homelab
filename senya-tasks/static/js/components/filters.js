// The status filter chips. Counts come from the same selectors the list uses,
// so a chip can never claim a number the list does not show.

import { emit, on } from "../core/bus.js";
import { $, el } from "../core/dom.js";
import { STATUS_LABEL } from "../core/format.js";
import { getCategories, getMeta, getTags, getTasks, prefs, setPref } from "../core/state.js";

// Module-local mirrors, refreshed on reload. Plain bindings so the code below
// reads exactly as it did before the split — renaming into string literals is
// how a mechanical refactor ships a silent bug.
let meta = {}, categories = [], tasks = [], tags = [];
function syncMirrors() {
  meta = getMeta(); categories = getCategories(); tasks = getTasks(); tags = getTags();
}
on("data:changed", syncMirrors);

export { renderFilters };

function renderFilters() {
  const box = $("filters");
  if (box.dataset.built) return;              // static once meta is known
  box.dataset.built = "1";
  const opts = [["all", "All"], ["active", "Active"],
    ...meta.statuses.filter((s) => s !== "todo").map((s) => [s, STATUS_LABEL[s] ?? s])];
  for (const [value, label] of opts) {
    const b = document.createElement("button");
    b.textContent = label;
    b.dataset.filter = value;
    b.className = value === prefs.filter ? "active" : "";
    b.onclick = () => {
      setPref("filter", value);
      box.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x.dataset.filter === value));
      renderView();
    };
    box.append(b);
  }
}
