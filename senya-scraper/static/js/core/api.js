// The only place that talks to the backend.
//
// Errors arrive as {error: "..."} with a non-2xx status; this turns them into
// thrown Errors carrying that message, so every caller can just try/catch and
// show err.message rather than each one re-deriving what went wrong.

async function request(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const get = (url) => request(url);
const post = (url, body) => request(url, { method: "POST", body: JSON.stringify(body) });
const patch = (url, body) => request(url, { method: "PATCH", body: JSON.stringify(body) });
const put = (url, body) => request(url, { method: "PUT", body: JSON.stringify(body) });
const del = (url) => request(url, { method: "DELETE" });

export const api = {
  sites: () => get("/api/sites"),
  health: () => get("/api/health"),

  search: (payload) => post("/api/search", payload),
  detail: (site, url) => post("/api/detail", { site, url }),

  searches: {
    list: () => get("/api/searches"),
    create: (payload) => post("/api/searches", payload),
    update: (id, payload) => patch(`/api/searches/${id}`, payload),
    remove: (id) => del(`/api/searches/${id}`),
    run: (id) => post(`/api/searches/${id}/run`, {}),
    block: (id, seller, site, unblock = false) =>
      post(`/api/searches/${id}/block`, { seller, site, unblock }),
  },

  settings: {
    read: () => get("/api/settings"),
    write: (values) => put("/api/settings", values),
  },
};
