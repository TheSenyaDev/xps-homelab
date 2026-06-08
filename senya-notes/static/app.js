/* SenyaNotes frontend: file tree + edit/split/preview with debounced autosave. */

const $ = (s) => document.querySelector(s);

const els = {
  app: $(".app"),
  tree: $("#tree"),
  filter: $("#filter"),
  md: $("#md"),
  preview: $("#preview"),
  panes: $("#panes"),
  curPath: $("#cur-path"),
  saveState: $("#save-state"),
  sidebar: $("#sidebar"),
};

let state = {
  path: null,        // currently open note (relative)
  dirty: false,
  saveTimer: null,
  expanded: new Set(JSON.parse(localStorage.getItem("sn-expanded") || "[]")),
};

// ---------- API ----------
const api = {
  tree: () => fetch("/api/tree").then((r) => r.json()),
  read: (p) => fetch("/api/file?path=" + encodeURIComponent(p)).then((r) => r.json()),
  write: (p, content) =>
    fetch("/api/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p, content }),
    }),
  create: (p) =>
    fetch("/api/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p }),
    }),
  remove: (p) => fetch("/api/file?path=" + encodeURIComponent(p), { method: "DELETE" }),
};

// ---------- Tree ----------
async function loadTree() {
  const data = await api.tree();
  renderTree(data.tree);
}

function renderTree(nodes) {
  els.tree.innerHTML = "";
  els.tree.appendChild(buildList(nodes));
  applyFilter();
}

function buildList(nodes) {
  const ul = document.createElement("ul");
  for (const n of nodes) ul.appendChild(buildNode(n));
  return ul;
}

function buildNode(n) {
  const li = document.createElement("li");
  li.className = "node " + n.type;
  li.dataset.path = n.path;
  li.dataset.name = n.name.toLowerCase();

  const row = document.createElement("div");
  row.className = "row";

  if (n.type === "dir") {
    const collapsed = !state.expanded.has(n.path);
    if (collapsed) li.classList.add("collapsed");
    row.innerHTML = `<span class="twist">▶</span><span class="ico">📁</span><span class="label"></span>`;
    row.querySelector(".label").textContent = n.name;
    row.addEventListener("click", () => {
      li.classList.toggle("collapsed");
      if (li.classList.contains("collapsed")) state.expanded.delete(n.path);
      else state.expanded.add(n.path);
      localStorage.setItem("sn-expanded", JSON.stringify([...state.expanded]));
    });
    li.appendChild(row);
    li.appendChild(buildList(n.children));
  } else {
    row.innerHTML = `<span class="twist"></span><span class="ico">📄</span><span class="label"></span>`;
    row.querySelector(".label").textContent = n.name.replace(/\.md$/i, "");
    row.addEventListener("click", () => openNote(n.path));
    li.appendChild(row);
  }
  return li;
}

function markActive(path) {
  els.tree.querySelectorAll(".node.file.active").forEach((e) => e.classList.remove("active"));
  const li = els.tree.querySelector(`.node.file[data-path="${CSS.escape(path)}"]`);
  if (li) li.classList.add("active");
}

function applyFilter() {
  const q = els.filter.value.trim().toLowerCase();
  els.tree.querySelectorAll(".node.file").forEach((f) => {
    const hit = !q || f.dataset.name.includes(q);
    f.classList.toggle("hide", !hit);
  });
  // hide empty folders while filtering; show all when query cleared
  els.tree.querySelectorAll(".node.dir").forEach((d) => {
    if (!q) { d.classList.remove("hide"); return; }
    const anyVisible = d.querySelector(".node.file:not(.hide)");
    d.classList.toggle("hide", !anyVisible);
    if (anyVisible) d.classList.remove("collapsed");
  });
}

// ---------- Open / edit / save ----------
async function openNote(path) {
  if (state.dirty) await saveNow();
  const data = await api.read(path);
  if (data.error) { setSave("error", data.error); return; }
  state.path = path;
  state.dirty = false;
  els.md.value = data.content;
  els.curPath.textContent = path;
  els.app.classList.remove("no-file");
  markActive(path);
  renderPreview();
  setSave("saved", "Saved");
}

function renderPreview() {
  els.preview.innerHTML = window.renderMarkdown(els.md.value);
}

function setSave(cls, text) {
  els.saveState.className = "save-state " + (cls || "");
  els.saveState.textContent = text || "";
}

