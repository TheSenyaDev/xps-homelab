// Customize panel: show/hide and reorder dashboard sections. Opens as a side
// drawer on desktop and a bottom sheet on mobile (pure CSS, toggled by the
// `settings-open` body class). Reordering uses Pointer Events so it works with
// both mouse and touch — HTML5 drag-and-drop doesn't fire on touch.

import { el } from "./utils.js";
import { getSectionsState, setHidden, setOrder } from "./layout.js";
import { getFont, setFont, getZoom, setZoom, LIMITS } from "./ui-scale.js";

export function initSettings() {
  const btn = document.getElementById("settings-btn");
  const panel = document.getElementById("settings");
  const list = document.getElementById("settings-list");
  const backdrop = document.getElementById("settings-backdrop");
  const scaleWrap = document.getElementById("settings-scale");
  if (!btn || !panel || !list) return;

  // ---- size controls: font and zoom, independent ----

  let paintScale = () => {};
  if (scaleWrap) {
    // Two identical −/value/+/reset rows over different setters.
    const knob = (name, hint, get, set, limits) => {
      const value = el("span", { class: "scale-value" });
      const paint = () => { value.textContent = `${Math.round(get() * 100)}%`; };
      const bump = (d) => { set(get() + d); paint(); };
      const range = `${Math.round(limits.min * 100)}–${Math.round(limits.max * 100)}%`;

      const row = el("div", { class: "set-row set-scale" },
        el("span", { class: "set-name" },
          name, el("span", { class: "set-sub", text: hint })),
        el("div", { class: "scale-ctl" },
          el("button", { type: "button", class: "scale-btn", title: `Smaller (${range})`, "aria-label": `Decrease ${name}`, text: "−", onclick: () => bump(-limits.step) }),
          value,
          el("button", { type: "button", class: "scale-btn", title: `Bigger (${range})`, "aria-label": `Increase ${name}`, text: "+", onclick: () => bump(limits.step) }),
          el("button", { type: "button", class: "scale-reset", title: "Back to 100%", text: "reset", onclick: () => { set(1); paint(); } })));
      return { row, paint };
    };

    const font = knob("Font", "text only", getFont, setFont, LIMITS.font);
    const zoom = knob("Zoom", "whole page", getZoom, setZoom, LIMITS.zoom);
    scaleWrap.replaceChildren(font.row, zoom.row);
    paintScale = () => { font.paint(); zoom.paint(); }; // re-read on open
    paintScale();
  }

  const isOpen = () => document.body.classList.contains("settings-open");
  const open = () => { document.body.classList.add("settings-open"); panel.setAttribute("aria-hidden", "false"); paintScale(); renderList(); };
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
