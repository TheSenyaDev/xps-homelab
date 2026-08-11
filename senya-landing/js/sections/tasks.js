// SenyaTasks widget — open todos, read through the same-origin /tasks/ proxy.
//
// Shows only what is open: the dashboard is a "what needs doing" surface, and
// completed work belongs in the app itself.
//
// Which categories and how many are widget *settings*, configured in Customize
// alongside size, not controls in the widget itself. A dashboard tile is for
// reading at a glance; putting its configuration on its face costs the space
// twice over — once for the controls, once for the header they need.

import { el, fetchJSON, link } from "../utils.js";
import { configFor } from "../widget-config.js";

const REFRESH_MS = 2 * 60 * 1000;
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

// Defaults live here, beside the schema that declares them, and are read
// through the leaf config module — importing layout.js would make the graph
// circular (layout → registry → this file).
const DEFAULTS = { categories: "", limit: 8 };
const cfg = () => configFor("tasks", DEFAULTS);
const getCats = () => String(cfg().categories || "").split(",").filter(Boolean);
const getLimit = () => Number(cfg().limit) || 8;

/**
 * The widget's settings, for the Customize drawer.
 *
 * A function rather than a static list because the categories come from the
 * API — the drawer awaits this when the widget is expanded, so the list is
 * whatever exists right now rather than whatever existed at page load.
 */
export async function tasksSettings() {
  let categories = [];
  try {
    categories = await fetchJSON("/tasks/api/categories");
  } catch {
    // Offline or off-network: still offer the count, just no category list.
  }
  return [
    {
      key: "categories", label: "Categories", type: "multi", default: "",
      help: "none = all",
      // Only top-level ones: choosing a parent already includes what is nested
      // under it, so listing children too would be a longer list saying less.
      choices: categories
        .filter((c) => c.parent_id == null)
        .map((c) => ({ value: c.id, label: c.name })),
    },
    {
      key: "limit", label: "How many", type: "number", default: 8,
      min: 1, max: 50, help: "rows shown",
    },
  ];
}

// A category filter should include everything nested under the chosen ones —
// picking "Home" and not seeing "Home/Garden" tasks would look like a bug.
function withDescendants(ids, categories) {
  const wanted = new Set(ids.map(Number));
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of categories) {
      if (c.parent_id != null && wanted.has(c.parent_id) && !wanted.has(c.id)) {
        wanted.add(c.id);
        grew = true;
      }
    }
  }
  return wanted;
}

function dueChip(task) {
  if (!task.due_date) return null;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = task.due_date < today;
  const label = task.due_date === today ? "today" : task.due_date.slice(5);
  return el("span", { class: `tk-due${overdue ? " overdue" : ""}`, text: label });
}

function taskRow(task, categoryName) {
  return el("a", {
    class: "tk-row",
    href: `http://${location.hostname}:8000`,
    target: "_blank",
    rel: "noopener noreferrer",
    title: task.notes || task.title,
  },
    el("span", { class: `tk-dot tk-${task.priority}` }),
    el("span", { class: "tk-title", text: task.title }),
    categoryName ? el("span", { class: "tk-cat", text: categoryName }) : null,
    dueChip(task));
}

// A one-line summary of what is being shown, so the widget still says what it
// is filtered to now that the controls live in Customize.
function header(scopeNames, showing, total) {
  const scope = scopeNames.length ? scopeNames.join(" · ") : "all categories";
  return el("div", { class: "tk-head" },
    el("span", { class: "tk-scope", text: scope, title: scope }),
    el("span", { class: "tk-count", text: `${showing}/${total}` }),
    link("open", `http://${location.hostname}:8000`, "pill"));
}

async function load(wrap) {
  try {
    // status=todo excludes done, doing and blocked server-side; the widget is
    // for what has not been started, and the app itself is where the rest lives.
    const [tasks, categories] = await Promise.all([
      fetchJSON("/tasks/api/tasks"),
      fetchJSON("/tasks/api/categories"),
    ]);

    const open = tasks.filter((t) => !t.done);
    const byId = new Map(categories.map((c) => [c.id, c]));
    const chosen = getCats();
    const scope = chosen.length ? withDescendants(chosen, categories) : null;
    let list = scope ? open.filter((t) => scope.has(t.category_id)) : open;

    list = list.sort((a, b) =>
      (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) ||
      (a.due_date || "9999").localeCompare(b.due_date || "9999"));

    const limit = getLimit();
    const shown = list.slice(0, limit);

    const scopeNames = chosen
      .map((id) => byId.get(Number(id))?.name)
      .filter(Boolean);
    wrap.replaceChildren(header(scopeNames, Math.min(shown.length, list.length), list.length));
    if (!shown.length) {
      wrap.append(el("div", { class: "tk-empty", text: "Nothing open." }));
      return;
    }
    const rows = el("div", { class: "tk-rows" },
      ...shown.map((t) => taskRow(t, byId.get(t.category_id)?.name)));
    wrap.append(rows);
    if (list.length > shown.length) {
      wrap.append(el("div", { class: "tk-more", text: `+${list.length - shown.length} more` }));
    }
  } catch {
    wrap.replaceChildren(el("div", { class: "tk-empty", text: "SenyaTasks unavailable." }));
  }
}

let container = null;

export function initTasks() {
  container = document.getElementById("tasks");
  if (!container) return;
  load(container);
  setInterval(() => load(container), REFRESH_MS);
}

/** Called by layout.js when a setting changes, so the change is immediate. */
export function onTasksConfigChange() {
  if (container) load(container);
}
