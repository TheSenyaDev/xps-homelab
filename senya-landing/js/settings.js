// Customize panel: show/hide and reorder dashboard sections. Opens as a side
// drawer on desktop and a bottom sheet on mobile (pure CSS, toggled by the
// `settings-open` body class). Reordering uses Pointer Events so it works with
// both mouse and touch — HTML5 drag-and-drop doesn't fire on touch.

import { el } from "./utils.js";
import { getSectionsState, setHidden, setOrder } from "./layout.js";

export function initSettings() {
  const btn = document.getElementById("settings-btn");
  const panel = document.getElementById("settings");
  const list = document.getElementById("settings-list");
  const backdrop = document.getElementById("settings-backdrop");
  if (!btn || !panel || !list) return;

  const isOpen = () => document.body.classList.contains("settings-open");
  const open = () => { document.body.classList.add("settings-open"); panel.setAttribute("aria-hidden", "false"); renderList(); };
  const close = () => { document.body.classList.remove("settings-open"); panel.setAttribute("aria-hidden", "true"); };

  btn.addEventListener("click", () => (isOpen() ? close() : open()));
  backdrop?.addEventListener("click", close);
  document.getElementById("settings-close")?.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen()) close(); });

  // ---- list rendering ----

  function renderList() {
    list.replaceChildren(...getSectionsState().map(rowFor));
  }

  function rowFor(s) {
    const handle = el("span", { class: "set-handle", title: "Drag to reorder", "aria-hidden": "true", text: "⠿" });

    const toggle = el("input", { type: "checkbox", class: "set-toggle" });
    toggle.checked = !s.hidden;
    toggle.addEventListener("change", () => setHidden(s.id, !toggle.checked));

    const row = el("li", { class: "set-row", "data-id": s.id },
      handle,
      el("span", { class: "set-name", text: s.title }),
      el("label", { class: "set-switch" }, toggle, el("span", { class: "set-track" })));

    handle.addEventListener("pointerdown", (e) => startDrag(e, row));
    return row;
  }

  // ---- pointer-drag reorder ----

  let dragRow = null;

  function startDrag(e, row) {
    e.preventDefault();
    dragRow = row;
    row.classList.add("dragging");
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  }

  // Slot the dragged row before whichever sibling its midpoint has passed.
  function onMove(e) {
    if (!dragRow) return;
    const rows = [...list.querySelectorAll(".set-row:not(.dragging)")];
    const after = rows.find((r) => {
      const box = r.getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    });
    if (after) list.insertBefore(dragRow, after);
    else list.appendChild(dragRow);
  }

  function endDrag(e) {
    if (!dragRow) return;
    const handle = e.currentTarget;
    handle.releasePointerCapture?.(e.pointerId);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", endDrag);
    handle.removeEventListener("pointercancel", endDrag);
    dragRow.classList.remove("dragging");
    dragRow = null;
    setOrder([...list.querySelectorAll(".set-row")].map((r) => r.dataset.id));
  }
}
