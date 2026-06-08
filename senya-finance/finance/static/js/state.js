// Shared app state + loaders. Views read from here so categories/months are
// fetched once and reused; call the loaders to refresh after mutations.
import { api } from "./api.js";

export const state = {
  month: null,      // selected YYYY-MM
  months: [],       // available months, desc
  categories: [],   // all categories
};

export async function loadCategories() {
  state.categories = await api.get("/api/categories");
  return state.categories;
}

export async function loadMonths() {
  state.months = await api.get("/api/summary/months");
  if (!state.month || !state.months.includes(state.month)) {
    state.month = state.months[0] || null;
  }
  return state.months;
}

export const categoryById = (id) => state.categories.find((c) => c.id === Number(id)) || null;
