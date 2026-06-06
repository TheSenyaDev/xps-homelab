// View density: "comfortable" (default, roomy cards) vs "compact" (denser, more
// info per screen). Implemented as a single body class so the difference lives
// in CSS (styles/compact.css) — sections don't need to know which view is on.

import { store } from "./utils.js";

const KEY = "senya.view";
const MODES = ["comfortable", "compact"];

export function initViews() {
  const saved = store.get(KEY, "comfortable");
  apply(MODES.includes(saved) ? saved : "comfortable");

  const toggle = document.getElementById("view-toggle");
  if (!toggle) return;
  toggle.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => apply(b.dataset.view)));
}

function apply(mode) {
  document.body.classList.toggle("compact", mode === "compact");
  store.set(KEY, mode);
  document.querySelectorAll("#view-toggle button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === mode));
}
