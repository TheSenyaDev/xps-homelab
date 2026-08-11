// SenyaScraper frontend. Two modes over the same grid:
//   • live search      — POST /api/search, nothing persisted
//   • saved search run — POST /api/searches/<id>/run, which also reports which
//     listings are new and which dropped in price since the last run
// The NEW/DROP marks are the reason saved searches exist, so they are passed
// down as a set of uids and rendered as chips rather than a separate list.

const $ = (id) => document.getElementById(id);
const form = $("search-form");
const grid = $("grid");
const statusEl = $("status");
const savedEl = $("saved");

const money = (v, cur) =>
  v == null ? "" : new Intl.NumberFormat("en-CA", { style: "currency", currency: cur || "CAD" }).format(v);

function setStatus(msg, isError = false) {
  statusEl.classList.toggle("err", isError);
  statusEl.innerHTML = msg;
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ----- rendering -----

function card(item, marks = {}) {
  const el = document.createElement("article");
  el.className = "card";

  const price = item.price != null ? money(item.price, item.currency) : (item.price_text || "—");
  const was = marks.was != null ? `<span class="was">${money(marks.was, item.currency)}</span>` : "";

  const chips = [];
  if (marks.isNew) chips.push('<span class="chip new">NEW</span>');
  if (marks.was != null) chips.push('<span class="chip drop">DROP</span>');
  if (item.condition) chips.push(`<span class="chip cond">${esc(item.condition)}</span>`);
  if (item.extra && item.extra.best_offer) chips.push('<span class="chip offer">OBO</span>');
  if (item.shipping) chips.push(`<span class="chip ship">${esc(item.shipping)}</span>`);

  el.innerHTML = `
    <div class="thumb">${
      item.image ? `<img src="${esc(item.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
                 : '<span class="none">no image</span>'}</div>
    <div class="body">
      <a class="title" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
      <div class="price">${esc(price)}${was}</div>
      <div class="row">${chips.join("")}</div>
      ${item.seller ? `<div class="seller">${esc(item.seller)}</div>` : ""}
    </div>`;
  return el;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function render(items, { newUids = new Set(), drops = new Map() } = {}) {
  grid.replaceChildren();
  if (!items.length) {
    setStatus("No listings matched.");
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items) {
    frag.append(card(it, { isNew: newUids.has(it.uid), was: drops.get(it.uid) }));
  }
  grid.append(frag);
}

// ----- live search -----

function formPayload() {
  return {
    query: $("q").value.trim(),
    site: $("site").value,
    category: $("category").value,
    sort: $("sort").value,
    condition: $("condition").value,
    min_price: $("min_price").value || null,
    max_price: $("max_price").value || null,
  };
}

// Sites advertise what they can actually filter by, so a site without price
// filtering shows a disabled box rather than a control that quietly does
// nothing. Driven entirely by /api/sites — no per-site code here.
let SITES = [];

function applySiteCapabilities() {
  const site = SITES.find((s) => s.key === $("site").value);
  if (!site) return;
  const sup = site.supports || {};
  $("sort").disabled = !sup.sort;
  $("condition").disabled = !sup.condition;
  $("min_price").disabled = $("max_price").disabled = !sup.price_range;

  const cats = site.categories || [];
  const sel = $("category");
  sel.hidden = !cats.length;
  sel.replaceChildren(...cats.map((c) => {
    const o = document.createElement("option");
    o.value = c.key;
    o.textContent = c.label;
    return o;
  }));
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = formPayload();
  if (!payload.query) return;
  grid.replaceChildren();
  setStatus("searching…");
  try {
    const data = await api("/api/search", { method: "POST", body: JSON.stringify(payload) });
    setStatus(`<span class="k">${data.count}</span> listings`);
    render(data.results);
  } catch (err) {
    setStatus(esc(err.message), true);
  }
});

// ----- saved searches -----

$("save").addEventListener("click", async () => {
  const payload = formPayload();
  if (!payload.query) return setStatus("Nothing to save — enter a query first.", true);
  try {
    await api("/api/searches", { method: "POST", body: JSON.stringify(payload) });
    await loadSaved();
    setStatus("Saved. Run it any time to see what changed.");
  } catch (err) {
    setStatus(esc(err.message), true);
  }
});

async function loadSaved() {
  const rows = await api("/api/searches").catch(() => []);
  savedEl.replaceChildren();
  for (const s of rows) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="nm">${esc(s.name)}</span>
      <span class="meta">
        <span>${esc(s.site)} · ${s.live_count ?? 0}</span>
        <button class="del" title="Delete">✕</button>
      </span>`;
    li.querySelector(".del").addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/api/searches/${s.id}`, { method: "DELETE" });
      loadSaved();
    });
    li.addEventListener("click", () => runSaved(s));
    savedEl.append(li);
  }
}

async function runSaved(s) {
  grid.replaceChildren();
  setStatus(`running “${esc(s.name)}”…`);
  try {
    const data = await api(`/api/searches/${s.id}/run`, { method: "POST" });
    const newUids = new Set(data.new.map((i) => i.uid));
    const drops = new Map(data.price_drops.map((i) => [i.uid, i.was]));
    const bits = [`<span class="k">${data.total}</span> listings`];
    if (newUids.size) bits.push(`<span class="k">${newUids.size}</span> new`);
    if (drops.size) bits.push(`<span class="k">${drops.size}</span> price drop${drops.size > 1 ? "s" : ""}`);
    setStatus(bits.join(" · "));
    // New and discounted first — the whole reason for re-running.
    const rank = (i) => (newUids.has(i.uid) ? 0 : drops.has(i.uid) ? 1 : 2);
    render([...data.results].sort((a, b) => rank(a) - rank(b)), { newUids, drops });
    loadSaved();
  } catch (err) {
    setStatus(esc(err.message), true);
  }
}

// ----- boot -----

(async function init() {
  SITES = await api("/api/sites").catch(() => []);
  $("site").replaceChildren(...SITES.map((s) => {
    const o = document.createElement("option");
    o.value = s.key;
    o.textContent = s.label;
    return o;
  }));
  $("site").addEventListener("change", applySiteCapabilities);
  applySiteCapabilities();
  await loadSaved();
  $("q").focus();
})();
