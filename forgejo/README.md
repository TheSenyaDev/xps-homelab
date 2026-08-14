# Forgejo

Self-hosted git forge (the maintained Gitea fork) at **`:3030`**, with git over
SSH on **`:2222`**. It is the local origin for this repository and anything else
developed on the homelab, so pushing, branching and reviewing work does not
depend on GitHub being reachable.

```
laptop / XPS ──ssh :2222──► Forgejo ──► ./forgejo/data/git/repositories/…
             ──http :3030─►  (web UI, issues, PRs)
```

SQLite is used deliberately: this is a single-user forge, so a Postgres
container would be one more service to run and back up for no benefit. All
state — repositories, database, `app.ini` — lives under `./forgejo/data`, which
is gitignored.

## First run

```bash
docker compose up -d forgejo
```

Then open <http://192.168.2.100:3030> and complete the installer. Every field is
pre-filled from the environment in the root `docker-compose.yaml`; the only
thing to fill in is the **administrator account** at the bottom of the form
(expand *Administrator Account Settings* — if you skip it, the first person to
register becomes the admin, and registration is disabled here).

Do this immediately after the first start. Until the form is submitted the
instance is unclaimed, and anyone who can reach port 3030 can claim it.

After the installer:

- `DISABLE_REGISTRATION=true` — no one else can create an account.
- `REQUIRE_SIGNIN_VIEW=true` — an unauthenticated visitor sees a login page, not
  the repository list.

## Adding the homelab repo as a remote

Create the repository in the web UI first (**+ → New Repository**, named
`homelab`, empty — no README or licence, or the first push will conflict). Then
add an SSH key under **Settings → SSH / GPG Keys** and:

```bash
cd ~/code/homelab
git remote add forgejo ssh://git@192.168.2.100:2222/<user>/homelab.git
git push -u forgejo main
```

The `ssh://` form is required rather than the shorter `git@host:path` syntax,
because the latter has nowhere to put a port number.

To keep GitHub as well, leave `origin` alone and push to both by name, or add
Forgejo as a second URL on `origin`:

```bash
git remote set-url --add --push origin ssh://git@192.168.2.100:2222/<user>/homelab.git
```

## Backups

The whole instance is `./forgejo/data`. A file-level copy taken while the
container runs can catch SQLite mid-write, so either stop the container first or
use Forgejo's own dump, which is consistent:

```bash
docker compose exec -u git forgejo forgejo dump -c /data/gitea/conf/app.ini -f /data/dump.zip
```

This is worth folding into the nightly backup job (SenyaTasks #87) rather than
running by hand.

## Config

Everything is set through `FORGEJO__<section>__<KEY>` environment variables in
the root compose file, which Forgejo writes into `app.ini` on start. The ones
that matter:

| Variable | Value | Why |
|---|---|---|
| `FORGEJO__server__ROOT_URL` | `http://${SERVER_IP}:3030/` | Baked into clone URLs and mail links |
| `FORGEJO__server__SSH_DOMAIN` / `SSH_PORT` | `${SERVER_IP}` / `2222` | The clone URL the UI shows; 22 belongs to the host's sshd |
| `USER_UID` / `USER_GID` | `1000` | Files under `./forgejo/data` stay host-editable without sudo |
| `FORGEJO__service__DISABLE_REGISTRATION` | `true` | Single-user forge |
| `FORGEJO__service__REQUIRE_SIGNIN_VIEW` | `true` | Repo list is not public |

Editing `app.ini` by hand works too, but an environment variable wins on the
next restart — change it in compose, not in the file.

## Exposing it publicly

Not exposed today, and it should stay that way until it is behind Authelia: a
git forge holds every secret you ever committed by accident. If it does go out
through the Cloudflare tunnel, add a route in `traefik/dynamic/routes.yml` with
the `authelia@file` middleware, and note that the git-over-SSH port cannot go
through an HTTP tunnel — that side would need Tailscale.
