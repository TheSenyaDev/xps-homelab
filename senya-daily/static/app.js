// SenyaDaily — vanilla-JS frontend. Day view (free note + per-tracker inputs)
// and a month calendar. Trackers are user-defined, so the day view is built
// dynamically from whatever trackers exist; adding a field type means adding a
// branch in trackerInput() and (server-side) build_markdown().

// ---------- tiny helpers ----------
const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return n;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// Local-time YYYY-MM-DD (avoid UTC shifting the day).
function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseISO(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return isoOf(d);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

// ---------- state ----------
let trackers = [];
let currentDate = isoOf(new Date());
let dayData = { date: currentDate, note: "", entries: {} };
let saveTimer = null;
let calYear, calMonth; // 1-based month

// ---------- save (debounced) ----------
function setEntry(id, value) {
  if (value === "" || value == null) delete dayData.entries[String(id)];
  else dayData.entries[String(id)] = String(value);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 600);
}

async function doSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const state = $("#save-state");
  state.textContent = "Saving…";
  state.classList.remove("saved");
  try {
    const saved = await api("PUT", `/api/days/${dayData.date}`, {
      note: dayData.note,
      entries: dayData.entries,
    });
    dayData = saved;
    state.textContent = "Saved ✓";
    state.classList.add("saved");
    setTimeout(() => { if (state.textContent === "Saved ✓") state.textContent = ""; }, 1600);
  } catch (e) {
    state.textContent = "Save failed";
  }
}

async function flushSave() {
  if (saveTimer) await doSave();
}

// ---------- day view ----------
async function loadDay(iso) {
  await flushSave();
  currentDate = iso;
  dayData = await api("GET", `/api/days/${iso}`);
  renderDay();
}

function renderDateNav() {
  const d = parseISO(currentDate);
  $("#day-weekday").textContent = d.toLocaleDateString(undefined, { weekday: "long" });
  $("#day-picker").value = currentDate;
}

function renderDay() {
  renderDateNav();
  $("#note").value = dayData.note || "";
  const wrap = $("#trackers");
  wrap.replaceChildren();
  if (!trackers.length) {
    wrap.append(el("p", { class: "hint" }, "No trackers yet — add one with ⚙ Trackers."));
    return;
  }
  for (const t of trackers) wrap.append(trackerCard(t));
}

function trackerCard(t) {
  const value = dayData.entries[String(t.id)] || "";
  const card = el("div", { class: "tracker" },
    el("div", { class: "tracker-head" },
      el("span", { class: "ico" }, t.icon || "•"),
      el("span", {}, t.name),
      t.unit ? el("span", { class: "unit" }, t.unit) : null,
    ),
    trackerInput(t, value),
  );
  card.style.borderLeftColor = t.color || "var(--accent)";
  return card;
}

// One input per tracker type. Each handler updates in-memory state + schedules a save.
function trackerInput(t, value) {
  if (t.type === "text") {
    const ta = el("textarea", { placeholder: "…" });
    ta.value = value;
    ta.addEventListener("input", () => { setEntry(t.id, ta.value); scheduleSave(); });
    return ta;
  }

  if (t.type === "check") {
    const toggle = el("div", { class: "toggle" + (value === "1" ? " on" : "") },
      el("span", { class: "box" }, value === "1" ? "✓" : ""),
      el("span", { class: "txt" }, value === "1" ? "Done" : "Not yet"),
    );
    toggle.addEventListener("click", () => {
      const on = !toggle.classList.contains("on");
      toggle.classList.toggle("on", on);
      toggle.querySelector(".box").textContent = on ? "✓" : "";
      toggle.querySelector(".txt").textContent = on ? "Done" : "Not yet";
      setEntry(t.id, on ? "1" : "");
      scheduleSave();
    });
    return toggle;
  }

  if (t.type === "rating") {
    const cur = parseInt(value, 10) || 0;
    const row = el("div", { class: "stars" });
    for (let i = 1; i <= 5; i++) {
      const star = el("button", { class: "star" + (i <= cur ? " on" : ""), type: "button" }, "★");
      star.addEventListener("click", () => {
        const now = parseInt(dayData.entries[String(t.id)], 10) || 0;
        const val = now === i ? "" : String(i); // click the current rating to clear
        setEntry(t.id, val);
        const v = parseInt(val, 10) || 0;
        row.querySelectorAll(".star").forEach((s, idx) => s.classList.toggle("on", idx < v));
        scheduleSave();
      });
      row.append(star);
    }
    return row;
  }

  // number (default)
  const input = el("input", { type: "number", step: "any", placeholder: "0" });
  input.value = value;
  const bump = (delta) => {
    input.value = String((parseFloat(input.value) || 0) + delta);
    setEntry(t.id, input.value);
    scheduleSave();
  };
  input.addEventListener("input", () => { setEntry(t.id, input.value); scheduleSave(); });
  return el("div", { class: "num-row" },
    el("button", { class: "step", type: "button", onclick: () => bump(-1) }, "−"),
    input,
    el("button", { class: "step", type: "button", onclick: () => bump(1) }, "+"),
  );
}

