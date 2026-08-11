// SenyaTasks widget — open todos, read through the same-origin /tasks/ proxy.
//
// Shows only what is open: the dashboard is a "what needs doing" surface, and
// completed work belongs in the app itself. Which categories and how many are
// chosen in the widget header and remembered per browser, because the useful
// answer differs by person and by day and is not worth a round trip to change.

import { el, fetchJSON, link, store } from "../utils.js";

const REFRESH_MS = 2 * 60 * 1000;
const CAT_KEY = "senya.tasks.categories";   // "" = all
const LIMIT_KEY = "senya.tasks.limit";
const LIMITS = [5, 8, 12, 20];

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

const getCats = () => (store.get(CAT_KEY, "") || "").split(",").filter(Boolean);
const getLimit = () => parseInt(store.get(LIMIT_KEY, "8"), 10) || 8;

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

function header(wrap, categories, counts) {
  const chosen = getCats();

  // A multi-select would be fiddly at this size; one dropdown with "all" plus
  // each top-level category covers what a dashboard needs.
  const sel = el("select", { class: "tk-sel", title: "Categories" },
    el("option", { value: "", text: `All (${counts.total})` }),
    ...categories
      .filter((c) => c.parent_id == null)
      .map((c) => el("option", {
        value: String(c.id),
        text: `${c.name}${counts.byCat[c.id] ? ` (${counts.byCat[c.id]})` : ""}`,
      })));
  sel.value = chosen[0] || "";
  sel.onchange = () => {
    store.set(CAT_KEY, sel.value);
    load(wrap);
  };

  const lim = el("select", { class: "tk-sel tk-lim", title: "How many to show" },
    ...LIMITS.map((n) => el("option", { value: String(n), text: `${n}` })));
  lim.value = String(getLimit());
  lim.onchange = () => {
    store.set(LIMIT_KEY, lim.value);
    load(wrap);
  };

  return el("div", { class: "tk-head" }, sel, lim,
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
    const counts = { total: open.length, byCat: {} };
    for (const t of open) {
      // Count against the top-level ancestor, so the dropdown's numbers match
      // what picking that entry would show.
      let c = byId.get(t.category_id);
      while (c && c.parent_id != null) c = byId.get(c.parent_id);
      if (c) counts.byCat[c.id] = (counts.byCat[c.id] || 0) + 1;
    }

    const chosen = getCats();
    const scope = chosen.length ? withDescendants(chosen, categories) : null;
    let list = scope ? open.filter((t) => scope.has(t.category_id)) : open;

    list = list.sort((a, b) =>
      (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) ||
      (a.due_date || "9999").localeCompare(b.due_date || "9999"));

    const limit = getLimit();
    const shown = list.slice(0, limit);

    wrap.replaceChildren(header(wrap, categories, counts));
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

export function initTasks() {
  const wrap = document.getElementById("tasks");
  if (!wrap) return;
  load(wrap);
  setInterval(() => load(wrap), REFRESH_MS);
}
