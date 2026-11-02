---
name: status
version: 0.4.2
description: Check the health of a running service from the command line. Use when the user asks whether a service is up, what its current status is, or wants a quick health summary.
requires:
  bins: ["statusctl"]
  auth: true
---

# Status CLI Usage Guide

Help users check service health from the command line using the `statusctl` CLI.

## Key commands

- `statusctl check <service>` — print current health
- `statusctl check <service> --json` — machine-readable output
- `statusctl history <service> --period 24h` — recent health history
