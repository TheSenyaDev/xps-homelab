import { internal, SEARCH_ENGINES } from "../config.js";

export function initSearch() {
  // SearXNG is internal-only; drop the option when off-network.
  if (!internal) {
    const sx = document.querySelector('label[data-engine="searxng"]');
    if (sx) sx.remove();
    const g = document.querySelector('input[name="engine"][value="google"]');
    if (g) g.checked = true;
  }

  const form = document.getElementById("search");
  if (!form) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = document.getElementById("q").value.trim();
    if (!q) return;
    const sel = document.querySelector('input[name="engine"]:checked');
    const engine = sel ? sel.value : "google";
    window.location.href = (SEARCH_ENGINES[engine] || SEARCH_ENGINES.google) + encodeURIComponent(q);
  });
}
