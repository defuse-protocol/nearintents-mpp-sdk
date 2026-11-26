---
'@defuse-protocol/nearintents-mpp-sdk': patch
---

The server refuses a 1Click `SUCCESS` without swap evidence (an output amount
and an intent hash) with `payment-insufficient` instead of delivering the
resource, takes the receipt `reference` from the destination-chain hash or else
the NEAR intent hash, and no longer reuses a cached quote past the deadline it
requested from 1Click. The built-in EVM broadcast refuses a deposit address or
token that is not a 20-byte address, an asset other than an erc20 token or a
native coin, and an amount that does not fit in a uint256. 1Click 429, 408 and
unparseable success responses count as temporary outages.
