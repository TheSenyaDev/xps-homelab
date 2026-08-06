const api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async send(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.status === 204 ? null : r.json();
  },
};

// ----- state -----

let meta = { statuses: ["todo", "doing", "blocked", "done"], priorities: ["high", "medium", "low"] };
let categories = [];
let tasks = [];
let tags = [];

// Small enough to be worth keeping across reloads: where you were, not what you have.
const store = {
  get(k, fallback) {
    try { return JSON.parse(localStorage.getItem("senya-tasks:" + k)) ?? fallback; }
    catch { return fallback; }
  },
  set(k, v) { localStorage.setItem("senya-tasks:" + k, JSON.stringify(v)); },
};

let activeCategory = store.get("category", "all"); // "all" | "none" | <id>
let filter = store.get("filter", "all");           // "all" | "active" | <status>
let sortBy = store.get("sort", "created");
let tagFilter = store.get("tag", null);
let collapsed = new Set(store.get("collapsed", []));
let query = "";
const expanded = new Set(); // task ids showing their detail editor

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const STATUS_LABEL = { todo: "todo", doing: "doing", blocked: "blocked", done: "done" };
// Cycled by the status chip. `done` is deliberately absent — the checkbox owns it.
const STATUS_RING = ["todo", "doing", "blocked"];

const today = () => new Date().toISOString().slice(0, 10);

async function load() {
  [meta, categories, tasks, tags] = await Promise.all([
    api.get("/api/meta"),
    api.get("/api/categories"),
    api.get("/api/tasks"),
    api.get("/api/tags"),
  ]);
  render();
}

// ----- category tree helpers -----

const categoryById = (id) => categories.find((c) => c.id === id);
const childrenOf = (pid) => categories.filter((c) => (c.parent_id ?? null) === pid);

