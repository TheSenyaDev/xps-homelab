---
name: add-senya-service
description: Register a new or existing service (a senya-* app, or any container in docker-compose.yaml) on the Senya Landing launcher rail and in SERVICES.md. Use when the user asks to add something to the landing page, make a service show up on senya-landing, or after standing up a new container they want to reach from there.
---

# Add a service to Senya Landing

The instructions live in [senya-landing/README.md](../../../senya-landing/README.md),
under **"Add a service to the launcher rail"** — that file is the source of
truth for `services.js`'s shape, so read it there rather than here.

This file exists only so Claude Code discovers the skill. Do not add guidance
here: two copies drift, and the wrong one is always the one being read.

Quick reference (the detail is in senya-landing/README.md):

- One entry in `SENYA_APPS` (first-party) or `SERVICES` (everything else) in
  [`senya-landing/services.js`](../../../senya-landing/services.js):
  `{ name, port, icon, container, ext?, localIp?, tsIp? }`.
- `icon`: a filename (no `.png`) dropped into
  [`senya-landing/icons/`](../../../senya-landing/icons); missing → generic
  fallback, not a build error, but don't ship without one.
- `container`: the compose `container_name` — drives the live up/down dot via
  Glances. Omit only for things that aren't a local container.
- Also add a row to [`SERVICES.md`](../../../SERVICES.md).
- Rebuild and prove it served, don't just edit source — see AGENTS.md's
  "Verify" step: `docker compose up --build -d senya-landing`, then check the
  served `/services.js` and `/icons/<name>.png` came back, not just that the
  files exist on disk.
