---
name: new-senya-app
description: Scaffold a new first-party senya-* app (Flask + SQLite + vanilla-JS, Docker Compose service, README, registered on the landing page). Use when the user asks to build a new senya app, start a new self-hosted tool "like senya-daily/tasks/etc", or add a first-party service to the homelab from scratch.
---

# New senya-* app

The instructions live in [AGENTS.md](../../../AGENTS.md), under
**"Scaffolding a new senya-* app"** — tool-agnostic, so the same rules apply
whichever assistant is running. **Read that section now**, and follow it.

This file exists only so Claude Code discovers the skill. Do not add guidance
here: two copies drift, and the wrong one is always the one being read.

Quick reference (the detail, and the reasoning, are in AGENTS.md):

- Copy `senya-daily/` (single-file app) or `senya-tasks/` (package layout) as
  the Dockerfile/compose starting point — don't invent a new shape.
- Register the finished app with the **add-senya-service** skill.
- Check `SenyaTasks` (`homelab-tasks` skill) first — the app being asked for
  may already be a backlog item with notes on what it should do.
