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

// A combined search can half-succeed, so the status line has to be able to say
// "here are results, and also this site is down" at the same time.
function statusLine(data, extra = []) {
  const bits = [`<span class="k">${data.count ?? data.total ?? 0}</span> listings`];
  if ((data.sites || []).length > 1) bits.push(`${data.sites.length} markets`);
  bits.push(...extra);
  let line = bits.join(" · ");
  for (const e of data.errors || []) {
    line += `<div class="warn">⚠ ${esc(e.label)}: ${esc(e.error)}</div>`;
  }
  return line;
}

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

// Set while a saved search's results are displayed, so the ⊘ knows which
// search to block the seller for. Null during a live search, where there is no
// profile to store a blocklist on.
let currentSearch = null;
// Whether the results on screen came from more than one marketplace.
let MULTI_SITE = false;
// Last saved-search run, so the blocked toggle re-renders from memory rather
// than re-scraping every market.
let LAST_RUN = null;
const siteLabel = (key) => (siteByKey(key) || {}).label || key;

function card(item, marks = {}) {
  const el = document.createElement("article");
  el.className = "card";

  const price = item.price != null ? money(item.price, item.currency) : (item.price_text || "—");
  const was = marks.was != null ? `<span class="was">${money(marks.was, item.currency)}</span>` : "";

  const chips = [];
  if (marks.blocked) chips.push('<span class="chip blocked">BLOCKED</span>');
  if (marks.isNew) chips.push('<span class="chip new">NEW</span>');
  if (marks.was != null) chips.push('<span class="chip drop">DROP</span>');
  // Only worth the space when results are mixed; on a single-site search every
  // card would carry the same badge.
  if (MULTI_SITE) chips.push(`<span class="chip site">${esc(siteLabel(item.site))}</span>`);
  if (item.condition) chips.push(`<span class="chip cond">${esc(item.condition)}</span>`);
  if (item.location) chips.push(`<span class="chip ship">${esc(item.location)}</span>`);
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
      ${sellerRow(item)}
    </div>`;
  const blockBtn = el.querySelector(".block");
  if (blockBtn) {
    blockBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await blockSeller(item.seller_name, item.site);
    });
  }
  // Anywhere but the title link opens the panel; the link itself still goes
  // straight to the listing, which is what a link is for.
  el.addEventListener("click", (e) => {
    if (e.target.closest("a, button")) return;
    openItem(item, marks);
  });
  if (marks.blocked) el.classList.add("is-blocked");
  return el;
}

function sellerRow(item) {
  if (!item.seller) return "";
  // Only offer the block when there is a saved search to remember it on.
  const btn = (currentSearch && item.seller_name)
    ? `<button class="block" title="Hide ${esc(item.seller_name)} from this search">⊘</button>`
    : "";
  return `<div class="seller">${esc(item.seller)}${btn}</div>`;
}

// `site` is required, not inferred: the same name on two marketplaces is two
// unrelated sellers, so a block has to say which one it means.
async function blockSeller(name, site, { unblock = false } = {}) {
  if (!currentSearch || !name || !site) return;
  try {
    await api(`/api/searches/${currentSearch.id}/block`, {
      method: "POST",
      body: JSON.stringify({ seller: name, site, unblock }),
    });
    const verb = unblock ? "Unblocked" : "Blocked";
    setStatus(`${verb} <span class="k">${esc(name)}</span> on ${esc(siteLabel(site))} — re-running…`);
    runSaved(currentSearch);
  } catch (err) {
    setStatus(esc(err.message), true);
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function render(items, { newUids = new Set(), drops = new Map(),
                        blockedUids = new Set() } = {}) {
  MULTI_SITE = new Set(items.map((i) => i.site)).size > 1;
  grid.replaceChildren();
  if (!items.length) {
    setStatus("No listings matched.");
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items) {
    frag.append(card(it, { isNew: newUids.has(it.uid), was: drops.get(it.uid),
                           blocked: blockedUids.has(it.uid) }));
  }
  grid.append(frag);
}

// ----- live search -----

function formPayload() {
  return {
    query: $("q").value.trim(),
    sites: $("site").value === "all" ? "all" : [$("site").value],
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
  const key = $("site").value;
  if (key === "all") {
    // Only the filters every site honours make sense across all of them;
    // per-site options are configured on a saved profile instead.
    $("sort").disabled = $("condition").disabled = false;
    $("min_price").disabled = $("max_price").disabled = false;
    $("category").hidden = true;
    renderOptions($("site-opts"), null);
    return;
  }
  const site = siteByKey(key);
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
  currentSearch = null;
  LAST_RUN = null;
  $("show-blocked-wrap").hidden = true;
  grid.replaceChildren();
  setStatus("searching…");
  try {
    const data = await api("/api/search", { method: "POST", body: JSON.stringify(payload) });
    setStatus(statusLine(data));
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
let editingBlocked = {}; // {site: [names]} — blocklists are per marketplace

function openDialog(row = null, prefill = null) {
  editing = row;
  editingParams = row ? safeJson(row.params) : {};
  $("dlg-title").textContent = row ? "EDIT SEARCH" : "NEW SEARCH";
  $("dlg-err").hidden = true;

  const src = row || prefill || {};
  // Which markets this profile covers. Stored as a JSON array; fall back to the
  // legacy single `site` for profiles saved before multi-site existed.
  let chosen = row ? safeList(row.sites) : (Array.isArray(src.sites) ? src.sites : []);
  if (!chosen.length) chosen = [src.site || SITES[0]?.key].filter(Boolean);
  if (chosen.includes("all")) chosen = SITES.map((s) => s.key);
  renderSitePicker(chosen);
  $("f-name").value = row ? row.name : "";
  $("f-query").value = src.query || "";
  $("f-condition").value = src.condition || "any";
  $("f-sort").value = src.sort || "best";
  $("f-min").value = src.min_price ?? "";
  $("f-max").value = src.max_price ?? "";
  $("f-notify").checked = row ? !!row.notify : true;
  editingBlocked = row ? safeJson(row.blocked_sellers, {}) : {};
  if (Array.isArray(editingBlocked)) editingBlocked = {};   // legacy flat list

  syncDialogSite(src.category || "", prefill?.params);
  dlg.showModal();
  $("f-query").focus();
}

// Category list and site-specific controls both depend on the chosen site, so
// they are rebuilt together whenever it changes.
// One checkbox per market. Changing the selection re-renders the per-site
// option panels below, so each chosen site configures itself independently.
function renderSitePicker(chosen) {
  const host = $("f-sites");
  host.replaceChildren(...SITES.map((s) => {
    const label = document.createElement("label");
    label.className = "opt opt-bool";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = s.key;
    cb.checked = chosen.includes(s.key);
    cb.dataset.siteKey = s.key;
    cb.addEventListener("change", () => {
      if (!chosenSites().length) cb.checked = true;   // never leave it empty
      syncDialogSite();
    });
    label.append(cb, labelSpan({ label: s.label }));
    return label;
  }));
}

function chosenSites() {
  return [...$("f-sites").querySelectorAll("input:checked")].map((c) => c.dataset.siteKey);
}

function syncDialogSite(category = "", overrideParams = null) {
  const keys = chosenSites();
  const site = siteByKey(keys[0]);
  const cats = (site && site.categories) || [];
  $("f-category-row").hidden = !cats.length;
  $("f-category").replaceChildren(...cats.map((c) => {
    const o = document.createElement("option");
    o.value = c.key;
    o.textContent = c.label;
    return o;
  }));
  if (category) $("f-category").value = category;

  renderBlockedFields(keys);

  const host = $("f-opts");
  host.replaceChildren();
  let any = false;
  for (const key of keys) {
    const s = siteByKey(key);
    if (!s || !(s.options || []).length) continue;
    any = true;
    const block = document.createElement("div");
    block.className = "opt-block";
    block.dataset.siteKey = key;
    const h = document.createElement("div");
    h.className = "opt-block-head";
    h.textContent = s.label;
    const body = document.createElement("div");
    renderOptions(body, s, overrideParams || editingParams[key] || {});
    block.append(h, body);
    host.append(block);
  }
  $("f-opts-wrap").hidden = !any;
  $("f-opts-legend").textContent = "Per-market options";
}

// One blocklist box per chosen market that actually exposes sellers. A market
// without seller data gets no box rather than a box that cannot work.
function renderBlockedFields(keys) {
  const host = $("f-blocked");
  host.replaceChildren();
  let any = false;
  for (const key of keys) {
    const site = siteByKey(key);
    if (!site || site.supports?.seller === false) continue;
    any = true;
    const label = document.createElement("label");
    label.className = "blocked-row";
    const name = document.createElement("span");
    name.textContent = site.label;
    const ta = document.createElement("textarea");
    ta.rows = 2;
    ta.placeholder = "one per line, or comma-separated";
    ta.value = (editingBlocked[key] || []).join("\n");
    ta.dataset.blockedSite = key;
    label.append(name, ta);
    host.append(label);
  }
  $("f-blocked-wrap").hidden = !any;
}

function readBlocked() {
  const out = {};
  for (const ta of $("f-blocked").querySelectorAll("[data-blocked-site]")) {
    out[ta.dataset.blockedSite] = ta.value;
  }
  return out;
}

// {site: {option: value}} across every rendered block.
function readAllOptions() {
  const out = {};
  for (const block of $("f-opts").querySelectorAll(".opt-block")) {
    out[block.dataset.siteKey] = readOptions(block);
  }
  return out;
}

function safeList(s) {
  const v = safeJson(s, []);
  return Array.isArray(v) ? v : [];
}

function safeJson(s, fallback = {}) {
  try { const v = JSON.parse(s || "null"); return v ?? fallback; }
  catch { return fallback; }
}

$("new").addEventListener("click", () => openDialog());
$("dlg-cancel").addEventListener("click", () => dlg.close());

// SAVE in the top bar: same dialog, prefilled from whatever is in the bar.
$("save").addEventListener("click", () => openDialog(null, formPayload()));

$("dlg-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    name: $("f-name").value.trim(),
    sites: chosenSites(),
    query: $("f-query").value.trim(),
    category: $("f-category").value,
    condition: $("f-condition").value,
    sort: $("f-sort").value,
    min_price: $("f-min").value || null,
    max_price: $("f-max").value || null,
    notify: $("f-notify").checked,
    params: readAllOptions(),
    blocked_sellers: readBlocked(),
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
    const chosen = safeList(s.sites);
    const bits = [chosen.length > 1 ? `${chosen.length} markets` : esc(chosen[0] || s.site)];
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
  currentSearch = s;
  grid.replaceChildren();
  setStatus(`running “${esc(s.name)}”…`);
  try {
    const data = await api(`/api/searches/${s.id}/run`, { method: "POST" });
    const newUids = new Set(data.new.map((i) => i.uid));
    const drops = new Map(data.price_drops.map((i) => [i.uid, i.was]));
    const extra = [];
    if (newUids.size) extra.push(`<span class="k">${newUids.size}</span> new`);
    if (drops.size) extra.push(`<span class="k">${drops.size}</span> price drop${drops.size > 1 ? "s" : ""}`);
    if (data.hidden) extra.push(`<span class="k">${data.hidden}</span> hidden (blocked)`);
    setStatus(statusLine(data, extra));
    LAST_RUN = { data, newUids, drops };
    paintBlockedToggle(data);
    renderRun();
    loadSaved();
  } catch (err) {
    setStatus(esc(err.message), true);
  }
}

function renderRun() {
  if (!LAST_RUN) return;
  const { data, newUids, drops } = LAST_RUN;
  const showBlocked = $("show-blocked").checked;
  const blocked = data.blocked_listings || [];
  const items = showBlocked ? [...data.results, ...blocked] : data.results;
  const blockedUids = new Set(blocked.map((i) => i.uid));
  // New and discounted first — the whole reason for re-running. Blocked ones
  // sink to the bottom so revealing them never buries the results.
  const rank = (i) => (blockedUids.has(i.uid) ? 3
                     : newUids.has(i.uid) ? 0
                     : drops.has(i.uid) ? 1 : 2);
  render([...items].sort((a, b) => rank(a) - rank(b)),
         { newUids, drops, blockedUids });
}

function paintBlockedToggle(data) {
  const n = (data.blocked_listings || []).length;
  $("show-blocked-wrap").hidden = !n;
  $("blocked-count").textContent = n ? `(${n})` : "";
}

$("show-blocked").addEventListener("change", renderRun);

// ----- boot -----

(async function init() {
  SITES = await api("/api/sites").catch(() => []);
  const opts = [{ key: "all", label: "All markets" }, ...SITES];
  $("site").replaceChildren(...opts.map((s) => {
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

// ----- settings -----
// Rendered entirely from /api/settings' schema: the server owns what exists,
// this owns how it looks. Adding a setting server-side needs nothing here.

const settingsDlg = $("settings-dlg");

$("open-settings").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", () => settingsDlg.close());

async function openSettings() {
  $("settings-err").hidden = true;
  $("settings-body").replaceChildren();
  $("settings-status").textContent = "loading…";
  settingsDlg.showModal();
  try {
    const { schema, values } = await api("/api/settings");
    renderSettings(schema, values);
    await paintFetcherStatus();
  } catch (err) {
    $("settings-err").textContent = err.message;
    $("settings-err").hidden = false;
    $("settings-status").textContent = "";
  }
}

function renderSettings(schema, values) {
  const host = $("settings-body");
  const groups = [];
  for (const s of schema) {
    let g = groups.find((x) => x.name === s.group);
    if (!g) groups.push((g = { name: s.group, items: [] }));
    g.items.push(s);
  }
  host.replaceChildren(...groups.map((g) => {
    const fs = document.createElement("fieldset");
    fs.className = "opts";
    const lg = document.createElement("legend");
    lg.textContent = g.name;
    fs.append(lg);
    for (const s of g.items) fs.append(settingRow(s, values[s.key]));
    return fs;
  }));
}

function settingRow(s, value) {
  const wrap = document.createElement("label");
  wrap.className = `set-row set-${s.type}`;

  const name = document.createElement("span");
  name.className = "set-name";
  name.textContent = s.label;
  if (s.inert) name.append(Object.assign(document.createElement("span"),
    { className: "set-inert", textContent: "not wired" }));
  if (s.help) {
    const h = document.createElement("span");
    h.className = "set-help";
    h.textContent = s.help;
    name.append(h);
  }

  let input;
  if (s.type === "choice") {
    input = document.createElement("select");
    input.replaceChildren(...s.choices.map((c) => {
      const o = document.createElement("option");
      o.value = c.value; o.textContent = c.label;
      return o;
    }));
    input.value = value ?? s.default;
  } else if (s.type === "bool") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!value;
  } else {
    input = document.createElement("input");
    input.type = s.type === "number" ? "number" : "text";
    if (s.type === "number") input.step = "any";
    input.value = value ?? s.default ?? "";
  }
  input.dataset.setKey = s.key;
  input.dataset.setType = s.type;

  // Checkbox reads left-to-right; everything else is label-then-control.
  if (s.type === "bool") wrap.append(input, name);
  else wrap.append(name, input);
  return wrap;
}

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {};
  for (const el of $("settings-body").querySelectorAll("[data-set-key]")) {
    payload[el.dataset.setKey] =
      el.dataset.setType === "bool" ? el.checked
      : el.dataset.setType === "number" ? (el.value === "" ? null : Number(el.value))
      : el.value;
  }
  try {
    const res = await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
    $("settings-status").textContent =
      res.changed.length ? `Applied ${res.changed.length} change${res.changed.length > 1 ? "s" : ""}.`
                         : "No changes.";
    await paintFetcherStatus();
    // Markets may have been toggled, which changes what "All markets" means.
    SITES = await api("/api/sites").catch(() => SITES);
  } catch (err) {
    $("settings-err").textContent = err.message;
    $("settings-err").hidden = false;
  }
});

// Show what the transport is actually doing, so the fingerprint settings are
// verifiable rather than taken on faith.
async function paintFetcherStatus() {
  const h = await api("/api/health").catch(() => null);
  if (!h) return;
  const tls = h.http.impersonates_tls;
  const rows = Object.entries(h.fetchers || {})
    .map(([k, v]) => `${k}: ${v.tls_target} · ${v.min_interval}–${v.max_interval ?? "fixed"}s`)
    .join(" · ");
  $("settings-status").innerHTML =
    `<span class="${tls ? "ok" : "bad"}">${tls ? "✓" : "✗"} TLS/HTTP2 impersonation via ${esc(h.http.backend)}</span>` +
    (rows ? `<br><span class="dim">${esc(rows)}</span>` : "");
}

// ----- item panel -----
// Opens on any click that is not a link or a button. Shows what the search
// already returned immediately; the listing's own page (description, photos,
// specs) is fetched only when asked, since that is a request per item.

const itemDlg = $("item-dlg");
let CURRENT_ITEM = null;

$("item-close").addEventListener("click", () => itemDlg.close());

function openItem(item, marks = {}) {
  CURRENT_ITEM = item;
  $("item-title").textContent = item.title;
  $("item-open").href = item.url;
  $("item-open").textContent = `OPEN ON ${siteLabel(item.site).toUpperCase()} ↗`;

  const price = item.price != null ? money(item.price, item.currency)
                                   : (item.price_text || "—");
  const was = marks.was != null
    ? `<span class="was">${money(marks.was, item.currency)}</span>` : "";
  $("item-price").innerHTML = `${esc(price)}${was}`;

  const chips = [];
  chips.push(`<span class="chip site">${esc(siteLabel(item.site))}</span>`);
  if (marks.blocked) chips.push('<span class="chip blocked">BLOCKED</span>');
  if (marks.isNew) chips.push('<span class="chip new">NEW</span>');
  if (item.condition) chips.push(`<span class="chip cond">${esc(item.condition)}</span>`);
  if (item.extra?.best_offer) chips.push('<span class="chip offer">OBO</span>');
  $("item-chips").innerHTML = chips.join("");

  $("item-img").src = item.image || "";
  $("item-img").hidden = !item.image;
  $("item-thumbs").replaceChildren();

  renderFacts(facts(item));

  $("item-desc-wrap").hidden = true;
  $("item-desc").textContent = "";
  $("item-detail-msg").textContent = "";

  const site = siteByKey(item.site);
  const canDetail = !!site?.supports?.detail;
  $("item-detail").hidden = !canDetail;
  $("item-detail").disabled = false;
  $("item-detail").textContent = "LOAD FULL DETAILS";

  paintBlockButton(item, marks);
  itemDlg.showModal();
}

// Only what this listing actually has — an empty row is worse than no row.
function facts(item) {
  return [
    ["Seller", item.seller || item.seller_name],
    ["Location", item.location],
    ["Shipping", item.shipping],
    ["Posted", item.posted_at],
    ["Was", item.extra?.was_price],
    ["Market", siteLabel(item.site)],
  ].filter(([, v]) => v);
}

function renderFacts(rows) {
  const dl = $("item-facts");
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
}

// The block button is only useful inside a saved search (nowhere to store it
// otherwise) and only on markets that expose a seller.
function paintBlockButton(item, marks = {}) {
  const btn = $("item-block");
  const site = siteByKey(item.site);
  const usable = currentSearch && item.seller_name &&
                 site?.supports?.seller !== false;
  btn.hidden = !usable;
  if (!usable) return;
  const blocked = !!marks.blocked;
  btn.textContent = blocked
    ? `UNBLOCK ${item.seller_name} ON ${siteLabel(item.site).toUpperCase()}`
    : `BLOCK ${item.seller_name} ON ${siteLabel(item.site).toUpperCase()}`;
  btn.classList.toggle("danger", !blocked);
  btn.onclick = async () => {
    itemDlg.close();
    await blockSeller(item.seller_name, item.site, { unblock: blocked });
  };
}

$("item-detail").addEventListener("click", async () => {
  if (!CURRENT_ITEM) return;
  const btn = $("item-detail");
  btn.disabled = true;
  btn.textContent = "LOADING…";
  $("item-detail-msg").textContent = "fetching the listing page…";
  try {
    const d = await api("/api/detail", {
      method: "POST",
      body: JSON.stringify({ site: CURRENT_ITEM.site, url: CURRENT_ITEM.url }),
    });
    if (d.description) {
      $("item-desc").textContent = d.description;
      $("item-desc-wrap").hidden = false;
    }
    if (d.specs) renderFacts([...facts(CURRENT_ITEM), ...Object.entries(d.specs)]);
    if (d.photos?.length) {
      $("item-img").src = d.photos[0];
      $("item-img").hidden = false;
      $("item-thumbs").replaceChildren(...d.photos.slice(0, 8).map((src) => {
        const t = document.createElement("img");
        t.src = src;
        t.loading = "lazy";
        t.addEventListener("click", () => { $("item-img").src = src; });
        return t;
      }));
    }
    const got = ["description", "specs", "photos"].filter((k) => d[k]);
    $("item-detail-msg").textContent = got.length ? `Loaded ${got.join(", ")}.`
                                                  : "That page had nothing extra.";
    btn.textContent = "RELOAD DETAILS";
  } catch (err) {
    $("item-detail-msg").textContent = err.message;
    btn.textContent = "LOAD FULL DETAILS";
  } finally {
    btn.disabled = false;
  }
});
