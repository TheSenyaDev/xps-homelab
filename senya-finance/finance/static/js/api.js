async function req(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.status === 204 ? null : res.json();
}

export const api = {
  get: (p) => req("GET", p),
  post: (p, b) => req("POST", p, b),
  patch: (p, b) => req("PATCH", p, b),
  del: (p) => req("DELETE", p),
};