function orderedTree() {
  const out = [];
  const walk = (pid, depth) => {
    for (const c of childrenOf(pid)) {
      out.push({ cat: c, depth, hasKids: childrenOf(c.id).length > 0 });
      if (!collapsed.has(c.id)) walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function descendantIds(catId) {
  const ids = new Set([catId]);
  const walk = (pid) => { for (const c of childrenOf(pid)) { ids.add(c.id); walk(c.id); } };
  walk(catId);
  return ids;
}

const openCountForSubtree = (catId) => {
  const ids = descendantIds(catId);
  return tasks.filter((t) => !t.done && ids.has(t.category_id)).length;
};

// ----- sidebar -----

function renderSidebar() {
  const list = document.getElementById("category-list");
  list.innerHTML = "";

  const addRow = (id, name, color, depth, { deletable = false, hasKids = false } = {}) => {
    const row = document.createElement("div");
    row.className = "cat" + (String(activeCategory) === String(id) ? " active" : "");
    row.style.paddingLeft = `${6 + depth * 11}px`;
    const count =
      id === "all" ? tasks.filter((t) => !t.done).length
      : id === "none" ? tasks.filter((t) => !t.done && t.category_id == null).length
      : openCountForSubtree(id);

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.textContent = hasKids ? (collapsed.has(id) ? "▶" : "▼") : "";
    if (hasKids) {
      twisty.onclick = (e) => {
        e.stopPropagation();
        collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
        store.set("collapsed", [...collapsed]);
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
    row.onclick = () => { activeCategory = id; store.set("category", id); render(); };

    if (deletable) {
      const del = document.createElement("button");
      del.className = "icon-btn del";
      del.textContent = "✕";
      del.title = "Delete category";
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${name}"? Subcategories go too; their tasks become uncategorized.`)) return;
        await api.send("DELETE", `/api/categories/${id}`);
        if (descendantIds(id).has(activeCategory)) activeCategory = "all";
        await load();
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
  for (const tag of tags) {
    if (!tag.task_count) continue;
    const b = document.createElement("button");
    b.className = "chip tag" + (tagFilter === tag.name ? " on" : "");
    b.textContent = `#${tag.name} ${tag.task_count}`;
    b.onclick = () => {
      tagFilter = tagFilter === tag.name ? null : tag.name;
      store.set("tag", tagFilter);
      render();
    };
    box.append(b);
  }
}

// ----- filters -----

function renderFilters() {
  const box = document.getElementById("filters");
  if (box.dataset.built) return;              // static once meta is known
  box.dataset.built = "1";
  const opts = [["all", "All"], ["active", "Active"],
    ...meta.statuses.filter((s) => s !== "todo").map((s) => [s, STATUS_LABEL[s] ?? s])];
  for (const [value, label] of opts) {
    const b = document.createElement("button");
    b.textContent = label;
    b.dataset.filter = value;
    b.className = value === filter ? "active" : "";
    b.onclick = () => {
      filter = value;
      store.set("filter", value);
      box.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x.dataset.filter === value));
      renderTasks();
    };
    box.append(b);
  }
}

function visibleTasks() {
  let scope;
  if (activeCategory === "all") scope = null;
  else if (activeCategory === "none") scope = "none";
  else scope = descendantIds(activeCategory);

  const q = query.trim().toLowerCase();
  return tasks.filter((t) => {
    if (scope === "none") { if (t.category_id != null) return false; }
    else if (scope && !scope.has(t.category_id)) return false;
    if (filter === "active" && t.done) return false;
    if (filter !== "all" && filter !== "active" && t.status !== filter) return false;
    if (tagFilter && !t.tags.some((x) => x.name === tagFilter)) return false;
    if (q && !(t.title.toLowerCase().includes(q) || (t.notes || "").toLowerCase().includes(q))) return false;
    return true;
  });
}

// Done always sinks; within that, the chosen key. Missing due dates sort last.
function sortTasks(arr) {
  const key = {
    manual: (a, b) => a.position - b.position,
    created: (a, b) => b.created_at.localeCompare(a.created_at),
    due: (a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999"),
    priority: (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.created_at.localeCompare(a.created_at),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  }[sortBy];
  return [...arr].sort((a, b) => a.done - b.done || key(a, b));
}

// ----- task list -----

function renderTasks() {
  const container = document.getElementById("task-groups");
  const list = visibleTasks();
  container.innerHTML = "";

  document.getElementById("current-count").textContent =
    `${list.filter((t) => !t.done).length} open · ${list.length} shown`;

  if (!list.length) {
    container.innerHTML = `<div class="empty">Nothing here. Add a task above.</div>`;
    return;
  }

  const byCat = new Map();
  for (const t of list) {
    const key = t.category_id ?? "none";
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(t);
  }

  const group = (key, name, color, depth) => {
    const items = byCat.get(key);
    if (!items?.length) return;
    const g = document.createElement("div");
    g.className = "group";
    g.style.marginLeft = `${depth * 12}px`;

    const head = document.createElement("div");
    head.className = "group-head";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = color;
    const label = document.createElement("span");
    label.textContent = name;
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = `${items.filter((t) => !t.done).length}/${items.length}`;
    head.append(dot, label, n);

    const rows = document.createElement("div");
    rows.className = "rows";
    for (const t of sortTasks(items)) {
      rows.append(taskRow(t));
      if (expanded.has(t.id)) rows.append(taskDetail(t));
    }
    g.append(head, rows);
    container.append(g);
  };

  // walk the full tree (not the collapsed sidebar view) so nothing hides
  const walk = (pid, depth) => {
    for (const c of categories.filter((x) => (x.parent_id ?? null) === pid)) {
      group(c.id, c.name, c.color, depth);
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  group("none", "Uncategorized", "#6b7280", 0);
}

function dueChip(t) {
  if (!t.due_date) return null;
  const d = t.due_date;
  const now = today();
  const chip = document.createElement("span");
  chip.className = "chip due" + (d < now ? " overdue" : d === now ? " soon" : "");
  const [, m, day] = d.split("-");
  chip.textContent = d === now ? "today" : `${m}/${day}`;
  chip.title = `Due ${d}`;
  return chip;
}

function taskRow(t) {
  const row = document.createElement("div");
  row.className = `task ${t.priority}${t.done ? " done" : ""}${expanded.has(t.id) ? " open" : ""}`;

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = t.done;
  cb.title = "Toggle done";
  cb.onchange = () => patch(t.id, { done: cb.checked });

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = t.title;
  title.title = t.notes || "Click to rename";
  title.onclick = () => editTitle(t, title);

  const metaBox = document.createElement("span");
  metaBox.className = "meta";

  // one click cycles todo → doing → blocked → todo; the checkbox owns "done"
  const status = document.createElement("button");
  status.className = `chip status-${t.status}`;
  status.textContent = STATUS_LABEL[t.status] ?? t.status;
  status.title = "Cycle status";
  status.onclick = () =>
    patch(t.id, { status: STATUS_RING[(STATUS_RING.indexOf(t.status) + 1) % STATUS_RING.length] });
  metaBox.append(status);

  for (const tag of t.tags) {
    const c = document.createElement("button");
    c.className = "chip tag" + (tagFilter === tag.name ? " on" : "");
    c.textContent = `#${tag.name}`;
    c.onclick = (e) => {
      e.stopPropagation();
      tagFilter = tagFilter === tag.name ? null : tag.name;
      store.set("tag", tagFilter);
      render();
    };
    metaBox.append(c);
  }

  const due = dueChip(t);
  if (due) metaBox.append(due);
  if (t.notes) {
    const n = document.createElement("span");
    n.className = "chip notes";
    n.textContent = "≡";
    n.title = t.notes;
    metaBox.append(n);
  }

  const actions = document.createElement("span");
  actions.className = "row-actions";
  const edit = document.createElement("button");
  edit.className = "icon-btn";
  edit.textContent = expanded.has(t.id) ? "▲" : "▾";
  edit.title = "Details";
  edit.onclick = () => {
    expanded.has(t.id) ? expanded.delete(t.id) : expanded.add(t.id);
    renderTasks();
  };
  const del = document.createElement("button");
  del.className = "icon-btn del";
  del.textContent = "✕";
  del.title = "Delete task";
  del.onclick = async () => {
    await api.send("DELETE", `/api/tasks/${t.id}`);
    expanded.delete(t.id);
    await load();
  };
  actions.append(edit, del);

  row.append(cb, title, metaBox, actions);
  return row;
}

function taskDetail(t) {
  const box = document.createElement("div");
  box.className = "detail";

  const field = (labelText, node) => {
    const l = document.createElement("label");
    l.textContent = labelText;
    box.append(l, node);
    return node;
  };

  const inline = document.createElement("div");
  inline.className = "inline";

  const status = document.createElement("select");
  for (const s of meta.statuses) status.append(new Option(s, s));
  status.value = t.status;
  status.onchange = () => patch(t.id, { status: status.value });

  const priority = document.createElement("select");
  for (const p of meta.priorities) priority.append(new Option(p, p));
  priority.value = t.priority;
  priority.onchange = () => patch(t.id, { priority: priority.value });

  const cat = document.createElement("select");
  cat.append(new Option("— uncategorized —", ""));
  const walk = (pid, depth) => {
    for (const c of categories.filter((x) => (x.parent_id ?? null) === pid)) {
      cat.append(new Option(`${"· ".repeat(depth)}${c.name}`, c.id));
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  cat.value = t.category_id ?? "";
  cat.onchange = () => patch(t.id, { category_id: cat.value === "" ? null : Number(cat.value) });

  const due = document.createElement("input");
  due.type = "date";
  due.value = t.due_date || "";
  due.onchange = () => patch(t.id, { due_date: due.value || null });

  inline.append(status, priority, cat, due);
  field("status", inline);

  const tagInput = document.createElement("input");
  tagInput.type = "text";
  tagInput.placeholder = "comma separated";
  tagInput.value = t.tags.map((x) => x.name).join(", ");
  const commitTags = () => {
    const wanted = tagInput.value.split(",").map((s) => s.trim()).filter(Boolean);
    if (wanted.join(",") !== t.tags.map((x) => x.name).join(",")) patch(t.id, { tags: wanted });
  };
  tagInput.onblur = commitTags;
  tagInput.onkeydown = (e) => { if (e.key === "Enter") tagInput.blur(); };
  field("tags", tagInput);

  const notes = document.createElement("textarea");
  notes.value = t.notes || "";
  notes.placeholder = "Notes…";
  notes.onblur = () => { if (notes.value !== t.notes) patch(t.id, { notes: notes.value }); };
  field("notes", notes);

  const stamps = document.createElement("div");
  stamps.className = "stamps";
  stamps.textContent = [
    `created ${t.created_at}`,
    t.updated_at !== t.created_at ? `updated ${t.updated_at}` : null,
    t.completed_at ? `completed ${t.completed_at}` : null,
  ].filter(Boolean).join("  ·  ");
  box.append(stamps);

  return box;
}

function editTitle(t, span) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "title-input";
  input.value = t.title;
  span.replaceWith(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  let closed = false;
  const commit = async () => {
    if (closed) return;
    closed = true;
    const v = input.value.trim();
    if (v && v !== t.title) await patch(t.id, { title: v });
    else renderTasks();
  };
  input.onblur = commit;
  input.onkeydown = (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { closed = true; renderTasks(); }
  };
}

async function patch(id, body) {
  try {
    await api.send("PATCH", `/api/tasks/${id}`, body);
    await load();
  } catch (err) {
    alert(err.message);
    await load();
  }
}

function render() {
  renderFilters();
  renderSidebar();
  document.getElementById("current-title").textContent =
    activeCategory === "all" ? "All tasks"
    : activeCategory === "none" ? "Uncategorized"
    : (categoryById(activeCategory)?.name ?? "Tasks");
  renderTasks();
}

// ----- events -----

document.getElementById("task-form").onsubmit = async (e) => {
  e.preventDefault();
  const input = document.getElementById("task-title");
  const title = input.value.trim();
  if (!title) return;
  const dueEl = document.getElementById("task-due");
  try {
    await api.send("POST", "/api/tasks", {
      title,
      priority: document.getElementById("task-priority").value,
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
  await load();
  input.focus();
};

document.getElementById("category-form").onsubmit = async (e) => {
  e.preventDefault();
  const nameEl = document.getElementById("category-name");
  const name = nameEl.value.trim();
  if (!name) return;
  const parentVal = document.getElementById("category-parent").value;
  try {
    const cat = await api.send("POST", "/api/categories", {
      name,
      color: document.getElementById("category-color").value,
      parent_id: parentVal ? Number(parentVal) : null,
    });
    nameEl.value = "";
    activeCategory = cat.id;
    store.set("category", cat.id);
    await load();
  } catch (err) {
    alert(err.message);
  }
};

const search = document.getElementById("search");
search.oninput = () => { query = search.value; renderTasks(); };

const sortSel = document.getElementById("sort-by");
sortSel.value = sortBy;
sortSel.onchange = () => { sortBy = sortSel.value; store.set("sort", sortBy); renderTasks(); };

const app = document.querySelector(".app");
const toggleSidebar = () => {
  app.classList.toggle("collapsed");
  store.set("sidebar-collapsed", app.classList.contains("collapsed"));
};
document.getElementById("sidebar-toggle").onclick = toggleSidebar;
document.getElementById("sidebar-show").onclick = toggleSidebar;
if (store.get("sidebar-collapsed", false)) app.classList.add("collapsed");

// Single-key shortcuts, but never while typing into something.
document.onkeydown = (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === "Escape" && !typing && expanded.size) { expanded.clear(); renderTasks(); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); search.focus(); }
  if (e.key === "n") { e.preventDefault(); document.getElementById("task-title").focus(); }
  if (e.key === "\\") { e.preventDefault(); toggleSidebar(); }
};

load();
