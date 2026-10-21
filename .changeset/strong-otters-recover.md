---
'@defuse-protocol/nearintents-mpp-sdk': minor
---

Implement draft-nearintents-charge-01 (tempoxyz/mpp-specs#299): payer-resolved
refund addresses bound into the challenge and pinned by the client
(`policy.expectedRefundTo`); the presented hash is matched against the observed
origin-chain transactions on every terminal outcome before the quote is retired
or the hash consumed; chain-canonical hash comparison for replay keys; and
validation of the numeric charge options.
