// The task list: grouping, rows, the inline detail editor.
//
// The largest view, and the one every other part feeds. It renders from the
// selectors in core/state.js rather than filtering itself, so the sidebar
// counts and this list can never disagree about what "open" means.

import { api } from "../core/api.js";
import { patchTask as patch, reload } from "../core/actions.js";
import { emit, on } from "../core/bus.js";
import { $, el, watchDateInput } from "../core/dom.js";
import { MONTHS, STATUS_LABEL, STATUS_RING, today } from "../core/format.js";
import {
  categoryById, expanded, getCategories, getMeta, getTags, getTasks, prefs, query, setPref,
  sortTasks, subtasksOf, trimCompleted, visibleTasks,
} from "../core/state.js";

// Module-local mirrors of the shared data, refreshed whenever it reloads.
// Kept as plain bindings so the render code below reads exactly as it did
// before this file was split out — a rename inside a string literal is the
// classic way a mechanical refactor ships a silent bug.
let meta = { statuses: ["todo", "doing", "blocked", "done"],
             priorities: ["high", "medium", "low"] };
let categories = [];
let tasks = [];
let tags = [];

function syncMirrors() {
  meta = getMeta();
  categories = getCategories();
  tasks = getTasks();
  tags = getTags();
}
on("data:changed", syncMirrors);

export { renderTasks };

/**
 * Sort, then place each subtask directly under its parent.
 *
 * The sort has to be applied to the roots and to each parent's children
 * separately. Sorting the flat list scatters subtasks away from their parent —
 * and because sortTasks sinks completed tasks, a finished subtask would end up
 * at the bottom of the group rather than under the task it belongs to.
 *
 * A subtask whose parent is filtered out is treated as a root rather than
 * dropped: hiding a task because of something you cannot see is worse than a
 * row without its heading.
 */
function nest(items) {
  const present = new Set(items.map((t) => t.id));
  const kids = new Map();
  const roots = [];
  for (const t of items) {
    if (t.parent_id != null && present.has(t.parent_id)) {
      if (!kids.has(t.parent_id)) kids.set(t.parent_id, []);
      kids.get(t.parent_id).push(t);
    } else {
      roots.push(t);
    }
  }
  const out = [];
  for (const t of sortTasks(roots)) {
    out.push(t);
    out.push(...sortTasks(kids.get(t.id) || []));
  }
  return out;
}

/**
 * Groups fold down to their heading, which keeps its open count — a collapsed
 * category still says how much is left in it, which is the point of collapsing
 * the ones you are not working on today.
 *
 * Collapse is suspended while a search is running, and the twisty goes with it:
 * a match hidden inside a collapsed group reads as "no results", and a twisty
 * that cannot change what you see is a dead control. The state is only
 * suspended, not cleared — the query is transient where the collapse persists,
 * so clearing the box puts the groups back the way you left them.
 */
const searching = () => query.trim().length > 0;

function toggleGroup(key) {
  const set = prefs.collapsedGroups;
  set.has(key) ? set.delete(key) : set.add(key);
  setPref("collapsedGroups", set);
  renderTasks();
}

