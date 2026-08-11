// Dialog opening, and the background lock that goes with it.
//
// showModal() already makes the rest of the page inert, so nothing behind can
// be clicked or focused. body.modal-open adds the two things inertness does not
// cover: a drag selecting text through the backdrop, and the page scrolling
// underneath.
//
// Opening goes through here so the lock is always paired with a close, and it
// is cleared from the dialog's own `close` event — which fires however the
// dialog goes away, including Escape and an outside click.

export function openModal(dlg) {
  dlg.showModal();
  document.body.classList.add("modal-open");
}

function anyOpen() {
  return document.querySelectorAll("dialog[open]").length > 0;
}

// Capturing, because `close` does not bubble. Cleared only when no dialog is
// left open, so closing one of two stacked dialogs does not unlock the page.
document.addEventListener("close", (e) => {
  if (e.target instanceof HTMLDialogElement && !anyOpen()) {
    document.body.classList.remove("modal-open");
  }
}, true);

/**
 * Close when the backdrop is clicked.
 *
 * A <dialog> backdrop is not a separate element — the click lands on the dialog
 * itself — so this compares the pointer against the dialog's box rather than
 * testing `e.target === dlg`, which also fires on padding inside it.
 *
 * Opt-in per dialog: read-only panels should dismiss on a stray click, forms
 * should not, because that would discard what was typed.
 */
export function closeOnBackdrop(dlg) {
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right &&
                   e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dlg.close();
  });
}
