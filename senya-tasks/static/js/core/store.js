// localStorage, wrapped so a disabled/full store degrades to defaults rather
// than throwing on load. Small enough to be worth keeping across reloads:
// where you were, not what you have.

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`senya-tasks.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`senya-tasks.${key}`, JSON.stringify(value)); }
    catch { /* private mode, or full — a lost preference is not worth an error */ }
  },
};
