// Display settings: how many completed tasks stay visible.

import { api } from "../core/api.js";
import { emit } from "../core/bus.js";
import { $ } from "../core/dom.js";
import { getCompletedShown, setCompletedShown } from "../core/state.js";

export function init() {
  $("btn-prefs").onclick = openPrefs;
  $("prefs-close").onclick = $("prefs-cancel").onclick =
    () => { $("prefs-modal").hidden = true; };
  $("prefs-save").onclick = savePrefs;
}

function openPrefs() {
  document.getElementById("prefs-shown").value = completedShown;
  document.getElementById("prefs-modal").hidden = false;
}

async function savePrefs() {
  const value = Number(document.getElementById("prefs-shown").value);
  try {
    const res = await api.put("/api/settings", { completed_shown: value });
    completedShown = res.values.completed_shown;
    document.getElementById("prefs-modal").hidden = true;
    emit("view:changed");
  } catch (err) {
    document.getElementById("prefs-err").textContent = err.message;
    document.getElementById("prefs-err").hidden = false;
  }
}
