---
name: homelab-tasks
description: Work from the homelab TODO list in SenyaTasks. Use when the user asks what is outstanding, says "work on <task>" or "what should I do next", refers to a task by number or name, or finishes work that should be marked done. Also use before starting any homelab change, to check whether a task already describes it.
---

# Homelab tasks

The instructions live in [AGENTS.md](../../../AGENTS.md), at the repository
root — tool-agnostic, so the same rules apply whichever assistant is running.
**Read that file now**, and follow it.

This file exists only so Claude Code discovers the skill. Do not add guidance
here: two copies drift, and the wrong one is always the one being read.

Quick reference (the detail, and the reasoning, are in AGENTS.md):

```bash
python3 tools/tasks.py list            # open homelab tasks
python3 tools/tasks.py show <id>       # notes + subtasks
python3 tools/tasks.py done <id>       # only after verifying
```
