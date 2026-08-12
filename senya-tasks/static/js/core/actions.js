// Mutations: everything that changes server state and then refreshes.
//
// Separate from state.js because state is a leaf (it only reads), while an
// action reloads and announces — importing the bus from state.js would drag
// every reader of state into the event graph.

import { api } from "./api.js";
import { emit } from "./bus.js";
import { load } from "./state.js";

/** Re-read everything, then tell the views. */
export async function reload() {
  await load();
  emit("data:changed");
}

/** Patch one task and refresh. The single write path, so nothing can update a
 *  task without the list finding out. */
export async function patchTask(id, body) {
  await api.patch(`/api/tasks/${id}`, body);
  await reload();
}

export async function deleteTask(id) {
  await api.del(`/api/tasks/${id}`);
  await reload();
}
