// Application state: the data from the server, the view preferences, and the
// selectors that turn one into what a component should render.
//
// Behind accessors rather than exported `let`s: several components read the
// same values, and a module-level binding read from another file is a snapshot,
// not a live view. Preferences persist; data does not.

import { api } from "./api.js";
import { store } from "./store.js";
import { PRIORITY_RANK } from "./format.js";

// ---- server data ----

let meta = { statuses: ["todo", "doing", "blocked", "done"],
             priorities: ["high", "medium", "low"] };
let categories = [];
let tasks = [];
let tags = [];

export const getMeta = () => meta;
export const getCategories = () => categories;
export const getTasks = () => tasks;
export const getTags = () => tags;

// ---- view preferences (persisted) ----

export const prefs = {
  category: store.get("category", "all"),   // "all" | "none" | <id>
  filter: store.get("filter", "all"),       // "all" | "active" | <status>
  sortBy: store.get("sort", "created"),
  tag: store.get("tag", null),
  view: store.get("view", "list"),          // "list" | "calendar"
  // Two separate collapse sets, because they hide different things: `collapsed`
  // folds a branch of the sidebar tree out of sight, `collapsedGroups` folds a
  // category's tasks in the list. Sharing one would mean narrowing the sidebar
  // silently emptied the list.
  collapsed: new Set(store.get("collapsed", [])),
  collapsedGroups: new Set(store.get("collapsedGroups", [])),
};

/** Set a preference and persist it. The collapse prefs are Sets, so they are
 *  stored as arrays rather than through JSON's default (which would give {}). */
export function setPref(key, value) {
  prefs[key] = value;
  store.set(key === "sortBy" ? "sort" : key,
            value instanceof Set ? [...value] : value);
}

// ---- transient (not worth persisting) ----

export let query = "";
export const setQuery = (v) => { query = v; };

export const expanded = new Set();   // task ids showing their detail editor

// From the server's settings, not localStorage: how many tasks a completed one
// hides behind is a property of the list, not of this browser.
let completedShown = 3;
export const getCompletedShown = () => completedShown;

// ---- loading ----

export async function load() {
  let settings;
  [meta, categories, tasks, tags, settings] = await Promise.all([
    api.get("/api/meta"),
    api.get("/api/categories"),
    api.get("/api/tasks"),
    api.get("/api/tags"),
    api.get("/api/settings").catch(() => null),
  ]);
  if (settings) completedShown = settings.values.completed_shown;
}

export const setCompletedShown = (n) => { completedShown = n; };

// ---- category tree ----

export const categoryById = (id) => categories.find((c) => c.id === id);
export const childrenOf = (pid) =>
  categories.filter((c) => (c.parent_id ?? null) === pid);

/** Depth-first, honouring collapsed nodes — what the sidebar draws. */
export function orderedTree() {
  const out = [];
  const walk = (pid, depth) => {
    for (const c of childrenOf(pid)) {
      out.push({ cat: c, depth, hasKids: childrenOf(c.id).length > 0 });
      if (!prefs.collapsed.has(c.id)) walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** A category and everything nested under it — picking a parent must include
 *  its children, or the count and the list would disagree. */
export function descendantIds(catId) {
  const ids = new Set([catId]);
  const walk = (pid) => {
    for (const c of childrenOf(pid)) { ids.add(c.id); walk(c.id); }
  };
  walk(catId);
  return ids;
}

export const openCountForSubtree = (catId) => {
  const ids = descendantIds(catId);
  return tasks.filter((t) => !t.done && ids.has(t.category_id)).length;
};

// ---- selectors ----

/** Everything passing the current category, status, tag and search filters. */
export function visibleTasks() {
  let scope = null;
  if (prefs.category === "all") scope = null;
  else if (prefs.category === "none") scope = "none";
  else scope = descendantIds(prefs.category);

  const q = query.trim().toLowerCase();
  return tasks.filter((t) => {
    if (scope === "none") { if (t.category_id != null) return false; }
    else if (scope && !scope.has(t.category_id)) return false;
    if (prefs.filter === "active" && t.done) return false;
    if (prefs.filter !== "all" && prefs.filter !== "active" && t.status !== prefs.filter) return false;
    if (prefs.tag && !t.tags.some((x) => x.name === prefs.tag)) return false;
    if (q && !(t.title.toLowerCase().includes(q) ||
               (t.notes || "").toLowerCase().includes(q))) return false;
    return true;
  });
}

/**
 * Keep only the most recently completed `completedShown`.
 *
 * Applied after filtering so the cap counts what is actually on screen, and
 * skipped when the `done` filter deliberately asks for them — asking to see
 * done tasks and being shown three would be a bug, not a tidy-up.
 */
export function trimCompleted(arr) {
  if (prefs.filter === "done") return arr;
  const done = arr.filter((t) => t.done);
  if (done.length <= completedShown) return arr;
  const keep = new Set(
    [...done]
      .sort((a, b) => (b.completed_at || b.updated_at || "")
        .localeCompare(a.completed_at || a.updated_at || ""))
      .slice(0, completedShown)
      .map((t) => t.id));
  return arr.filter((t) => !t.done || keep.has(t.id));
}

/** Done always sinks; within that, the chosen key. Missing due dates last. */
export function sortTasks(arr) {
  const key = {
    manual: (a, b) => a.position - b.position,
    created: (a, b) => b.created_at.localeCompare(a.created_at),
    due: (a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999"),
    priority: (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      b.created_at.localeCompare(a.created_at),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  }[prefs.sortBy];
  return [...arr].sort((a, b) => a.done - b.done || key(a, b));
}

/** Subtasks of a task, in list order. */
export const subtasksOf = (id) => tasks.filter((t) => t.parent_id === id);
