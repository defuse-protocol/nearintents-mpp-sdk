---
'@defuse-protocol/nearintents-mpp-sdk': patch
---

Fixed the client paying a deposit address twice. After a refund or a short
deposit, the server's retry challenge can still name the spent quote, and
mppx's fetch paid it again. A client method instance now pays each deposit
address (and memo) at most once and re-presents the first deposit's hash, which
also lets a retry after a 1Click outage settle without a new deposit.
