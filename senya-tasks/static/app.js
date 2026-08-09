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

// Tiny element builder: el("div", {class, text, onclick, …}, ...children).
// Children that are null are dropped, so callers can inline conditionals.
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...kids.filter((k) => k != null));
  return n;
}

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
    row.onclick = () => {
      activeCategory = id;
      store.set("category", id);
      closeDrawer();
      render();
    };

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
      renderView();
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
    const open = items.filter((t) => !t.done).length;
    n.textContent = open ? `${open} open` : "done";
    // rule trails the label instead of stranding the count on the far right
    const rule = document.createElement("span");
    rule.className = "rule";
    head.append(dot, label, n, rule);

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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Own column so dates line up down the list. Empty cell when there's no date —
// the column still reserves its width, which is what keeps the alignment.
function dueCell(t) {
  const cell = document.createElement("span");
  cell.className = "due";
  if (!t.due_date) return cell;

  const d = t.due_date;
  const now = today();
  // classList.add("") throws, so only tag the states that have a class
  if (d < now) cell.classList.add("overdue");
  else if (d === now) cell.classList.add("soon");
  const [y, m, day] = d.split("-");
  const thisYear = now.slice(0, 4) === y;
  cell.textContent = d === now
    ? "today"
    : `${MONTHS[Number(m) - 1]} ${Number(day)}` + (thisYear ? "" : ` ’${y.slice(2)}`);
  cell.title = `Due ${d}`;
  return cell;
}

