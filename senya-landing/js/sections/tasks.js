// SenyaTasks widget — open todos, read through the same-origin /tasks/ proxy.
//
// Shows only what is open: the dashboard is a "what needs doing" surface, and
// completed work belongs in the app itself.
//
// Which categories is a widget *setting*, configured in Customize alongside
// size, not a control in the widget itself. A dashboard tile is for reading at
// a glance; putting its configuration on its face costs the space twice over —
// once for the controls, once for the header they need.
//
// How many rows is not a setting: the widget fills the height it is given, so
// resizing it taller shows more. See fillRows().

import { el, fetchJSON, link } from "../utils.js";
import { configFor } from "../widget-config.js";

const REFRESH_MS = 2 * 60 * 1000;
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

// Rows to show when the body cannot be measured — only reachable if the widget
// is rendered while it has no laid-out height (display:none ancestor).
const FALLBACK_ROWS = 8;

// Defaults live here, beside the schema that declares them, and are read
// through the leaf config module — importing layout.js would make the graph
// circular (layout → registry → this file).
const DEFAULTS = { categories: "" };
const cfg = () => configFor("tasks", DEFAULTS);
const getCats = () => String(cfg().categories || "").split(",").filter(Boolean);

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
// is filtered to now that the controls live in Customize. The count is filled
// in after the rows are laid out — how many are shown isn't known until then.
function header(scopeNames) {
  const scope = scopeNames.length ? scopeNames.join(" · ") : "all categories";
  return el("div", { class: "tk-head" },
    el("span", { class: "tk-scope", text: scope, title: scope }),
    el("span", { class: "tk-count" }),
    link("open", `http://${location.hostname}:8000`, "pill"));
}

function setCount(head, showing, total) {
  head.querySelector(".tk-count").textContent = `${showing}/${total}`;
}

/** The body's own content height, less whatever the header takes. */
function spaceForRows(wrap, head) {
  const cs = getComputedStyle(wrap);
  const inner = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  return inner - head.offsetHeight;
}

/**
 * Append as many rows as fit the widget's height, and return how many that was.
 *
 * Rows are measured rather than assumed: their height moves with the UI scale
 * (`--fs`), so a hardcoded number would be wrong on any setting but one. Two
 * rows go in first because the distance between their tops is the true pitch,
 * separator included — measuring a single row misses it, since the only row in
 * the list is also the last one and `:last-child` drops the border.
 *
 * Floor, so a row that would be clipped is left out entirely: a half-visible
 * task reads as a rendering fault, and the header's `showing/total` already
 * says that there are more.
 */
function fillRows(wrap, head, list, byId) {
  const rows = el("div", { class: "tk-rows" });
  wrap.append(rows);
  const build = (t) => rows.append(taskRow(t, byId.get(t.category_id)?.name));
  list.slice(0, 2).forEach(build);

  const avail = spaceForRows(wrap, head);
  const pitch = rows.children.length > 1
    ? rows.children[1].offsetTop - rows.children[0].offsetTop
    : rows.children[0].offsetHeight;
  // Unmeasurable only when the widget has no laid-out height at all.
  const fits = avail > 0 && pitch > 0 ? Math.floor(avail / pitch) : FALLBACK_ROWS;
  const capacity = Math.min(list.length, Math.max(1, fits));

  list.slice(rows.children.length, capacity).forEach(build);
  while (rows.children.length > capacity) rows.lastElementChild.remove();
  return capacity;
}

// The last loaded data, so a resize can re-fit the rows without re-fetching.
let latest = null;

function render(wrap) {
  if (!latest) return;
  const { list, byId, scopeNames } = latest;
  const head = header(scopeNames);
  wrap.replaceChildren(head);
  if (!list.length) {
    wrap.append(el("div", { class: "tk-empty", text: "Nothing open." }));
    setCount(head, 0, 0);
    return;
  }
  setCount(head, fillRows(wrap, head, list, byId), list.length);
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

    const scopeNames = chosen
      .map((id) => byId.get(Number(id))?.name)
      .filter(Boolean);
    latest = { list, byId, scopeNames };
    render(wrap);
  } catch {
    latest = null;
    wrap.replaceChildren(el("div", { class: "tk-empty", text: "SenyaTasks unavailable." }));
  }
}

let container = null;

/**
 * Re-fit the rows whenever the body's height changes — a drag on the resize
 * grip, a column-count breakpoint, a sibling widget growing the grid row.
 *
 * Keyed on height alone: rows are single-line and ellipsised, so a width change
 * cannot change how many fit, and re-rendering through a horizontal drag would
 * be work with nothing to show for it. Re-rendering cannot itself change the
 * height (the body is a fixed box — see the `[data-section="tasks"]` rule in
 * styles/components.css), so this does not feed back into itself.
 */
function watchHeight(wrap) {
  if (!window.ResizeObserver) return;
  let height = wrap.clientHeight;
  new ResizeObserver(() => {
    if (wrap.clientHeight === height) return;
    height = wrap.clientHeight;
    render(wrap);
  }).observe(wrap);
}

export function initTasks() {
  container = document.getElementById("tasks");
  if (!container) return;
  load(container);
  watchHeight(container);
  setInterval(() => load(container), REFRESH_MS);
}

/** Called by layout.js when a setting changes, so the change is immediate. */
export function onTasksConfigChange() {
  if (container) load(container);
}
