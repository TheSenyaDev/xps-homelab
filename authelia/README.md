# Authelia + Traefik — authentication for the senya homelab

Single sign-on / login protection for services you expose through the Cloudflare
tunnel. Auth is **per-service and opt-in**: a service is only protected if you
attach the Authelia middleware to its route. Everything else is served openly.

---

## How it works

```
            ┌────────────────┐   public hostname (*.senya.ca)
 Internet ─▶│  Cloudflare     │   TLS terminates here; sets X-Forwarded-Proto:https
            │  edge + tunnel  │
            └───────┬─────────┘
                    │ http://traefik:80  (private docker network)
            ┌───────▼─────────┐
            │     Traefik     │  routes by Host header (traefik/dynamic/routes.yml)
            └───┬─────────┬───┘
   has authelia │         │ no middleware
   middleware?  │         │
        ┌───────▼──┐   ┌──▼────────┐
        │ Authelia │   │  service  │  ← served directly, no auth
        │ forward- │   └───────────┘
        │  auth    │
        └────┬─────┘
   allow ✓ / │ deny → 302 to https://auth.senya.ca (login portal)
   inject    ▼
   Remote-* headers, request continues to the service
```

1. **Cloudflare** terminates HTTPS at the edge and forwards the request through
   the tunnel to **Traefik** over the private docker network. It sets
   `X-Forwarded-Proto: https`, which Traefik is configured to trust
   (`forwardedHeaders.insecure: true` on the `web` entrypoint) — this is what
   lets Authelia build correct `https://` redirects.
2. **Traefik** matches the `Host` header to a router in
   [`traefik/dynamic/routes.yml`](../traefik/dynamic/routes.yml).
3. If that router lists the `authelia@file` **middleware**, Traefik first asks
   Authelia (`/api/authz/forward-auth`) *"is this request allowed?"*
   - **Not logged in** → Authelia replies `302` → browser goes to the login
     portal at `auth.senya.ca`, logs in, comes back.
   - **Logged in** → Authelia replies `200` and adds `Remote-User`,
     `Remote-Email`, `Remote-Groups`, `Remote-Name` headers; Traefik then proxies
     the request to the real service.
4. If the router has **no** middleware, Traefik proxies straight to the service —
   Authelia is never consulted. That is the per-service on/off switch.

**Why file-based routing (not docker labels):** Traefik reads routes from
`routes.yml` instead of the docker socket, so it doesn't need
`/var/run/docker.sock` mounted. Socket access is effectively root on the host, so
not granting it removes a serious attack surface — worthwhile for something that
faces the internet.

### Pieces

| Component | Where | Role |
|-----------|-------|------|
| Traefik | `traefik/` + compose `traefik` | Reverse proxy / router, enforces the middleware |
| Authelia | `authelia/` + compose `authelia` | Login portal + forward-auth decision engine |
| whoami | compose `whoami` | Throwaway demo service proving the chain works |
| Routes | `traefik/dynamic/routes.yml` | **The file you edit to expose/protect a service** |
| Middleware | `traefik/dynamic/middlewares.yml` | Defines `authelia@file` |
| Users | `authelia/users_database.yml` | Accounts (argon2 password hashes) |
| Policy | `authelia/configuration.yml` | Access rules, sessions, regulation |
| Secrets | root `.env` (`AUTHELIA_*`) | Session secret, storage key, reset-JWT |

---

## First-time setup checklist

The stack is already running. To actually use it over the internet:

1. **Change the default password.** The seeded account is **`admin` / `authelia`**
   — change it before exposing anything (see *Manage users* below).
2. **DNS:** in Cloudflare, make sure `*.senya.ca` (or each subdomain you use,
   e.g. `auth`, `whoami`) resolves to the tunnel. A wildcard CNAME to the tunnel
   is easiest.
3. **Tunnel hostnames:** in the Cloudflare Zero Trust dashboard
   (Networks → Tunnels → your tunnel → Public Hostnames) add:
   - `auth.senya.ca` → `http://traefik:80`
   - `whoami.senya.ca` → `http://traefik:80`
   (Your tunnel runs in *token* mode, so hostnames live in the dashboard, not in
   `cloudflared/config.yml`. That file is kept as a template — see its header.)
4. Visit `https://whoami.senya.ca` → you should be bounced to `auth.senya.ca`,
   log in, and land back on whoami.
5. Once happy, **delete the demo**: remove the `whoami` service from
   `docker-compose.yaml` and its `whoami` router/service from `routes.yml`.

---

## Expose / protect a service

Everything is two edits + a dashboard entry.

**1. Add a route** in [`traefik/dynamic/routes.yml`](../traefik/dynamic/routes.yml)
(changes are picked up live — no restart):

