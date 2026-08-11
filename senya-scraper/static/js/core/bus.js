// A four-line event bus, for the handful of places where components must reach
// each other without importing each other.
//
// The cycles it breaks are real: a result card opens the item panel, the item
// panel blocks a seller, and blocking re-runs the saved search which re-renders
// the cards. Wiring those with direct imports makes results → item-panel →
// saved-list → results, which ES modules resolve to `undefined` at call time.
// Events keep the dependency graph a tree.
//
// Events:
//   item:open      {item, marks}        a result card was clicked
//   seller:block   {name, site, unblock}
//   saved:changed  —                    a profile was created/edited/deleted
//   sites:changed  —                    the enabled markets changed

const handlers = new Map();

export function on(event, fn) {
  if (!handlers.has(event)) handlers.set(event, []);
  handlers.get(event).push(fn);
  return () => off(event, fn);
}

export function off(event, fn) {
  const list = handlers.get(event) || [];
  const i = list.indexOf(fn);
  if (i >= 0) list.splice(i, 1);
}

export function emit(event, payload) {
  for (const fn of handlers.get(event) || []) {
    try {
      fn(payload);
    } catch (err) {
      // A broken listener must not stop the others, or one bug takes the whole
      // interaction down.
      console.error(`[bus] ${event} handler failed`, err);
    }
  }
}