function scheduleSave() {
  state.dirty = true;
  setSave("saving", "Editing…");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 800);
}

async function saveNow() {
  if (!state.path || !state.dirty) return;
  clearTimeout(state.saveTimer);
  const content = els.md.value;
  setSave("saving", "Saving…");
  const res = await api.write(state.path, content);
  if (res.ok) { state.dirty = false; setSave("saved", "Saved"); }
  else { setSave("error", "Save failed"); }
}

// ---------- Sync health ----------
function timeAgo(ts) {
  if (!ts) return "never";
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

async function loadHealth() {
  const el = $("#health");
  try {
    const h = await fetch("/api/health").then((r) => r.json());
    const labels = { ok: "Sync healthy", warn: "Check sync", error: "Disconnected" };
    const c = h.couchdb, v = h.vault;
    const couchTxt = c.reachable
      ? `CouchDB reachable${c.doc_count != null ? ` · ${c.doc_count} docs` : ""}`
      : `CouchDB unreachable${c.error ? ` (${c.error})` : ""}`;
    const vaultTxt = `${v.notes} note${v.notes === 1 ? "" : "s"} · updated ${timeAgo(v.last_modified)}`;
    el.className = "side-foot " + h.status;
    el.innerHTML =
      `<div class="health-row"><span class="dot"></span><span class="label">${labels[h.status]}</span></div>` +
      `<div class="health-detail">${couchTxt}<br>${vaultTxt}</div>`;
    el.title = `${couchTxt} — ${vaultTxt}`;
  } catch {
    el.className = "side-foot error";
    el.innerHTML = `<div class="health-row"><span class="dot"></span><span class="label">Status unavailable</span></div>`;
  }
}

// ---------- Modes ----------
function setMode(mode) {
  els.panes.className = "panes mode-" + mode;
  document.querySelectorAll(".mode-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode));
  localStorage.setItem("sn-mode", mode);
}

// ---------- New note ----------
function newNoteDialog() {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="dialog">
      <h2>New note</h2>
      <p>Path inside the vault. Use <code>/</code> for folders. <code>.md</code> is added automatically.</p>
      <input id="nn-input" type="text" placeholder="folder/My Note" />
      <div class="dialog-err" id="nn-err"></div>
      <div class="dialog-actions">
        <button class="ghost" id="nn-cancel">Cancel</button>
        <button class="btn" id="nn-create">Create</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector("#nn-input");
  const err = overlay.querySelector("#nn-err");
  input.focus();

  const close = () => overlay.remove();
  overlay.querySelector("#nn-cancel").onclick = close;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  const create = async () => {
    const name = input.value.trim();
    if (!name) { err.textContent = "Enter a name."; return; }
    const res = await api.create(name);
    const data = await res.json();
    if (!res.ok) { err.textContent = data.error || "Could not create."; return; }
    close();
    await loadTree();
    openNote(data.path);
  };
  overlay.querySelector("#nn-create").onclick = create;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); if (e.key === "Escape") close(); });
}

async function deleteCurrent() {
  if (!state.path) return;
  if (!confirm(`Delete "${state.path}"? This also removes it from your synced vault.`)) return;
  await api.remove(state.path);
  state.path = null; state.dirty = false;
  els.md.value = "";
  els.app.classList.add("no-file");
  els.curPath.textContent = "No note open";
  await loadTree();
}

// ---------- Wire up ----------
els.md.addEventListener("input", () => { scheduleSave(); renderPreview(); });
els.filter.addEventListener("input", applyFilter);
$("#new-btn").onclick = newNoteDialog;
$("#refresh-btn").onclick = loadTree;
$("#delete-btn").onclick = deleteCurrent;
$("#sidebar-toggle").onclick = () => els.sidebar.classList.toggle("collapsed");
document.querySelectorAll(".mode-btn").forEach((b) => b.onclick = () => setMode(b.dataset.mode));

// Ctrl/Cmd-S = save now
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveNow(); }
});
// Flush a pending save if the tab is closed/hidden
window.addEventListener("beforeunload", (e) => {
  if (state.dirty) { saveNow(); e.preventDefault(); e.returnValue = ""; }
});

// init
setMode(localStorage.getItem("sn-mode") || "split");
els.app.classList.add("no-file");
loadTree();
loadHealth();
setInterval(loadHealth, 20000);