```yaml
http:
  routers:
    grafana:
      rule: 'Host(`grafana.senya.ca`)'
      entryPoints: ['web']
      service: 'grafana'
      middlewares: ['authelia@file']   # ← PROTECTED. Delete this line to make it open.
  services:
    grafana:
      loadBalancer:
        servers:
          - url: 'http://grafana:3000'   # container name + internal port
```

**2. Add the public hostname** in the Cloudflare dashboard:
`grafana.senya.ca` → `http://traefik:80`.

That's it. To **toggle auth** on an existing service, just add or remove the
`middlewares: ['authelia@file']` line.

> Internal ports are the *container* ports, not the host-published ones. E.g.
> Grafana publishes `3002:3000`, so inside the network it's `http://grafana:3000`.

---

## Manage users

Passwords are stored as argon2id hashes in
[`authelia/users_database.yml`](users_database.yml).

Generate a hash:

```bash
docker run --rm authelia/authelia:4.38 \
  authelia crypto hash generate argon2 --password 'your-new-password'
```

Copy the `Digest:` value into the user's `password:` field, then:

```bash
docker compose restart authelia
```

Add more users by copying the `admin:` block under `users:` and giving them a new
key, display name, email, and `groups`.

---

## Access control rules

Defined in [`configuration.yml`](configuration.yml) under `access_control`.
Default is `deny`; the portal is `bypass`; everything else behind the middleware
is `one_factor` (username + password). Examples:

```yaml
access_control:
  default_policy: 'deny'
  rules:
    - domain: 'auth.senya.ca'
      policy: 'bypass'
    - domain: 'firefly.senya.ca'      # require 2FA for the finance app
      policy: 'two_factor'
    - domain: 'grafana.senya.ca'
      policy: 'one_factor'
      subject: ['group:admins']        # only members of the admins group
    - domain: '*.senya.ca'
      policy: 'one_factor'
```

Restart Authelia after editing: `docker compose restart authelia`.

## Enable two-factor (TOTP)

1. Set a rule (or `default_policy`) to `two_factor`.
2. Log in, go to the portal's settings, register an authenticator app.
3. The registration/reset link is delivered via the **filesystem notifier** (no
   SMTP configured) — read it with:
   ```bash
   docker exec authelia cat /config/notification.txt
   ```
   Switch the `notifier:` block to `smtp:` if you'd rather get real emails.

---

## Secrets

Three secrets live in the root `.env` (git-ignored) and are injected as env vars:

| Variable | Maps to |
|----------|---------|
| `AUTHELIA_SESSION_SECRET` | `session.secret` (signs session cookies) |
| `AUTHELIA_STORAGE_ENCRYPTION_KEY` | `storage.encryption_key` (encrypts TOTP secrets at rest) |
| `AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET` | password-reset JWT signing |

Regenerate any of them with `openssl rand -hex 64`. Changing the storage key
invalidates stored TOTP secrets; changing the session secret logs everyone out.

---

## Operate & troubleshoot

```bash
docker compose logs -f authelia      # auth decisions / errors
docker compose logs -f traefik       # routing
# Traefik dashboard (LAN/Tailscale only): http://<host>:8096
# Local proxy entrypoint for testing:    http://<host>:8095
```

Test the chain locally without DNS (simulate the HTTPS edge):

```bash
# Unauthenticated → 302 to the portal
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" \
  -H 'X-Forwarded-Proto: https' \
  --resolve whoami.senya.ca:8095:127.0.0.1 http://whoami.senya.ca:8095/
```

**Common issues**

- **`Target URL ... has an insecure scheme 'http'`** — the request reached
  Authelia as `http`. Real traffic via Cloudflare is fine (edge sets
  `X-Forwarded-Proto: https`); you only see this when testing locally without the
  header, or if you removed `forwardedHeaders.insecure` from the `web` entrypoint.
- **Redirect loop / cookie not sticking** — the service's subdomain must be under
  `senya.ca` (the session cookie is scoped to that parent domain). A service on a
  different apex won't share the session.
- **502 from Traefik** — the `services:` URL is wrong; use the *container* name
  and its *internal* port, and make sure that container is on `homelab_default`.
- **404 from Traefik** — no router matched the `Host`; check the `rule` and that
  the Cloudflare hostname points at `http://traefik:80`.

---

## Security notes

- Traefik has **no docker socket** access (file-based routing) — minimal blast
  radius for the internet-facing proxy.
- The Traefik dashboard (`:8096`) and local entrypoint (`:8095`) are published to
  the LAN/Tailscale only and are never given a Cloudflare public hostname.
- `default_policy: deny` means a misconfigured route fails closed (no access)
  rather than open.
- Brute-force is throttled by the `regulation` block (ban after repeated fails).
- **Change the seeded `admin/authelia` password** and consider `two_factor` for
  anything sensitive before going public.
