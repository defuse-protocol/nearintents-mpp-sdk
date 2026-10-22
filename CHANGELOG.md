# @defuse-protocol/nearintents-mpp-sdk

## 0.3.0

### Minor Changes

- 8a46506: Adopt mppx 0.15.0: bump the exact dev and peer dependency pin from 0.10.1,
  and raise the `zod` dependency to `^4.6.7` so it dedupes with mppx's own zod
  (two copies broke declaration emit). The intervening upstream minors
  (0.11–0.15) change Tempo/EVM built-ins and standalone credential APIs that
  this method does not use; no code changes. Consumers must upgrade mppx to
  0.15.0, which itself requires viem >= 2.57.1.
- 5800922: Implement draft-nearintents-charge-01 (tempoxyz/mpp-specs#299): payer-resolved
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

## 0.2.0

### Minor Changes

- 2d4e484: Adopt mppx 0.10.1: bump the exact dev and peer dependency pin from 0.8.19.
  This crosses two upstream breaking minors — 0.9.0 (removed machineUSD flows,
  unused by this method) and 0.10.0 (recipient-allowlist enforcement in mppx's
  built-in methods, not applicable here) — with no code changes; the full suite
  passes against 0.10.1. Fixes fresh installs alongside the latest mppx failing
  on a peer conflict. Consumers must upgrade mppx to 0.10.1.

## 0.1.3

### Patch Changes

- 1dd8540: Adopt mppx 0.8.19: bump the exact dev and peer dependency pin from 0.8.15 so
  fresh installs alongside the latest mppx resolve without a peer conflict.

## 0.1.2

### Patch Changes

- ed00c70: Adopt mppx 0.8.15: bump the exact dev and peer dependency pin from 0.8.13 so
  fresh installs alongside the latest mppx resolve without a peer conflict.

## 0.1.1

### Patch Changes

- 078e49d: Bumped the pinned `mppx` peer dependency to `0.8.13` (verified: receipt
  extension fields round-trip and the full mock-1Click e2e suite passes against
  it) and improved the README (clearer client policy guidance, reorganized
  operational notes).

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