function renderTasks() {
  const container = document.getElementById("task-groups");
  const list = trimCompleted(visibleTasks());
  container.innerHTML = "";

  // Say when completed ones are being withheld, so a missing task is explained
  // rather than mysterious.
  const allVisible = visibleTasks();
  const hiddenDone = allVisible.filter((t) => t.done).length
                   - list.filter((t) => t.done).length;
  document.getElementById("current-count").textContent =
    `${list.filter((t) => !t.done).length} open · ${list.length} shown` +
    (hiddenDone ? ` · ${hiddenDone} completed hidden` : "");

  if (!list.length) {
    container.innerHTML = `<div class="empty">Nothing here. Add a task above.</div>`;
    return;
  }

  const byCat = new Map();
  for (const t of list) {
    // A subtask files under its parent's category, so the pair never splits
    // across two groups.
    const parent = t.parent_id != null ? list.find((x) => x.id === t.parent_id) : null;
    const key = (parent ? parent.category_id : t.category_id) ?? "none";
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(t);
  }

  const group = (key, name, color, depth) => {
    const items = byCat.get(key);
    if (!items?.length) return;
    const collapsible = !searching();
    const collapsed = collapsible && prefs.collapsedGroups.has(key);
    const g = document.createElement("div");
    g.className = "group";
    g.style.marginLeft = `${depth * 12}px`;

    const head = document.createElement("div");
    head.className = "group-head" + (collapsible ? " collapsible" : "");
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

    if (collapsible) {
      const twisty = document.createElement("span");
      twisty.className = "twisty";
      twisty.textContent = collapsed ? "▶" : "▼";
      // The whole heading toggles, not just the twisty: it is a full-width bar
      // with nothing else on it to click, and an 11px target is a poor one.
      head.prepend(twisty);
      head.title = collapsed ? `Show ${name}` : `Hide ${name}`;
      head.onclick = () => toggleGroup(key);
    }

    g.append(head);
    if (!collapsed) {
      const rows = document.createElement("div");
      rows.className = "rows";
      for (const t of nest(items)) {
        rows.append(taskRow(t));
        if (expanded.has(t.id)) rows.append(taskDetail(t));
      }
      g.append(rows);
    }
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

// Own column so dates line up down the list. Empty cell when there's no date —
// the column still reserves its width, which is what keeps the alignment.
function dueCell(t) {
  const cell = document.createElement("span");
  cell.className = "due";
  if (!t.due_date) return cell;

  const d = t.due_date;
  const now = today();
  // classList.add("") throws, so only tag the states that have a class.
  // A done task past its due date isn't "overdue" — it's finished; skip
  // the red styling once done, so it doesn't contradict sidebar counts
  // that already exclude done tasks from "overdue".
  if (d < now && !t.done) cell.classList.add("overdue");
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
  row.className = `task${t.done ? " done" : ""}${expanded.has(t.id) ? " open" : ""}`
                + (t.parent_id != null ? " subtask" : "");

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

  // Subtask progress, as a real element in the meta row. It cannot be a
  // ::after on .task — that is a 4-column grid, and a pseudo-element becomes a
  // fifth grid item and shifts the whole row.
  if (t.parent_id == null) {
    const kids = tasks.filter((x) => x.parent_id === t.id);
    if (kids.length) {
      const chip = document.createElement("span");
      chip.className = "subs";
      chip.textContent = `☰ ${kids.filter((k) => k.done).length}/${kids.length}`;
      chip.title = "Subtasks";
      metaBox.append(chip);
    }
  }

  for (const tag of t.tags) {
    const c = document.createElement("button");
    c.className = "chip tag" + (prefs.tag === tag.name ? " on" : "");
    c.textContent = `#${tag.name}`;
    c.onclick = (e) => {
      e.stopPropagation();
      setPref("tag", prefs.tag === tag.name ? null : tag.name);
      emit("view:changed");
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
    const kids = tasks.filter((x) => x.parent_id === t.id).length;
    // Deleting a parent takes its subtasks with it (ON DELETE CASCADE), which
    // is worth saying before it happens rather than after.
    if (kids && !confirm(`Delete “${t.title}” and its ${kids} subtask${kids > 1 ? "s" : ""}?`)) return;
    await api.send("DELETE", `/api/tasks/${t.id}`);
    expanded.delete(t.id);
    await reload();
  };

  actions.append(edit);
  if (t.parent_id == null) {
    const add = document.createElement("button");
    add.className = "icon-btn";
    add.textContent = "+";
    add.title = "Add a subtask";
    add.onclick = () => addSubtask(t);
    actions.append(add);
  }
  actions.append(del);

  main.append(prio, title, metaBox);
  row.append(cb, main, dueCell(t), actions);

  // A note is part of the task, not a detail to go hunting for. Appended to the
  // row rather than into .main so it forms a real second grid row: everything
  // in the first row (checkbox, title, due, actions) then centres against the
  // title alone, instead of drifting to the midpoint of a two-line cell.
  // First line only — a row that grew with an essay would wreck the list.
  if (t.notes && t.notes.trim()) {
    const note = document.createElement("span");
    note.className = "note-peek";
    note.textContent = t.notes.trim().split("\n")[0];
    note.title = t.notes;
    row.append(note);
  }

  return row;
}

async function addSubtask(t) {
  const title = prompt(`Subtask of “${t.title}”`);
  if (!title || !title.trim()) return;
  try {
    // Inherits the parent's category so the pair stays together in the list
    // and, in per-category sync mode, in the same CalDAV collection.
    await api.post("/api/tasks", {
      title: title.trim(), parent_id: t.id, category_id: t.category_id,
    });
  } catch (err) {
    // A silent failure here is indistinguishable from "subtasks do not work".
    alert(`Could not add the subtask: ${err.message}`);
    return;
  }
  await reload();
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

  // Subtasks, with a labelled control — the icon in the row's hover actions is
  // for speed once you know it exists, not for discovering the feature.
  if (t.parent_id == null) {
    const kids = tasks.filter((x) => x.parent_id === t.id);
    const wrap = document.createElement("div");
    wrap.className = "subs-box";
    const add = document.createElement("button");
    add.className = "ghost-btn";
    add.textContent = "+ Subtask";
    add.onclick = () => addSubtask(t);
    wrap.append(add);
    if (kids.length) {
      const n = document.createElement("span");
      n.className = "stamps";
      n.textContent = `${kids.filter((k) => k.done).length} of ${kids.length} done`;
      wrap.append(n);
    }
    field("subtasks", wrap);
  }

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

