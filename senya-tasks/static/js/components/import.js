// Markdown import: paste, preview what would change, then commit.
//
// The preview exists because import is the one destructive-ish action here —
// seeing the warnings before anything is written is the whole point.

import { api } from "../core/api.js";
import { reload } from "../core/actions.js";
import { emit, on } from "../core/bus.js";
import { $, el, watchDateInput } from "../core/dom.js";
import { getCategories, getMeta, getTags, getTasks } from "../core/state.js";

// Module-local mirrors, refreshed on reload. Plain bindings so the code below
// reads exactly as it did before the split — renaming into string literals is
// how a mechanical refactor ships a silent bug.
let meta = {}, categories = [], tasks = [], tags = [];
function syncMirrors() {
  meta = getMeta(); categories = getCategories(); tasks = getTasks(); tags = getTags();
}
on("data:changed", syncMirrors);

export function init() {
  $("btn-import").onclick = openImport;
}

let importItems = [];
const modal = $("import-modal");
const $i = (id) => $(id);

function openImport() {
  const sel = $("import-default-status");
  if (!sel.options.length) for (const s of meta.statuses) sel.append(new Option(s, s));
  sel.value = "todo";
  importItems = [];
  $("import-text").value = "";
  showImportStep("paste");
  modal.hidden = false;
  $("import-text").focus();
}

function closeImport() { modal.hidden = true; }

function showImportStep(step) {
  const reviewing = step === "review";
  $("import-paste").hidden = reviewing;
  $("import-review").hidden = !reviewing;
  $("import-parse").hidden = reviewing;
  $("import-commit").hidden = !reviewing;
  $("import-back").hidden = !reviewing;
  $("import-step").textContent = reviewing ? "2 · review" : "1 · paste";
}

$("import-close").onclick = closeImport;
$("import-back").onclick = () => showImportStep("paste");
modal.onclick = (e) => { if (e.target === modal) closeImport(); };

$("import-parse").onclick = async () => {
  const markdown = $("import-text").value;
  if (!markdown.trim()) { alert("Paste some markdown first."); return; }
  try {
    const res = await api.send("POST", "/api/import/preview", {
      markdown,
      default_status: $("import-default-status").value,
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
  const box = $("import-rows");
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
  $("import-summary").textContent =
    `${importItems.length} found · ${n} selected` + (warned ? ` · ${warned} need a look` : "");
  const btn = $("import-commit");
  btn.textContent = n ? `Import ${n}` : "Import";
  btn.disabled = !n;
}

const setAll = (fn) => {
  importItems.forEach((i) => { i.include = fn(i); });
  renderReview();
};
$("sel-all").onclick = () => setAll(() => true);
$("sel-none").onclick = () => setAll(() => false);
$("sel-clean").onclick = () => setAll((i) => !i.warnings.length && !!i.title.trim());

$("import-commit").onclick = async () => {
  const btn = $("import-commit");
  btn.disabled = true;
  try {
    const res = await api.send("POST", "/api/import/commit", {
      items: importItems.filter((i) => i.include),
      create_categories: $("import-create-cats").checked,
    });
    closeImport();
    await reload();
    const extra = res.categories_created.length
      ? ` (new categories: ${res.categories_created.join(", ")})` : "";
    alert(`Imported ${res.created} task${res.created === 1 ? "" : "s"}${extra}.`);
  } catch (err) {
    alert(err.message);   // nothing was written — the batch rolls back server-side
    btn.disabled = false;
  }
};
