# livesync-bridge — a headless replicator (by the Self-hosted LiveSync author)
# that speaks LiveSync's chunk + E2E format and mirrors the CouchDB vault to a
# plain folder of .md files (and pushes file edits back up). We clone upstream at
# build time rather than vendoring its whole source tree. The config.json is
# generated on boot from environment variables (see render-config.ts), so no
# secrets are baked into the image or committed to git.
FROM denoland/deno:2.3.1

# Pin to a ref for reproducible builds; override with --build-arg BRIDGE_REF=<sha>.
ARG BRIDGE_REF=main

WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git clone --depth 1 --recurse-submodules --shallow-submodules --branch "${BRIDGE_REF}" https://github.com/vrtmrz/livesync-bridge.git /app \
 && deno install --allow-import
# Local dep install populates node_modules for byonm (nodeModulesDir: manual).
# Notes on the flags vs. the upstream Dockerfile's stale `deno install -A`:
#  - `-A` is rejected in Deno 2.x: permission flags are valid only for *global* installs.
#  - `--allow-import` is required because one dep (trystero) is imported from
#    github.com, which isn't in Deno's default import allowlist.

# Our additions: config generator + entrypoint (copied after the clone so they
# don't collide with git's empty-dir requirement).
COPY render-config.ts /app/render-config.ts
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# State + decoded output files live under /app/data (bind-mounted from the host).
ENTRYPOINT ["/app/entrypoint.sh"]
