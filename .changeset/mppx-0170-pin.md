---
'@defuse-protocol/nearintents-mpp-sdk': minor
---

Adopt mppx 0.17.0: bump the exact dev and peer dependency pin from 0.15.0.
The intervening upstream minors (0.16 per-route identity, 0.17 payment-stage
identity) change APIs this method does not use; no code changes. Consumers
must upgrade mppx to 0.17.0.
