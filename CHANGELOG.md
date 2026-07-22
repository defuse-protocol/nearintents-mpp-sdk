# @defuse-protocol/nearintents-mpp-sdk

## 0.1.0

### Minor Changes

- 06f7e8d: Initial release of the `nearintents` payment method for MPP (Machine Payments
  Protocol) — cross-chain HTTP 402 payments settled by the NEAR Intents 1Click
  API.

  - **Server method** (`nearintents.charge` from `/server`): each 402 challenge
    carries a unique single-use 1Click deposit address minted via a wet
    `EXACT_OUTPUT` quote (the merchant receives an exact amount of its chosen
    asset on its chosen chain); verification confirms the client's deposit by
    1Click status observation and drives the swap to a terminal state. Atomic
    replay protection (in-flight hash claims with lease recovery,
    consume-on-terminal), quote caching with early refresh, `settlement-failed`
    problem mapping, 503/504 semantics for backend unavailability and settlement
    timeouts (credential re-presentable), structured `onEvent` settlement
    observability, and `referral: "mpp"` distribution-channel attribution on
    every quote.
  - **Client method** (`nearintents.charge` from `/client`): spec MUSTs enforced
    as assertions (schema validation, `expires` refusal, payment policy with
    origin/currency allowlists, per-asset `maxAmountIn` caps and destination
    pinning); pays via built-in EVM wallet broadcast, a `sendDeposit` callback
    for non-EVM origins, or an already-broadcast `context.hash`.
  - **Receipts** carry the spec-required `challengeId`, `originTxHash`, and
    `destinationNetwork` extension fields (requires `mppx >= 0.8.6`).
  - Conformance wire vectors generated through mppx primitives from the spec's
    examples (Arbitrum USDC and native BTC origins); mock-1Click e2e suite; the
    flow is live-verified end to end, including a real funded Arbitrum-USDC →
    NEAR-USDC payment.
