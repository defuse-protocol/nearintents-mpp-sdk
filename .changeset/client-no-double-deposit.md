---
'@defuse-protocol/nearintents-mpp-sdk': patch
---

Fixed the client paying a deposit address twice. After a refund or a short
deposit, the server's retry challenge can still name the spent quote, and
mppx's fetch paid it again. A client method instance now pays each deposit
address (and memo) at most once per payer and re-presents the first deposit's
hash, including after a broadcast whose confirmation wait failed, and the
built-in EVM broadcast presents the hash of the transaction that was mined.
This holds within one method instance, so keep one per payer session; a retry
after a 1Click outage then settles without a new deposit while the server
still offers that quote. A deposit is forgotten 24 hours after the latest
`expires` of a challenge for it, so a long-lived client's memory stays bounded.
