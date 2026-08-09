// Page composer — turns the section slots in index.html into the real page by
// pulling in the HTML components from /components.
//
// The markup lives in plain .html files (one per section: top bar, bookmarks
// bar, main table, …) rather than in one long index.html or in JS template
// strings, so a section can be read, edited or moved on its own. A slot is any
// element with a data-component attribute:
//
//     <div data-component="top-bar"></div>   →  components/top-bar.html
//
// The slot element is *replaced* by the file's contents (no wrapper div is left
// behind, so CSS like .main-table > .rail keeps working), and components may
// nest — main-table.html is itself just three slots. Each file is fetched once
// and cached, so a component used twice costs one request.
//
// Adding a section: write components/<name>.html, then drop a
// <div data-component="<name>"></div> where it belongs (index.html for a
// page-level section, or inside another component).

const CACHE = new Map(); // name -> Promise<string>

function fetchComponent(name) {
  if (!CACHE.has(name)) {
    // No `cache: "no-store"`: that forced a full re-download of every component
    // on every load, which off-LAN is the slowest part of the page. nginx sends
    // these as no-cache, so the browser still revalidates and never shows a
    // stale component — it just gets a 304 instead of the body.
    CACHE.set(name, fetch(`components/${name}.html`).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} for components/${name}.html`);
      return res.text();
    }));
  }
  return CACHE.get(name);
}

// Resolve every slot in `scope` (an element or a fragment), depth-first so a
// component's own slots are filled before it lands in the document.
async function mount(scope) {
  const slots = [...scope.querySelectorAll("[data-component]")];
  await Promise.all(slots.map(async (slot) => {
    const name = slot.dataset.component;
    try {
      const tpl = document.createElement("template");
      tpl.innerHTML = (await fetchComponent(name)).trim();
      await mount(tpl.content);
      slot.replaceWith(tpl.content);
    } catch (e) {
      console.error(`[senya] component "${name}" failed to load:`, e);
      slot.remove(); // leave a hole rather than an empty placeholder box
    }
  }));
}

// Components nest three deep (index → main-table → info-pane → system-panel),
// and mount() can only discover a nested slot after its parent's HTML has
// arrived — so left alone the eight files land in three sequential round trips.
// Naming them up front starts all eight at once instead, turning three waves
// into one. This is a hint, not a source of truth: mount() still fetches
// whatever a slot actually asks for, so a stale name here costs one wasted
// request, and a missing one just falls back to the old behaviour.
const PRELOAD = [
  "top-bar", "bookmarks-bar", "main-table", "settings-drawer",
  "launcher-rail", "dashboard-grid", "info-pane", "system-panel",
];

// Awaited by main.js before any section init runs, so every init finds its
// container already in the document.
export function renderPage(root = document.body) {
  // Kick every fetch off before the first await; failures are handled by
  // mount() when it awaits the same cached promise.
  for (const name of PRELOAD) fetchComponent(name).catch(() => {});
  return mount(root);
}
