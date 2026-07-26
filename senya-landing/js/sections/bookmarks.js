// Bookmarks bar: always visible, icon-first row directly under search. Editable
// behind one bar-level control at the END of the row rather than per-tile
// controls: the ✎+ cell is edit and add at the same time — it turns on edit mode
// AND opens a blank add form in one click. While it's on, clicking a bookmark
// loads it into that same form to rename/re-url, and each tile shows a ✕ to
// delete. Saving keeps edit mode on and resets the form back to "add", so you
// can add several in a row; the cell (or Done, or Esc) exits.
// Persisted in localStorage over the BOOKMARKS defaults from config.js.

import { BOOKMARKS } from "../config.js";
import { el } from "../utils.js";

const STORAGE_KEY = "senya.bookmarks.v1";
const AVATAR_COLORS = ["#818cf8", "#5eead4", "#fb7185", "#fbbf24", "#60a5fa", "#c084fc"];

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (Array.isArray(saved)) return saved;
  } catch {}
  return BOOKMARKS.map((b, i) => ({ id: "b" + i, ...b }));
}

function persist(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch {}
}

// Bookmark icons come from all over: some are solid black (GitHub, OpenAI) and
// disappear against the dark row, others are solid white and would disappear on
// a light plate. So decide per icon — average the image's own visible pixels and
// plate only the dark ones. Same-origin images, so the canvas isn't tainted.
function isDarkIcon(img) {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 16;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 16, 16);
    const { data } = ctx.getImageData(0, 0, 16, 16);
    let lum = 0, weight = 0;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3] / 255;
      if (!alpha) continue; // transparent padding says nothing about the logo
      lum += ((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255) * alpha;
      weight += alpha;
    }
    // Measured over the current icon set: the invisible ones land at 0.00–0.11
    // (OpenAI, Tailscale, Wikipedia) while the darkest still-legible logo is
    // YouTube's red at 0.26 — so 0.20 plates exactly what needs it.
    return weight > 0 && lum / weight < 0.20;
  } catch {
    return false; // canvas unavailable — leave the icon as-is
  }
}

function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initBookmarks() {
  const row = document.getElementById("bookmarks")?.closest(".bookmarks-row") || document.querySelector(".bookmarks-row");
  const wrap = document.getElementById("bookmarks");
  const editBtn = document.getElementById("bm-edit-toggle");
  const form = document.getElementById("bm-form");
  const nameInput = document.getElementById("bm-form-name");
  const urlInput = document.getElementById("bm-form-url");
  const saveBtn = document.getElementById("bm-form-save");
  const cancelBtn = document.getElementById("bm-form-cancel");
  if (!wrap || !row) return;

  let list = load();
  let editMode = false;
  let editingId = null; // id being edited, or null when adding

  function render() {
    row.dataset.edit = String(editMode);
    editBtn.classList.toggle("active", editMode);
    wrap.replaceChildren(...list.map(tileFor));
  }

  function tileFor(b) {
    const tile = el("div", { class: "bm-tile", title: b.name });
    if (b.icon) {
      const img = el("img", { alt: "", src: `icons/${b.icon}.png` });
      img.addEventListener("load", () => img.classList.toggle("plate", isDarkIcon(img)));
      img.addEventListener("error", function onErr() { img.removeEventListener("error", onErr); img.remove(); tile.append(avatar(b)); });
      tile.append(img);
    } else {
      tile.append(avatar(b));
    }
    const del = el("span", { class: "bm-del", title: "Delete" }, "✕");
    del.addEventListener("click", (e) => { e.stopPropagation(); list = list.filter((x) => x.id !== b.id); persist(list); render(); });
    tile.append(del);
    tile.addEventListener("click", () => { if (editMode) openForm(b); else window.open(withScheme(b.url), "_blank", "noopener,noreferrer"); });
    return tile;
  }

  function avatar(b) {
    return el("span", { class: "bm-avatar", style: `background:${avatarColor(b.name)}` }, (b.name[0] || "?").toUpperCase());
  }

  function withScheme(url) { return /^https?:\/\//.test(url) ? url : `https://${url}`; }

  // `existing` = null → the add half of the form; a bookmark → the edit half.
  function openForm(existing) {
    editingId = existing ? existing.id : null;
    nameInput.value = existing ? existing.name : "";
    urlInput.value = existing ? existing.url : "";
    saveBtn.textContent = existing ? "Save" : "Add";
    form.hidden = false;
    nameInput.focus();
  }
  function closeForm() { form.hidden = true; editingId = null; }

  // One control for both jobs: on → edit mode + a blank add form; off → neither.
  function setEditMode(on) {
    editMode = on;
    if (on) openForm(null); else closeForm();
    render();
  }

  editBtn.addEventListener("click", () => setEditMode(!editMode));
  cancelBtn.addEventListener("click", () => setEditMode(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && editMode) setEditMode(false); });
  saveBtn.addEventListener("click", () => {
    const name = nameInput.value.trim(), url = urlInput.value.trim();
    if (!name || !url) return;
    if (editingId) list = list.map((b) => (b.id === editingId ? { ...b, name, url } : b));
    else list = [...list, { id: "b" + Date.now(), name, url, icon: null }];
    persist(list);
    openForm(null); // stay in edit mode, ready for the next add
    render();
  });

  render();
}
