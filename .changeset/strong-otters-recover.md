---
'@defuse-protocol/nearintents-mpp-sdk': minor
---

Implement draft-nearintents-charge-01 (tempoxyz/mpp-specs#299): payer-resolved
refund addresses bound into the challenge and pinned by the client
(`policy.expectedRefundTo`); the presented hash is matched against the observed
origin-chain transactions on every terminal outcome before the quote is retired
or the hash consumed; chain-canonical hash comparison for replay keys; and
validation of the numeric charge options.

Upgrade notes: replay-store hash keys now include the origin network
(`nearintents-mpp-sdk:hash:<caip2>:<canonical hash>`). Multi-instance
deployments must pause new payment traffic, drain in-flight settlements, replace
all instances, and then resume; do not run old and new versions together. A
settlement timeout after any observed status now returns 504 (`timeout`) instead
of the last 503 (`unavailable`).
