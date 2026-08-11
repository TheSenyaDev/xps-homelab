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
    params: readOptions($("site-opts")),
  };
}

// Sites advertise what they can filter by and which filters are theirs alone,
// so a site without price filtering shows a disabled box rather than a control
// that quietly does nothing. Driven entirely by /api/sites — there is no
// per-site code in this file, and none should be added.
let SITES = [];

const siteByKey = (key) => SITES.find((s) => s.key === key);

// ---- site-specific options ----

// Build controls from a site's declared options. Used for both the live search
// bar and the profile dialog, so the two can never drift apart.
function renderOptions(host, site, values = {}) {
  host.replaceChildren();
  const opts = (site && site.options) || [];
  host.hidden = !opts.length;
  if (!opts.length) return;

  for (const o of opts) {
    const val = values[o.key] !== undefined ? values[o.key] : o.default;
    const wrap = document.createElement("label");
    wrap.className = `opt opt-${o.type}`;
    wrap.title = o.help || "";

    let input;
    if (o.type === "choice") {
      input = document.createElement("select");
      input.replaceChildren(...o.choices.map((c) => {
        const el = document.createElement("option");
        el.value = c.value;
        el.textContent = c.label;
        return el;
      }));
      input.value = val ?? o.choices[0]?.value;
      wrap.append(labelSpan(o), input);
    } else if (o.type === "bool") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!val;
      wrap.append(input, labelSpan(o));
    } else {
      input = document.createElement("input");
      input.type = o.type === "number" ? "number" : "text";
      if (val != null) input.value = val;
      wrap.append(labelSpan(o), input);
    }
    input.dataset.optKey = o.key;
    input.dataset.optType = o.type;
    host.append(wrap);
  }
}

function labelSpan(o) {
  const s = document.createElement("span");
  s.textContent = o.label;
  return s;
}

function readOptions(host) {
  const out = {};
  for (const el of host.querySelectorAll("[data-opt-key]")) {
    out[el.dataset.optKey] =
      el.dataset.optType === "bool" ? el.checked
      : el.dataset.optType === "number" ? (el.value === "" ? null : Number(el.value))
      : el.value;
  }
  return out;
}

function applySiteCapabilities() {
  const site = siteByKey($("site").value);
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
  renderOptions($("site-opts"), site);
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

// One dialog for create and edit; `editing` decides which. Prefilling it from
// the live search bar means SAVE is "turn what I just ran into a profile"
// rather than a second place to retype everything.
const dlg = $("dlg");
let editing = null;      // the row being edited, or null when creating
let editingParams = {};  // that row's per-site params, so switching Site keeps both

function openDialog(row = null, prefill = null) {
  editing = row;
  editingParams = row ? safeJson(row.params) : {};
  $("dlg-title").textContent = row ? "EDIT SEARCH" : "NEW SEARCH";
  $("dlg-err").hidden = true;

  const src = row || prefill || {};
  $("f-site").replaceChildren(...SITES.map((s) => {
    const o = document.createElement("option");
    o.value = s.key;
    o.textContent = s.label;
    return o;
  }));
  $("f-site").value = src.site || SITES[0]?.key || "";
  $("f-name").value = row ? row.name : "";
  $("f-query").value = src.query || "";
  $("f-condition").value = src.condition || "any";
  $("f-sort").value = src.sort || "best";
  $("f-min").value = src.min_price ?? "";
  $("f-max").value = src.max_price ?? "";
  $("f-notify").checked = row ? !!row.notify : true;

  syncDialogSite(src.category || "", prefill?.params);
  dlg.showModal();
  $("f-query").focus();
}

// Category list and site-specific controls both depend on the chosen site, so
// they are rebuilt together whenever it changes.
function syncDialogSite(category = "", overrideParams = null) {
  const site = siteByKey($("f-site").value);
  const cats = (site && site.categories) || [];
  $("f-category-row").hidden = !cats.length;
  $("f-category").replaceChildren(...cats.map((c) => {
    const o = document.createElement("option");
    o.value = c.key;
    o.textContent = c.label;
    return o;
  }));
  if (category) $("f-category").value = category;

  const values = overrideParams || editingParams[$("f-site").value] || {};
  renderOptions($("f-opts"), site, values);
  $("f-opts-wrap").hidden = !((site && site.options) || []).length;
  $("f-opts-legend").textContent = `${site ? site.label : "Site"} options`;
}

$("f-site").addEventListener("change", () => {
  // Remember what was typed for the site being left, so flipping back restores it.
  const prev = readOptions($("f-opts"));
  if (Object.keys(prev).length) editingParams[lastDialogSite] = prev;
  lastDialogSite = $("f-site").value;
  syncDialogSite();
});
let lastDialogSite = "";

function safeJson(s) {
  try { const v = JSON.parse(s || "{}"); return typeof v === "object" && v ? v : {}; }
  catch { return {}; }
}

$("new").addEventListener("click", () => openDialog());
$("dlg-cancel").addEventListener("click", () => dlg.close());

// SAVE in the top bar: same dialog, prefilled from whatever is in the bar.
$("save").addEventListener("click", () => openDialog(null, formPayload()));

$("dlg-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    name: $("f-name").value.trim(),
    site: $("f-site").value,
    query: $("f-query").value.trim(),
    category: $("f-category").value,
    condition: $("f-condition").value,
    sort: $("f-sort").value,
    min_price: $("f-min").value || null,
    max_price: $("f-max").value || null,
    notify: $("f-notify").checked,
    params: readOptions($("f-opts")),
  };
  try {
    if (editing) {
      await api(`/api/searches/${editing.id}`, { method: "PATCH", body: JSON.stringify(payload) });
    } else {
      await api("/api/searches", { method: "POST", body: JSON.stringify(payload) });
    }
    dlg.close();
    await loadSaved();
    setStatus(editing ? "Updated." : "Saved. Run it any time to see what changed.");
  } catch (err) {
    $("dlg-err").textContent = err.message;
    $("dlg-err").hidden = false;
  }
});

async function loadSaved() {
  const rows = await api("/api/searches").catch(() => []);
  savedEl.replaceChildren();
  for (const s of rows) {
    // A one-line summary of the criteria, so a profile is identifiable without
    // opening it. Only the parts that are actually set are shown.
    const bits = [esc(s.site)];
    if (s.min_price != null || s.max_price != null) {
      bits.push(`$${s.min_price ?? 0}–${s.max_price ?? "∞"}`);
    }
    if (s.condition && s.condition !== "any") bits.push(esc(s.condition));

    const li = document.createElement("li");
    li.innerHTML = `
      <span class="nm">${esc(s.name)}</span>
      <span class="crit">${bits.join(" · ")}</span>
      <span class="meta">
        <span>${s.live_count ?? 0} listings</span>
        <span class="acts">
          <button class="edit" title="Edit">✎</button>
          <button class="del" title="Delete">✕</button>
        </span>
      </span>`;
    li.querySelector(".edit").addEventListener("click", (e) => {
      e.stopPropagation();
      openDialog(s);
    });
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
