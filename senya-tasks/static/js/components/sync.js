// CalDAV sync: the status chip and the settings dialog.
//
// Test before saving, so a wrong URL or password is named here rather than
// discovered as silence hours later.

import { api } from "../core/api.js";
import { reload } from "../core/actions.js";
import { on } from "../core/bus.js";
import { $, el } from "../core/dom.js";
import { relTime } from "../core/format.js";
import { getCategories } from "../core/state.js";

let categories = [];
on("data:changed", () => { categories = getCategories(); });

const syncModal = $("sync-modal");
let syncStatus = null;


// The chip is the at-a-glance confirmation: it only appears once sync is
// configured, and says plainly whether it's on and when it last ran.
function renderSyncChip() {
  const chip = $("sync-chip");
  if (!syncStatus || !syncStatus.configured) { chip.hidden = true; return; }
  chip.hidden = false;
  if (!syncStatus.enabled) {
    chip.textContent = "⇄ paused";
    chip.className = "ghost-btn sync-chip paused";
    chip.title = "CalDAV sync is configured but switched off";
    return;
  }
  const stale = syncStatus.last_sync &&
    (Date.now() - new Date(syncStatus.last_sync).getTime()) / 1000 > syncStatus.interval * 3;
  chip.textContent = `⇄ ${relTime(syncStatus.last_sync)}`;
  chip.className = "ghost-btn sync-chip" + (stale ? " stale" : " ok");
  chip.title = `CalDAV sync · ${syncStatus.mapped} tasks linked`
    + (syncStatus.last_result ? `\nlast run: ${syncStatus.last_result}` : "")
    + (stale ? "\n\nOverdue — the last pass may have failed." : "");
}

async function refreshSyncStatus() {
  try {
    syncStatus = await api.get("/api/caldav");
    renderSyncChip();
    if (!syncModal.hidden) fillSyncForm();
  } catch { /* status is cosmetic; never break the page over it */ }
}

function syncModeChanged() {
  const per = $("sync-mode").value === "per-category";
  // The URL means different things in the two modes, so say which is wanted
  // rather than letting a plausible-looking wrong URL fail confusingly later.
  $("sync-url-label").textContent = per ? "Calendar home" : "Calendar URL";
  $("sync-url").placeholder = per
    ? "http://192.168.2.100:5232/dav.php/calendars/Senya/"
    : "http://192.168.2.100:5232/dav.php/calendars/Senya/default/";
  $("sync-mode-hint").textContent = per
    ? "One Reminders list per category, created and named for you. Nested categories "
      + "flatten — CalDAV lists have no hierarchy. Point this at the folder that holds "
      + "your calendars, not at one calendar."
    : "Every task in a single list. Categories stay a senya-tasks concept.";
  renderSyncCollections();
}

function renderSyncCollections() {
  const box = $("sync-collections");
  const per = $("sync-mode").value === "per-category";
  const cols = (syncStatus && syncStatus.collections) || [];
  if (!per || !cols.length) { box.replaceChildren(); return; }
  box.replaceChildren(
    el("div", { class: "sync-collections-head", text: "lists in use" }),
    ...cols.map((c) => el("div", { class: "sync-collection" },
      el("span", { class: "sync-collection-name", text: c.display }),
      el("span", { class: "sync-collection-href", text: c.href.split("/").filter(Boolean).pop() }))));
}

function fillSyncForm() {
  const s = syncStatus || {};
  $("sync-mode").value = s.mode || "single";
  $("sync-url").value = s.url || "";
  $("sync-user").value = s.user || "";
  $("sync-auth").value = s.auth || "auto";
  $("sync-interval").value = s.interval || 120;
  $("sync-enabled").checked = !!s.enabled;
  $("sync-password").placeholder = s.password_set
    ? "leave blank to keep the saved one" : "required";
  $("sync-state").textContent = s.enabled ? "on" : s.configured ? "paused" : "not configured";
  syncModeChanged();
  $("sync-stats").textContent = s.configured
    ? `${s.mapped} tasks linked · last sync ${relTime(s.last_sync)}`
      + (s.pending_deletes ? ` · ${s.pending_deletes} deletions pending` : "")
      + (s.auth_scheme ? ` · ${s.auth_scheme} auth` : "")
    : "";
}

const syncFormValues = () => ({
  mode: $("sync-mode").value,
  url: $("sync-url").value.trim(),
  user: $("sync-user").value.trim(),
  password: $("sync-password").value,
  auth: $("sync-auth").value,
  interval: Number($("sync-interval").value) || 120,
  enabled: $("sync-enabled").checked,
});

function showSyncResult(ok, message, detail) {
  const box = $("sync-result");
  box.hidden = false;
  box.className = "sync-result " + (ok ? "ok" : "bad");
  // replaceChildren() stringifies null into a literal "null" text node, unlike
  // el()'s children — filter before handing it the list.
  box.replaceChildren(...[
    el("strong", { text: ok ? "✓ " : "✕ " }),
    el("span", { text: message }),
    detail ? el("div", { class: "sync-result-detail", text: detail }) : null,
  ].filter(Boolean));
}


export function init() {
  $("btn-sync-settings").onclick = async () => {
    await refreshSyncStatus();
    fillSyncForm();
    $("sync-result").hidden = true;
    syncModal.hidden = false;
    $("sync-url").focus();
  };
  $("sync-chip").onclick = () => $("btn-sync-settings").click();
  $("sync-mode").onchange = syncModeChanged;
  $("sync-close").onclick = () => { syncModal.hidden = true; };
  syncModal.onclick = (e) => { if (e.target === syncModal) syncModal.hidden = true; };

  $("sync-test").onclick = async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "Testing…";
    try {
      const r = await api.send("POST", "/api/caldav/test", syncFormValues());
      showSyncResult(r.ok, r.message,
        r.ok && r.components?.length ? `holds: ${r.components.join(", ")}` : null);
    } catch (err) {
      showSyncResult(false, err.message);
    }
    btn.disabled = false;
    btn.textContent = "Test connection";
  };

  $("sync-save").onclick = async (e) => {
    const btn = e.target;
    btn.disabled = true;
    try {
      syncStatus = await api.send("PUT", "/api/caldav/config", syncFormValues());
      $("sync-password").value = "";      // never keep it in the DOM
      fillSyncForm();
      renderSyncChip();
      showSyncResult(true, syncStatus.enabled
        ? "Saved. The first sync runs within a minute."
        : "Saved. Sync is switched off.");
    } catch (err) {
      showSyncResult(false, err.message);
    }
    btn.disabled = false;
  };

  $("sync-now").onclick = async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "Syncing…";
    try {
      const r = await api.send("POST", "/api/caldav/sync", {});
      const moved = ["pulled", "pushed", "deleted_remote", "deleted_local"]
        .map((k) => (r[k] ? `${r[k]} ${k.replace("_", " ")}` : null)).filter(Boolean);
      showSyncResult(!r.errors,
        moved.length ? `Synced — ${moved.join(", ")}` : "Synced — already up to date",
        [r.conflicts ? `${r.conflicts} conflict(s) resolved by newest-wins` : null,
         r.errors ? `${r.errors} error(s) — see container logs` : null]
          .filter(Boolean).join(" · ") || null);
      await refreshSyncStatus();
      await reload();
    } catch (err) {
      showSyncResult(false, err.message);
    }
    btn.disabled = false;
    btn.textContent = "Sync now";
  };

  refreshSyncStatus();
  setInterval(refreshSyncStatus, 30000);

}

export { renderSyncChip, refreshSyncStatus };
