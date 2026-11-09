---
'@defuse-protocol/nearintents-mpp-sdk': patch
---

Map more 1Click tokens to CAIP-19. Tron (`tron:728126428`) and Aptos
(`aptos:1`) are now built-in networks, and TRX, APT and STRK have native coin
types. TON now renders as the registered `tvm:-239`; `ton:-239` is still
accepted as input. Asset references are percent-encoded when rendered and
decoded when matched, so Sui (`::`) and TON or NEAR (`_`) tokens produce
schema-valid ids; the new `Types.encodeAssetReference` and
`Types.decodeAssetReference` helpers expose this. The built-in EVM broadcast
pays the decoded token reference. Tron and Aptos transaction hashes now match
and key the replay store case-insensitively, ignoring an optional `0x` prefix.
