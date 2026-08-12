// A tiny event bus, for the places where components must reach each other
// without importing each other.
//
// The cycles it avoids are real: the task list opens the detail editor, the
// editor patches a task, patching reloads data, and reloading re-renders the
// list. Direct imports would make list → detail → data → list, which ES modules
// resolve to undefined at call time. Events keep the graph a tree.
//
// Events:
//   data:changed   tasks/categories/tags were reloaded from the server
//   view:changed   the list/calendar switch, or a filter, moved

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
    try { fn(payload); }
    catch (err) { console.error(`[bus] ${event} handler failed`, err); }
  }
}
