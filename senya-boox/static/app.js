// SenyaBoox — browse and view the PDF notes the Boox syncs over WebDAV.
// Vanilla JS module, no build step. Talks to the Flask API in ../app.py and
// renders PDFs through the smooth pan/zoom viewer in viewer.js.

import { PdfView } from "./viewer.js";

const $ = (sel) => document.querySelector(sel);
const app = $("#app");
const treeEl = $("#tree");
const filterEl = $("#filter");
const curPathEl = $("#cur-path");
const openBtn = $("#open-btn");
const downloadBtn = $("#download-btn");
const zoomPct = $("#zoom-pct");

const viewer = new PdfView($("#stage"), $("#pdf-wrap"), {
  onState: (scale) => { zoomPct.textContent = Math.round(scale * 100) + "%"; },
});

let activePath = null;

// Remember which folders are collapsed across refreshes.
const collapsed = new Set();

function pdfUrl(path, download) {
  const u = `api/pdf?path=${encodeURIComponent(path)}`;
  return download ? u + "&download=1" : u;
}

function fmtSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

// ----- render tree -----

function renderNodes(nodes) {
  const ul = document.createElement("ul");
  for (const n of nodes) {
    const li = document.createElement("li");
    li.className = "node " + n.type;
    li.dataset.path = n.path;

    const row = document.createElement("div");
    row.className = "row";

    if (n.type === "dir") {
      if (collapsed.has(n.path)) li.classList.add("collapsed");
      row.innerHTML = `<span class="twist">▶</span><span class="ico">📁</span>` +
        `<span class="label"></span>`;
      row.querySelector(".label").textContent = n.name;
      row.addEventListener("click", () => {
        li.classList.toggle("collapsed");
        if (li.classList.contains("collapsed")) collapsed.add(n.path);
        else collapsed.delete(n.path);
      });
      li.appendChild(row);
      li.appendChild(renderNodes(n.children));
    } else {
      row.innerHTML = `<span class="twist"></span><span class="ico">📄</span>` +
        `<span class="label"></span><span class="meta"></span>`;
      row.querySelector(".label").textContent = n.name;
      row.querySelector(".meta").textContent = fmtSize(n.size);
      row.title = n.name;
      row.addEventListener("click", () => openPdf(n.path));
      li.appendChild(row);
    }
    ul.appendChild(li);
  }
  return ul;
}

async function loadTree() {
  let data;
  try {
    data = await (await fetch("api/tree")).json();
  } catch {
    treeEl.innerHTML = `<div class="tree-empty">Could not load notes.</div>`;
    return;
  }
  treeEl.innerHTML = "";
  if (!data.tree.length) {
    treeEl.innerHTML = `<div class="tree-empty">No PDFs yet.<br>Sync your Boox to the WebDAV share and hit ⟳.</div>`;
    return;
  }
  treeEl.appendChild(renderNodes(data.tree));
  applyFilter();
  if (activePath) markActive(activePath);
}

// ----- open a pdf -----

function openPdf(path) {
  activePath = path;
  app.classList.remove("no-file");
  viewer.load(pdfUrl(path, false));
  curPathEl.textContent = path;
  curPathEl.title = path;
  openBtn.href = pdfUrl(path, false);
  downloadBtn.href = pdfUrl(path, true);
  markActive(path);
}

function markActive(path) {
  treeEl.querySelectorAll(".node.file.active").forEach((el) => el.classList.remove("active"));
  const el = treeEl.querySelector(`.node.file[data-path="${CSS.escape(path)}"]`);
  if (el) {
    el.classList.add("active");
    // expand ancestors so the active file is visible
    let p = el.parentElement;
    while (p && p !== treeEl) {
      if (p.classList && p.classList.contains("node") && p.classList.contains("dir")) {
        p.classList.remove("collapsed");
        collapsed.delete(p.dataset.path);
      }
      p = p.parentElement;
    }
  }
}

// ----- filter -----

function applyFilter() {
  const q = filterEl.value.trim().toLowerCase();
  const files = treeEl.querySelectorAll(".node.file");
  files.forEach((f) => {
    const name = f.dataset.path.toLowerCase();
    f.classList.toggle("hide", q && !name.includes(q));
  });
  // hide dirs with no visible files
  treeEl.querySelectorAll(".node.dir").forEach((d) => {
    const anyVisible = d.querySelector(".node.file:not(.hide)");
    d.classList.toggle("hide", q && !anyVisible);
    if (q && anyVisible) d.classList.remove("collapsed");
  });
}

filterEl.addEventListener("input", applyFilter);
$("#refresh-btn").addEventListener("click", () => { loadTree(); loadHealth(); });

// ----- collapsible sidebar (remembered across reloads) -----
const SIDEBAR_KEY = "senyaboox.sidebar.collapsed";
const sidebar = $("#sidebar");

function setSidebar(collapsed) {
  sidebar.classList.toggle("collapsed", collapsed);
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0"); } catch {}
}

// Restore saved state before enabling transitions, so it doesn't animate on load.
try { if (localStorage.getItem(SIDEBAR_KEY) === "1") sidebar.classList.add("collapsed"); } catch {}
requestAnimationFrame(() => app.classList.add("ready"));

$("#toggle-side").addEventListener("click",
  () => setSidebar(!sidebar.classList.contains("collapsed")));

// ----- zoom controls -----
$("#zoom-in").addEventListener("click", () => viewer.zoomBy(1.25));
$("#zoom-out").addEventListener("click", () => viewer.zoomBy(1 / 1.25));
$("#zoom-fit").addEventListener("click", () => viewer.fit());

// ----- health -----

async function loadHealth() {
  const foot = $("#health");
  const label = foot.querySelector(".label");
  const detail = $("#health-detail");
  try {
    const h = await (await fetch("api/health")).json();
    foot.className = "side-foot " + h.status;
    label.textContent = h.status === "ok" ? "Connected" : "No notes folder";
    detail.textContent = `${h.pdfs} PDF${h.pdfs === 1 ? "" : "s"}`;
  } catch {
    foot.className = "side-foot error";
    label.textContent = "Offline";
    detail.textContent = "";
  }
}

loadTree();
loadHealth();