// ---------- calendar view ----------
async function renderCalendar() {
  $("#cal-title").textContent = `${MONTHS[calMonth - 1]} ${calYear}`;
  const wd = $("#cal-weekdays");
  if (!wd.childElementCount) WEEKDAYS.forEach((w) => wd.append(el("span", {}, w)));

  const grid = $("#cal-grid");
  grid.replaceChildren();
  const { days } = await api("GET", `/api/calendar?year=${calYear}&month=${calMonth}`);

  const first = new Date(calYear, calMonth - 1, 1);
  const lead = first.getDay(); // 0=Sun
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const todayIso = isoOf(new Date());

  for (let i = 0; i < lead; i++) grid.append(el("div", { class: "cell blank" }));

  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${calYear}-${String(calMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const info = days[iso];
    const marks = el("div", { class: "marks" });
    if (info?.note) marks.append(el("span", { class: "note-dot", title: "Has a note" }));
    if (info?.entries) marks.append(el("span", { class: "ecount" }, `${info.entries}`));
    const cell = el("div", { class: "cell" + (iso === todayIso ? " today" : "") },
      el("span", { class: "num" }, String(d)),
      marks,
    );
    cell.addEventListener("click", () => { showView("day"); loadDay(iso); });
    grid.append(cell);
  }
}

function shiftMonth(n) {
  calMonth += n;
  if (calMonth < 1) { calMonth = 12; calYear--; }
  else if (calMonth > 12) { calMonth = 1; calYear++; }
  renderCalendar();
}

// ---------- trackers management ----------
async function loadTrackers() {
  trackers = await api("GET", "/api/trackers");
}

function renderTrackerList() {
  const list = $("#tracker-list");
  list.replaceChildren();
  if (!trackers.length) {
    list.append(el("p", { class: "hint" }, "No trackers yet."));
    return;
  }
  const TYPE_LABEL = { number: "Number", text: "Text", check: "Checkbox", rating: "Rating" };
  for (const t of trackers) {
    const row = el("div", { class: "trow" },
      el("span", { class: "swatch" }),
      el("span", { class: "ico" }, t.icon || "•"),
      el("span", { class: "tname" }, t.name),
      el("span", { class: "ttype" }, `· ${TYPE_LABEL[t.type] || t.type}${t.unit ? " (" + t.unit + ")" : ""}`),
      el("span", { class: "spacer" }),
      el("button", {
        class: "del", title: "Delete tracker",
        onclick: () => deleteTracker(t),
      }, "🗑"),
    );
    row.querySelector(".swatch").style.background = t.color || "var(--accent)";
    list.append(row);
  }
}

async function deleteTracker(t) {
  if (!confirm(`Delete "${t.name}"? Its values on every day will be removed.`)) return;
  await api("DELETE", `/api/trackers/${t.id}`);
  await loadTrackers();
  renderTrackerList();
  // current day in memory may reference the deleted tracker — reload it clean.
  await loadDay(currentDate);
}

async function addTracker(e) {
  e.preventDefault();
  const name = $("#tf-name").value.trim();
  if (!name) return;
  await api("POST", "/api/trackers", {
    name,
    type: $("#tf-type").value,
    unit: $("#tf-unit").value.trim(),
    icon: $("#tf-icon").value.trim(),
    color: $("#tf-color").value,
  });
  e.target.reset();
  $("#tf-color").value = "#6366f1";
  await loadTrackers();
  renderTrackerList();
  renderDay();
}

// ---------- view switching ----------
function showView(view) {
  document.querySelectorAll(".view-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("#day-view").classList.toggle("hidden", view !== "day");
  $("#cal-view").classList.toggle("hidden", view !== "calendar");
  if (view === "calendar") renderCalendar();
}

// ---------- wiring ----------
function wire() {
  $("#prev-day").addEventListener("click", () => loadDay(addDays(currentDate, -1)));
  $("#next-day").addEventListener("click", () => loadDay(addDays(currentDate, 1)));
  $("#today-btn").addEventListener("click", () => loadDay(isoOf(new Date())));
  $("#day-picker").addEventListener("change", (e) => { if (e.target.value) loadDay(e.target.value); });

  $("#note").addEventListener("input", (e) => { dayData.note = e.target.value; scheduleSave(); });
  window.addEventListener("beforeunload", () => { if (saveTimer) navigator.sendBeacon?.(`/api/days/${dayData.date}`); });

  document.querySelectorAll(".view-btn").forEach((b) =>
    b.addEventListener("click", () => showView(b.dataset.view)));

  $("#cal-prev").addEventListener("click", () => shiftMonth(-1));
  $("#cal-next").addEventListener("click", () => shiftMonth(1));

  $("#manage-btn").addEventListener("click", () => { renderTrackerList(); $("#manage").classList.remove("hidden"); });
  $("#manage-close").addEventListener("click", () => $("#manage").classList.add("hidden"));
  $("#manage").addEventListener("click", (e) => { if (e.target.id === "manage") $("#manage").classList.add("hidden"); });
  $("#tracker-form").addEventListener("submit", addTracker);
}

// ---------- boot ----------
async function init() {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth() + 1;
  wire();
  await loadTrackers();
  await loadDay(currentDate);
}

init();
