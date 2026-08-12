// Month view. Shares the same filters as the list — the calendar is a
// different arrangement of the same tasks, not a different query.

import { patchTask as patch, reload } from "../core/actions.js";
import { emit, on } from "../core/bus.js";
import { $, el } from "../core/dom.js";
import { DOW, MONTH_NAMES, iso, today } from "../core/format.js";
import { categoryById, getCategories, getMeta, getTags, getTasks, prefs, setPref,
         visibleTasks } from "../core/state.js";

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

export { renderCalendar };


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
  // Say when completed ones are being withheld, so a missing task is explained
  // rather than mysterious.
  const allVisible = visibleTasks();
  const hiddenDone = allVisible.filter((t) => t.done).length
                   - list.filter((t) => t.done).length;
  document.getElementById("current-count").textContent =
    `${list.filter((t) => !t.done).length} open · ${list.length} shown` +
    (hiddenDone ? ` · ${hiddenDone} completed hidden` : "");
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

