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
    CACHE.set(name, fetch(`components/${name}.html`, { cache: "no-store" }).then((res) => {
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

// Awaited by main.js before any section init runs, so every init finds its
// container already in the document.
export function renderPage(root = document.body) {
  return mount(root);
}
