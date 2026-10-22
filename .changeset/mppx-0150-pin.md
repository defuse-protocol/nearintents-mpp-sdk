---
'@defuse-protocol/nearintents-mpp-sdk': minor
---

Adopt mppx 0.15.0: bump the exact dev and peer dependency pin from 0.10.1,
and raise the `zod` dependency to `^4.6.7` so it dedupes with mppx's own zod
(two copies broke declaration emit). The intervening upstream minors
(0.11–0.15) change Tempo/EVM built-ins and standalone credential APIs that
this method does not use; no code changes. Consumers must upgrade mppx to
0.15.0, which itself requires viem >= 2.57.1.
