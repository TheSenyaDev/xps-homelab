// Entry point: tab router + global month selector + import button.
import { api } from "./api.js";
import { el, monthLabel, toast } from "./dom.js";
import { loadCategories, loadMonths, state } from "./state.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderTransactions } from "./views/transactions.js";
import { renderManage } from "./views/categories.js";
import { renderTrends } from "./views/trends.js";
import { renderRecurring } from "./views/recurring.js";

const VIEWS = {
  dashboard: renderDashboard,
  trends: renderTrends,
  recurring: renderRecurring,
  transactions: renderTransactions,
  categories: renderManage,
};

// Views that pick their own period; the global month selector doesn't apply.
const MONTHLESS = new Set(["trends", "recurring"]);
let current = "dashboard";
const root = () => document.getElementById("content");

function goTo(view, params = {}) {
  if (!VIEWS[view]) return;
  current = view;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  // Hide the month picker where it would do nothing, rather than leave a control
  // that looks live but changes none of what's on screen.
  document.querySelector(".month-pick")?.classList.toggle("hidden", MONTHLESS.has(view));
  Promise.resolve(VIEWS[view](root(), { goTo, params })).catch((e) => {
    console.error(e);
    root().replaceChildren(el("div", { class: "empty", text: "Something went wrong loading this view." }));
  });
}

function buildMonthSelect() {
  const sel = document.getElementById("month-select");
  sel.replaceChildren(...state.months.map((m) => el("option", { value: m, text: monthLabel(m) })));
  if (!state.months.length) sel.append(el("option", { text: "—" }));
  if (state.month) sel.value = state.month;
  sel.onchange = () => { state.month = sel.value; goTo(current); };
}

async function doImport() {
  const btn = document.getElementById("import-btn");
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Importing…";
  try {
    const r = await api.post("/api/import");
    toast(`Imported: ${r.inserted} new, ${r.skipped} existing`);
    await Promise.all([loadMonths(), loadCategories()]);
    buildMonthSelect();
    goTo(current);
  } catch {
    toast("Import failed — check the SMB mount");
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

async function init() {
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => goTo(t.dataset.view)));
  document.getElementById("import-btn").addEventListener("click", doImport);
  await Promise.all([loadCategories(), loadMonths()]);
  buildMonthSelect();
  goTo("dashboard");
}

init();
