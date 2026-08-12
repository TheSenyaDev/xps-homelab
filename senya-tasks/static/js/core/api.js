// The only place that talks to the backend.
//
// Errors arrive as {error: "..."} with a non-2xx status; this turns them into
// thrown Errors carrying that message, so callers can try/catch and show
// err.message rather than each re-deriving what went wrong.

async function send(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.status === 204 ? null : r.json();
}

export const api = {
  send,
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  // Named wrappers, because api.post is what anyone reaches for first and a
  // missing one fails as "api.post is not a function" — a click that silently
  // does nothing, with the error only in the console.
  post: (url, body) => send("POST", url, body),
  put: (url, body) => send("PUT", url, body),
  patch: (url, body) => send("PATCH", url, body),
  del: (url) => send("DELETE", url),
};
