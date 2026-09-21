---
'@defuse-protocol/nearintents-mpp-sdk': minor
---

Adopt mppx 0.10.1: bump the exact dev and peer dependency pin from 0.8.19.
This crosses two upstream breaking minors — 0.9.0 (removed machineUSD flows,
unused by this method) and 0.10.0 (recipient-allowlist enforcement in mppx's
built-in methods, not applicable here) — with no code changes; the full suite
passes against 0.10.1. Fixes fresh installs alongside the latest mppx failing
on a peer conflict. Consumers must upgrade mppx to 0.10.1.