function taskRow(t) {
  const row = document.createElement("div");
  row.className = `task${t.done ? " done" : ""}${expanded.has(t.id) ? " open" : ""}`;

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = t.done;
  cb.title = "Toggle done";
  cb.onchange = () => patch(t.id, { done: cb.checked });

  // Everything that describes the task rides next to the title rather than
  // being flung to the right edge of a wide screen.
  const main = document.createElement("span");
  main.className = "main";

  const prio = document.createElement("span");
  prio.className = `prio ${t.priority}`;
  prio.title = `${t.priority} priority`;

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

  main.append(prio, title, metaBox);
  row.append(cb, main, dueCell(t), actions);
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
  watchDateInput(due);

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

// ----- calendar view -----

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
                     "August", "September", "October", "November", "December"];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-` +
                   `${String(d.getDate()).padStart(2, "0")}`;

let view = store.get("view", "list");     // "list" | "calendar"
let calCursor = null;                     // first of the displayed month

function renderCalendar() {
  const grid = document.getElementById("cal-grid");
  const dow = document.getElementById("cal-dow");
  if (!calCursor) {
    const now = new Date();
    calCursor = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  document.getElementById("cal-title").textContent =
    `${MONTH_NAMES[calCursor.getMonth()]} ${calCursor.getFullYear()}`;
  if (!dow.children.length) {
    dow.replaceChildren(...DOW.map((d) => el("span", { text: d })));
  }

  // Same task set the list would show, so switching views never changes what
  // you're looking at — only how.
  const list = visibleTasks();
  const byDay = new Map();
  const unscheduled = [];
  for (const t of list) {
    if (!t.due_date) { unscheduled.push(t); continue; }
    if (!byDay.has(t.due_date)) byDay.set(t.due_date, []);
    byDay.get(t.due_date).push(t);
  }

  // Full weeks: back to the Sunday on/before the 1st, forward to a whole grid.
  const start = new Date(calCursor);
  start.setDate(1 - start.getDay());
  const cells = [];
  const today = iso(new Date());
  const monthOf = calCursor.getMonth();

  for (let i = 0; i < 42; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const key = iso(day);
    const items = sortTasks(byDay.get(key) || []);
    const open = items.filter((t) => !t.done).length;

    const cell = el("div", {
      class: "cal-day"
        + (day.getMonth() === monthOf ? "" : " other-month")
        + (key === today ? " today" : "")
        + (key < today && open ? " overdue" : ""),
    });
    const head = el("div", { class: "cal-day-head" },
      el("span", { class: "n", text: String(day.getDate()) }),
      items.length ? el("span", { class: "cal-day-count", text: String(items.length) }) : null);
    cell.append(head);

    for (const t of items.slice(0, 4)) cell.append(calChip(t));
    if (items.length > 4) {
      cell.append(el("button", {
        class: "cal-more", text: `+${items.length - 4} more`,
        onclick: () => { activeDay = activeDay === key ? null : key; renderCalendar(); },
      }));
    }
    if (activeDay === key) {
      for (const t of items.slice(4)) cell.append(calChip(t));
    }
    // Clicking empty space schedules something for that day.
    cell.addEventListener("click", (e) => {
      if (e.target !== cell && e.target !== head) return;
      const input = document.getElementById("task-title");
      const due = document.getElementById("task-due");
      due.value = key;
      due.dispatchEvent(new Event("input"));
      input.focus();
    });
    cells.push(cell);
    // Stop after a complete week once the month is behind us (5 rows, not 6).
    if (i >= 34 && (i + 1) % 7 === 0 && day.getMonth() !== monthOf) break;
  }
  grid.replaceChildren(...cells);

  const box = document.getElementById("cal-unscheduled");
  box.replaceChildren();
  if (unscheduled.length) {
    box.append(el("div", { class: "cal-unscheduled-head",
                           text: `No due date · ${unscheduled.length}` }));
    const strip = el("div", { class: "cal-unscheduled-items" });
    for (const t of sortTasks(unscheduled)) strip.append(calChip(t));
    box.append(strip);
  }

  document.getElementById("cal-summary").textContent =
    `${list.filter((t) => !t.done).length} open · ${list.length} shown`;
  document.getElementById("current-count").textContent =
    `${list.filter((t) => !t.done).length} open · ${list.length} shown`;
}

let activeDay = null;   // day whose overflow tasks are expanded

function calChip(t) {
  const chip = el("button", {
    class: `cal-chip ${t.priority}${t.done ? " done" : ""}`,
    title: `${t.title}${t.notes ? "\n\n" + t.notes : ""}\n\nClick to open`,
  },
    el("span", { class: "prio " + t.priority }),
    el("span", { class: "cal-chip-title", text: t.title }));
  // Opening a task is the list view's job — jump there with it expanded rather
  // than building a second, half-featured editor inside the calendar.
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    expanded.add(t.id);
    setView("list");
    const row = [...document.querySelectorAll(".task .title")]
      .find((n) => n.textContent === t.title);
    row?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  });
  return chip;
}

function setView(next) {
  view = next;
  store.set("view", next);
  document.querySelectorAll("#views button").forEach(
    (b) => b.classList.toggle("active", b.dataset.view === next));
  // Sorting is a list-only idea; the calendar is ordered by date.
  document.querySelector(".sort").hidden = next === "calendar";
  renderView();
}

function renderView() {
  const cal = document.getElementById("calendar");
  const groups = document.getElementById("task-groups");
  const isCal = view === "calendar";
  groups.hidden = isCal;
  cal.hidden = !isCal;
  if (isCal) renderCalendar(); else renderTasks();
}

function render() {
  renderFilters();
  renderSidebar();
  document.getElementById("current-title").textContent =
    activeCategory === "all" ? "All tasks"
    : activeCategory === "none" ? "Uncategorized"
    : (categoryById(activeCategory)?.name ?? "Tasks");
  renderView();
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
search.oninput = () => { query = search.value; renderView(); };

const sortSel = document.getElementById("sort-by");
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

document.getElementById("sidebar-toggle").onclick = toggleSidebar;
document.getElementById("sidebar-show").onclick = toggleSidebar;
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

// ----- export -----

// Export exactly what's on screen: the search box and tag chips filter
// client-side, so the ids are the only faithful description of the view.
document.getElementById("btn-export").onclick = () => {
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

// ----- import -----

let importItems = [];
const modal = document.getElementById("import-modal");
const $i = (id) => document.getElementById(id);

function openImport() {
  const sel = $i("import-default-status");
  if (!sel.options.length) for (const s of meta.statuses) sel.append(new Option(s, s));
  sel.value = "todo";
  importItems = [];
  $i("import-text").value = "";
  showImportStep("paste");
  modal.hidden = false;
  $i("import-text").focus();
}

function closeImport() { modal.hidden = true; }

function showImportStep(step) {
  const reviewing = step === "review";
  $i("import-paste").hidden = reviewing;
  $i("import-review").hidden = !reviewing;
  $i("import-parse").hidden = reviewing;
  $i("import-commit").hidden = !reviewing;
  $i("import-back").hidden = !reviewing;
  $i("import-step").textContent = reviewing ? "2 · review" : "1 · paste";
}

document.getElementById("btn-import").onclick = openImport;
$i("import-close").onclick = closeImport;
$i("import-back").onclick = () => showImportStep("paste");
modal.onclick = (e) => { if (e.target === modal) closeImport(); };

$i("import-parse").onclick = async () => {
  const markdown = $i("import-text").value;
  if (!markdown.trim()) { alert("Paste some markdown first."); return; }
  try {
    const res = await api.send("POST", "/api/import/preview", {
      markdown,
      default_status: $i("import-default-status").value,
    });
    importItems = res.items;
    if (!importItems.length) { alert("No tasks or list items found in that text."); return; }
    showImportStep("review");
    renderReview();
  } catch (err) {
    alert(err.message);
  }
};

function renderReview() {
  const box = $i("import-rows");
  box.innerHTML = "";

  const head = document.createElement("div");
  head.className = "review-head";
  for (const h of ["", "title", "status", "priority", "due", "tags", "category"]) {
    const s = document.createElement("span");
    s.textContent = h;
    head.append(s);
  }
  box.append(head);

  importItems.forEach((item, idx) => {
    const row = document.createElement("div");
    const hasWarn = item.warnings.length > 0;
    row.className = "review-row" + (hasWarn ? " warn" : "") + (item.duplicate ? " dupe" : "") +
      (item.include ? "" : " off");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.include;
    cb.title = "Include in the import";
    cb.onchange = () => {
      item.include = cb.checked;
      row.classList.toggle("off", !cb.checked);
      updateImportSummary();
    };

    const title = document.createElement("input");
    title.type = "text";
    title.value = item.title;
    title.oninput = () => { item.title = title.value; };

    const status = document.createElement("select");
    for (const s of meta.statuses) status.append(new Option(s, s));
    status.value = item.status;
    status.onchange = () => { item.status = status.value; };

    const priority = document.createElement("select");
    for (const p of meta.priorities) priority.append(new Option(p, p));
    priority.value = item.priority;
    priority.onchange = () => { item.priority = priority.value; };

    const due = document.createElement("input");
    due.type = "date";
    due.value = item.due_date || "";
    due.onchange = () => { item.due_date = due.value || null; };
    watchDateInput(due);

    const tags = document.createElement("input");
    tags.type = "text";
    tags.placeholder = "tags";
    tags.value = item.tags.join(", ");
    tags.oninput = () => {
      item.tags = tags.value.split(",").map((s) => s.trim()).filter(Boolean);
    };

    const cat = document.createElement("input");
    cat.type = "text";
    cat.placeholder = "category / path";
    cat.value = item.category_path.join(" / ");
    cat.title = "Slash-separated path, e.g. Home / Garage";
    cat.oninput = () => {
      item.category_path = cat.value.split("/").map((s) => s.trim()).filter(Boolean);
    };

    row.append(cb, title, status, priority, due, tags, cat);

    if (hasWarn) {
      const w = document.createElement("div");
      w.className = "review-warn" + (item.duplicate ? " dupe" : "");
      w.textContent = `line ${item.line}: ${item.warnings.join(" · ")}`;
      row.append(w);
    }
    if (item.notes) {
      const n = document.createElement("div");
      n.className = "review-notes";
      const ta = document.createElement("textarea");
      ta.value = item.notes;
      ta.oninput = () => { item.notes = ta.value; };
      n.append(ta);
      row.append(n);
    }
    box.append(row);
  });

  updateImportSummary();
}

function updateImportSummary() {
  const n = importItems.filter((i) => i.include).length;
  const warned = importItems.filter((i) => i.warnings.length).length;
  $i("import-summary").textContent =
    `${importItems.length} found · ${n} selected` + (warned ? ` · ${warned} need a look` : "");
  const btn = $i("import-commit");
  btn.textContent = n ? `Import ${n}` : "Import";
  btn.disabled = !n;
}

const setAll = (fn) => {
  importItems.forEach((i) => { i.include = fn(i); });
  renderReview();
};
$i("sel-all").onclick = () => setAll(() => true);
$i("sel-none").onclick = () => setAll(() => false);
$i("sel-clean").onclick = () => setAll((i) => !i.warnings.length && !!i.title.trim());

$i("import-commit").onclick = async () => {
  const btn = $i("import-commit");
  btn.disabled = true;
  try {
    const res = await api.send("POST", "/api/import/commit", {
      items: importItems.filter((i) => i.include),
      create_categories: $i("import-create-cats").checked,
    });
    closeImport();
    await load();
    const extra = res.categories_created.length
      ? ` (new categories: ${res.categories_created.join(", ")})` : "";
    alert(`Imported ${res.created} task${res.created === 1 ? "" : "s"}${extra}.`);
  } catch (err) {
    alert(err.message);   // nothing was written — the batch rolls back server-side
    btn.disabled = false;
  }
};

// ----- view switch + month navigation -----

for (const btn of document.querySelectorAll("#views button")) {
  btn.onclick = () => setView(btn.dataset.view);
}
const shiftMonth = (delta) => {
  calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + delta, 1);
  activeDay = null;
  renderCalendar();
};
document.getElementById("cal-prev").onclick = () => shiftMonth(-1);
document.getElementById("cal-next").onclick = () => shiftMonth(1);
document.getElementById("cal-today").onclick = () => {
  const now = new Date();
  calCursor = new Date(now.getFullYear(), now.getMonth(), 1);
  activeDay = null;
  renderCalendar();
};

// ----- CalDAV sync settings -----

const syncModal = document.getElementById("sync-modal");
let syncStatus = null;

const relTime = (iso) => {
  if (!iso) return "never";
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 90) return `${Math.round(secs)}s ago`;
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  if (secs < 172800) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
};

// The chip is the at-a-glance confirmation: it only appears once sync is
// configured, and says plainly whether it's on and when it last ran.
function renderSyncChip() {
  const chip = $i("sync-chip");
  if (!syncStatus || !syncStatus.configured) { chip.hidden = true; return; }
  chip.hidden = false;
  if (!syncStatus.enabled) {
    chip.textContent = "⇄ paused";
    chip.className = "ghost-btn sync-chip paused";
    chip.title = "CalDAV sync is configured but switched off";
    return;
  }
  const stale = syncStatus.last_sync &&
    (Date.now() - new Date(syncStatus.last_sync).getTime()) / 1000 > syncStatus.interval * 3;
  chip.textContent = `⇄ ${relTime(syncStatus.last_sync)}`;
  chip.className = "ghost-btn sync-chip" + (stale ? " stale" : " ok");
  chip.title = `CalDAV sync · ${syncStatus.mapped} tasks linked`
    + (syncStatus.last_result ? `\nlast run: ${syncStatus.last_result}` : "")
    + (stale ? "\n\nOverdue — the last pass may have failed." : "");
}

async function refreshSyncStatus() {
  try {
    syncStatus = await api.get("/api/caldav");
    renderSyncChip();
    if (!syncModal.hidden) fillSyncForm();
  } catch { /* status is cosmetic; never break the page over it */ }
}

function fillSyncForm() {
  const s = syncStatus || {};
  $i("sync-url").value = s.url || "";
  $i("sync-user").value = s.user || "";
  $i("sync-auth").value = s.auth || "auto";
  $i("sync-interval").value = s.interval || 120;
  $i("sync-enabled").checked = !!s.enabled;
  $i("sync-password").placeholder = s.password_set
    ? "leave blank to keep the saved one" : "required";
  $i("sync-state").textContent = s.enabled ? "on" : s.configured ? "paused" : "not configured";
  $i("sync-stats").textContent = s.configured
    ? `${s.mapped} tasks linked · last sync ${relTime(s.last_sync)}`
      + (s.pending_deletes ? ` · ${s.pending_deletes} deletions pending` : "")
      + (s.auth_scheme ? ` · ${s.auth_scheme} auth` : "")
    : "";
}

const syncFormValues = () => ({
  url: $i("sync-url").value.trim(),
  user: $i("sync-user").value.trim(),
  password: $i("sync-password").value,
  auth: $i("sync-auth").value,
  interval: Number($i("sync-interval").value) || 120,
  enabled: $i("sync-enabled").checked,
});

function showSyncResult(ok, message, detail) {
  const box = $i("sync-result");
  box.hidden = false;
  box.className = "sync-result " + (ok ? "ok" : "bad");
  // replaceChildren() stringifies null into a literal "null" text node, unlike
  // el()'s children — filter before handing it the list.
  box.replaceChildren(...[
    el("strong", { text: ok ? "✓ " : "✕ " }),
    el("span", { text: message }),
    detail ? el("div", { class: "sync-result-detail", text: detail }) : null,
  ].filter(Boolean));
}

document.getElementById("btn-sync-settings").onclick = async () => {
  await refreshSyncStatus();
  fillSyncForm();
  $i("sync-result").hidden = true;
  syncModal.hidden = false;
  $i("sync-url").focus();
};
$i("sync-chip").onclick = () => document.getElementById("btn-sync-settings").click();
$i("sync-close").onclick = () => { syncModal.hidden = true; };
syncModal.onclick = (e) => { if (e.target === syncModal) syncModal.hidden = true; };

$i("sync-test").onclick = async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = "Testing…";
  try {
    const r = await api.send("POST", "/api/caldav/test", syncFormValues());
    showSyncResult(r.ok, r.message,
      r.ok && r.components?.length ? `holds: ${r.components.join(", ")}` : null);
  } catch (err) {
    showSyncResult(false, err.message);
  }
  btn.disabled = false;
  btn.textContent = "Test connection";
};

$i("sync-save").onclick = async (e) => {
  const btn = e.target;
  btn.disabled = true;
  try {
    syncStatus = await api.send("PUT", "/api/caldav/config", syncFormValues());
    $i("sync-password").value = "";      // never keep it in the DOM
    fillSyncForm();
    renderSyncChip();
    showSyncResult(true, syncStatus.enabled
      ? "Saved. The first sync runs within a minute."
      : "Saved. Sync is switched off.");
  } catch (err) {
    showSyncResult(false, err.message);
  }
  btn.disabled = false;
};

$i("sync-now").onclick = async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = "Syncing…";
  try {
    const r = await api.send("POST", "/api/caldav/sync", {});
    const moved = ["pulled", "pushed", "deleted_remote", "deleted_local"]
      .map((k) => (r[k] ? `${r[k]} ${k.replace("_", " ")}` : null)).filter(Boolean);
    showSyncResult(!r.errors,
      moved.length ? `Synced — ${moved.join(", ")}` : "Synced — already up to date",
      [r.conflicts ? `${r.conflicts} conflict(s) resolved by newest-wins` : null,
       r.errors ? `${r.errors} error(s) — see container logs` : null]
        .filter(Boolean).join(" · ") || null);
    await refreshSyncStatus();
    await load();
  } catch (err) {
    showSyncResult(false, err.message);
  }
  btn.disabled = false;
  btn.textContent = "Sync now";
};

refreshSyncStatus();
setInterval(refreshSyncStatus, 30000);

// Single-key shortcuts, but never while typing into something.
document.onkeydown = (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === "Escape" && !syncModal.hidden) { syncModal.hidden = true; return; }
  if (e.key === "Escape" && !modal.hidden) { closeImport(); return; }
  if (e.key === "Escape" && !typing && expanded.size) { expanded.clear(); renderTasks(); return; }
  if (!modal.hidden || !syncModal.hidden) return;
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); search.focus(); }
  if (e.key === "n") { e.preventDefault(); document.getElementById("task-title").focus(); }
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
