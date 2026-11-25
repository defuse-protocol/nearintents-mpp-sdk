---
'@defuse-protocol/nearintents-mpp-sdk': minor
---

Adopt mppx 0.22.0: bump the exact dev and peer dependency pin from 0.17.0.
The intervening upstream releases change identity, session, Tempo and x402
APIs this method does not use; Challenges now carry a stateless `_mpp_nonce`.
mppx 0.22.0 clients stop after an `invalid-challenge` answer instead of paying
the next Challenge, so after a refund the payer's next request settles on a
fresh quote. Consumers must upgrade mppx to 0.22.0, which requires viem
2.57.19 or later.
