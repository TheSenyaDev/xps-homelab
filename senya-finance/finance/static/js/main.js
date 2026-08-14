// App shell: sidebar router, global month selector, theme, import.
import { api } from "./api.js";
import { el, monthLabel, toast } from "./dom.js";
import { loadCategories, loadMonths, state } from "./state.js";
import { initDrawer } from "./drawer.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderBudgets } from "./views/budgets.js";
import { renderTransactions } from "./views/transactions.js";
import { renderManage } from "./views/categories.js";
import { renderTrends } from "./views/trends.js";
import { renderRecurring } from "./views/recurring.js";
import { renderMerchants } from "./views/merchants.js";

const VIEWS = {
  dashboard: { title: "Dashboard", render: renderDashboard },
  budgets: { title: "Budgets", render: renderBudgets },
  trends: { title: "Trends", render: renderTrends },
  recurring: { title: "Subscriptions", render: renderRecurring },
  merchants: { title: "Merchants", render: renderMerchants },
  transactions: { title: "Transactions", render: renderTransactions },
  categories: { title: "Categories & Rules", render: renderManage },
};

// Views that pick their own period; the global month selector doesn't apply.
const MONTHLESS = new Set(["trends", "recurring", "merchants", "categories"]);
const THEME_KEY = "senya.finance.theme";

let current = "dashboard";
const root = () => document.getElementById("content");

function goTo(view, params = {}) {
  const v = VIEWS[view];
  if (!v) return;
  current = view;
  document.querySelectorAll(".nav-item").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  document.getElementById("view-title").textContent = v.title;
  document.getElementById("sidebar").classList.remove("open");
  // Hide the month picker where it would do nothing, rather than leave a control
  // that looks live but changes none of what's on screen.
  document.querySelector(".month-pick")?.classList.toggle("hidden", MONTHLESS.has(view));
  window.scrollTo({ top: 0 });

  Promise.resolve(v.render(root(), { goTo, params })).catch((e) => {
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

// ---- theme -----------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById("theme-ico").textContent = theme === "dark" ? "☾" : "☀";
  document.getElementById("theme-label").textContent = theme === "dark" ? "Dark" : "Light";
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* private mode */ }
  // No stored choice → follow the OS, so the first load already matches the rest
  // of the desktop instead of always starting dark.
  const preferred = saved
    || (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
  applyTheme(preferred);
  document.getElementById("theme-btn").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
}

// ---- import ----------------------------------------------------------------

async function doImport() {
  const btn = document.getElementById("import-btn");
  btn.disabled = true;
  const label = btn.querySelector(".ico").nextSibling;
  const original = label.textContent;
  label.textContent = "Importing…";
  try {
    const r = await api.post("/api/import");
    toast(r.inserted
      ? `Imported ${r.inserted} new transaction${r.inserted > 1 ? "s" : ""}`
      : `Nothing new — ${r.skipped} already imported`);
    await Promise.all([loadMonths(), loadCategories()]);
    buildMonthSelect();
    goTo(current);
  } catch {
    toast("Import failed — check the import mount");
  } finally {
    btn.disabled = false;
    label.textContent = original;
  }
}

async function init() {
  initTheme();
  initDrawer();
  document.querySelectorAll(".nav-item").forEach((t) =>
    t.addEventListener("click", () => goTo(t.dataset.view)));
  document.getElementById("import-btn").addEventListener("click", doImport);
  document.getElementById("menu-btn").addEventListener("click", () =>
    document.getElementById("sidebar").classList.toggle("open"));

  await Promise.all([loadCategories(), loadMonths()]);
  buildMonthSelect();
  goTo("dashboard");
}

init();
