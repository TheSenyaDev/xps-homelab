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

let categories = [];
let tasks = [];
let activeCategory = "all"; // "all" | "none" | <id>
let filter = "all"; // "all" | "active" | "done"

async function load() {
  [categories, tasks] = await Promise.all([
    api.get("/api/categories"),
    api.get("/api/tasks"),
  ]);
  render();
}

const categoryById = (id) => categories.find((c) => c.id === id);
const childrenOf = (pid) =>
  categories
    .filter((c) => (c.parent_id ?? null) === pid)
    .sort((a, b) => a.name.localeCompare(b.name));

// DFS order: [{cat, depth}, ...]
function orderedTree() {
  const out = [];
  const walk = (pid, depth) => {
    for (const c of childrenOf(pid)) {
      out.push({ cat: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// a category id plus all of its descendants
function descendantIds(catId) {
  const ids = new Set([catId]);
  const walk = (pid) => {
    for (const c of childrenOf(pid)) {
      ids.add(c.id);
      walk(c.id);
    }
  };
  walk(catId);
  return ids;
}

function openCountForSubtree(catId) {
  const ids = descendantIds(catId);
  return tasks.filter((t) => !t.done && ids.has(t.category_id)).length;
}

function renderSidebar() {
  const list = document.getElementById("category-list");
  list.innerHTML = "";

  const addRow = (id, name, color, depth, deletable) => {
    const el = document.createElement("div");
    el.className = "cat" + (String(activeCategory) === String(id) ? " active" : "");
    el.style.paddingLeft = `${10 + depth * 16}px`;
    const count =
      id === "all"
        ? tasks.filter((t) => !t.done).length
        : id === "none"
        ? tasks.filter((t) => !t.done && t.category_id == null).length
        : openCountForSubtree(id);
    el.innerHTML = `
      <span class="dot" style="background:${color}"></span>
      <span class="name"></span>
      <span class="count">${count}</span>`;
    el.querySelector(".name").textContent = name;
    el.onclick = () => { activeCategory = id; render(); };
    if (deletable) {
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "✕";
      del.title = "Delete (subcategories + their tasks' grouping are removed)";
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${name}"? Subcategories are removed and affected tasks become uncategorized.`)) return;
        await api.send("DELETE", `/api/categories/${id}`);
        if (descendantIds(id).has(activeCategory)) activeCategory = "all";
        await load();
      };
      el.appendChild(del);
    }
    list.appendChild(el);
  };

  addRow("all", "All tasks", "#6366f1", 0, false);
  for (const { cat, depth } of orderedTree()) {
    addRow(cat.id, cat.name, cat.color, depth + 1, true);
  }
  addRow("none", "Uncategorized", "#6b7280", 0, false);

  // parent picker for the new-category form
  const parentSel = document.getElementById("category-parent");
  const prev = parentSel.value;
  parentSel.innerHTML = '<option value="">— top level —</option>';
  for (const { cat, depth } of orderedTree()) {
    const opt = document.createElement("option");
    opt.value = cat.id;
    opt.textContent = `${"— ".repeat(depth)}${cat.name}`;
    parentSel.appendChild(opt);
  }
  parentSel.value = prev;

  // title reflects current selection
  const t = document.getElementById("current-title");
  t.textContent =
    activeCategory === "all" ? "All tasks"
    : activeCategory === "none" ? "Uncategorized"
    : (categoryById(activeCategory)?.name ?? "Tasks");
}

function visibleTasks() {
  let scope;
  if (activeCategory === "all") scope = null;
  else if (activeCategory === "none") scope = "none";
  else scope = descendantIds(activeCategory);

  return tasks.filter((t) => {
    if (scope === "none") { if (t.category_id != null) return false; }
    else if (scope && !scope.has(t.category_id)) return false;
    if (filter === "active") return !t.done;
    if (filter === "done") return !!t.done;
    return true;
  });
}

function renderTasks() {
  const container = document.getElementById("task-groups");
  const list = visibleTasks();
  container.innerHTML = "";

  if (list.length === 0) {
    container.innerHTML = `<div class="empty">Nothing here yet. Add a task above.</div>`;
    return;
  }

  const byCat = new Map();
  for (const t of list) {
    const key = t.category_id ?? "none";
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(t);
  }

  // render in tree order so subcategories nest under parents
  const order = orderedTree();
  const render1 = (key, name, color, depth) => {
    const items = byCat.get(key);
    if (!items || !items.length) return;
    const group = document.createElement("div");
    group.className = "group";
    group.style.marginLeft = `${depth * 16}px`;
    group.innerHTML =
      `<div class="group-head"><span class="dot" style="background:${color}"></span>${name}</div>`;
    for (const t of items) group.appendChild(taskRow(t));
    container.appendChild(group);
  };

  for (const { cat, depth } of order) render1(cat.id, cat.name, cat.color, depth);
  render1("none", "Uncategorized", "#6b7280", 0);
}

function taskRow(t) {
  const row = document.createElement("div");
  row.className = "task" + (t.done ? " done" : "");

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!t.done;
  cb.onchange = async () => {
    await api.send("PATCH", `/api/tasks/${t.id}`, { done: cb.checked });
    await load();
  };

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = t.title;
  title.title = "Click to edit";
  title.onclick = () => editTitle(t, title);

  const badge = document.createElement("span");
  badge.className = `badge ${t.priority}`;
  badge.textContent = t.priority;

  const del = document.createElement("button");
  del.className = "del";
  del.textContent = "🗑";
  del.onclick = async () => {
    await api.send("DELETE", `/api/tasks/${t.id}`);
    await load();
  };

  row.append(cb, title, badge, del);
  return row;
}

function editTitle(t, span) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = t.title;
  input.style.flex = "1";
  span.replaceWith(input);
  input.focus();
  const commit = async () => {
    const v = input.value.trim();
    if (v && v !== t.title) await api.send("PATCH", `/api/tasks/${t.id}`, { title: v });
    await load();
  };
  input.onblur = commit;
  input.onkeydown = (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") load();
  };
}

function render() {
  renderSidebar();
  renderTasks();
}

// ----- events -----

document.getElementById("task-form").onsubmit = async (e) => {
  e.preventDefault();
  const input = document.getElementById("task-title");
  const title = input.value.trim();
  if (!title) return;
  const priority = document.getElementById("task-priority").value;
  const category_id = typeof activeCategory === "number" ? activeCategory : null;
  await api.send("POST", "/api/tasks", { title, priority, category_id });
  input.value = "";
  await load();
};

document.getElementById("category-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById("category-name").value.trim();
  if (!name) return;
  const color = document.getElementById("category-color").value;
  const parentVal = document.getElementById("category-parent").value;
  const parent_id = parentVal ? Number(parentVal) : null;
  try {
    const cat = await api.send("POST", "/api/categories", { name, color, parent_id });
    document.getElementById("category-name").value = "";
    activeCategory = cat.id;
    await load();
  } catch (err) {
    alert(err.message);
  }
};

for (const btn of document.querySelectorAll(".filters button")) {
  btn.onclick = () => {
    document.querySelectorAll(".filters button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    filter = btn.dataset.filter;
    render();
  };
}

load();
