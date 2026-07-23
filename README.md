# nearintents-mpp-sdk

Reference implementation of the **`nearintents` payment method** for
[MPP (Machine Payments Protocol)](https://mpp.dev) enabling cross-chain HTTP 402
payments settled by [NEAR Intents](https://near-intents.org): clients pay on
any supported chain, merchants receive an exact amount on theirs. Extends
[`mppx`](https://github.com/wevm/mppx). The original spec this implementation is based on is found at [Tempo's MPP specs repository](https://github.com/tempoxyz/mpp-specs/blob/main/specs/methods/nearintents/draft-nearintents-charge-00.md).

## Usage

Server (see [`src/server/Charge.ts`](src/server/Charge.ts) for all options):

```ts
import { Mppx } from 'mppx/server'
import { nearintents } from '@defuse-protocol/nearintents-mpp-sdk/server'

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY!,
  methods: [
    nearintents.charge({
      originAsset: 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      destinationAsset: 'near:mainnet/nep141:1720…33a1',
      destinationRecipient: 'merchant.near',
      refundTo: '0x2527…C317', // merchant origin-chain refund address
      amountOut: '1000000', // exact amount the merchant receives (EXACT_OUTPUT)
      oneClick: { jwt: process.env.ONE_CLICK_JWT },
      // production: store: Store.redis(client) — replay protection needs an atomic store
    }),
  ],
})
```

Client (`policy` as safety surface, the client pays before delivery):

```ts
import { Mppx } from 'mppx/client'
import { nearintents } from '@defuse-protocol/nearintents-mpp-sdk/client'

const mppx = Mppx.create({
  methods: [
    nearintents.charge({
      walletClient, // viem WalletClient (+ public actions) for eip155 origins
      policy: {
        allowedOriginNetworks: ['eip155:42161'],
        maxAmountIn: { 'eip155:42161/erc20:0xaf88…5831': '5000000' },
      },
    }),
  ],
})
const response = await mppx.fetch('https://api.example.com/paid-resource')
```

Non-EVM origins (BTC, Solana, …) pay via the `sendDeposit` callback or present
an already-broadcast tx hash as `context.hash`.

A `policy` is **strongly recommended for any autonomous payer.** The client
always schema-validates the challenge and refuses to pay past `expires`, but
the *value* checks — allowed origin networks/assets, per-asset `maxAmountIn`
caps, and the expected destination leg — only run when a `policy` is
configured. Without one, the client will pay any authentic challenge the
server presents; the policy is the client's safety surface since it pays
before delivery.

## How it works

1. The server answers an unpaid request with `402` + `WWW-Authenticate:
   Payment` whose `request` carries a unique, single-use **1Click deposit
   address** as `recipient`, the origin-chain leg the client pays (`amount`,
   `currency`), and the merchant's destination leg in `methodDetails`.
2. The client pays the source asset on its origin chain and retries with the
   confirmed transaction hash as a `{type: "hash"}` credential.
3. The server verifies the deposit via the 1Click status endpoint, drives the
   cross-chain swap to `SUCCESS`, and returns the resource with a
   `Payment-Receipt` carrying `challengeId`, `originTxHash`, and the
   destination-chain delivery hash.

Quotes use `EXACT_OUTPUT`, so the merchant receives a deterministic amount of
its chosen asset on its chosen chain. 

Note that settlement is not trustless: deposits are custodied by the NEAR Intents 
settlement system for the duration of the swap, with automatic refunds 
to `methodDetails.refundTo` on every non-success outcome. 
See the spec's Trust Model section.

## Demo

[`demo/`](demo/README.md) is a browser storefront that runs the real client in
the page: unlock a paid endpoint with an injected EVM wallet on Arbitrum, or
from any Bitcoin wallet by pasting the deposit txid. `pnpm demo:server` +
`pnpm demo:app` (dev), or `pnpm demo:build && pnpm demo:server` (same-origin
production shape; the root [`Dockerfile`](Dockerfile) packages it).

## Examples

[`examples/server.ts`](examples/server.ts) is a two-route merchant (Arbitrum
USDC origin with a 5-minute window, native BTC origin with a 45-minute
window); [`examples/client.ts`](examples/client.ts) pays it — or dry-runs,
printing the decoded challenge, when no key/hash is provided.

```sh
cp .env.example .env            # add ONE_CLICK_JWT (and merchant addresses)
pnpm example:server             # http://localhost:8402
pnpm example:client             # dry run: shows what /premium asks for
pnpm example:client http://localhost:8402/premium-btc
```

To execute a real payment (real funds!): set `PRIVATE_KEY` to a funded
Arbitrum account and run `pnpm example:client`, or send the deposit yourself
and re-run with `DEPOSIT_TX_HASH=0x…`. The client refuses anything beyond its
configured `policy.maxAmountIn` caps.

## Operational notes

- **Refunds.** `methodDetails.refundTo` is a **merchant-configured** address
  on the origin chain (the server cannot know the payer before payment).
  Every non-success terminal refunds the deposit there; payers recover
  off-band per the merchant's terms. Disclose this in your terms of service.
- **Per-origin expiry.** Size `expiresWindow` (and the mppx route `expires`)
  to the origin chain: minutes for fast chains, 45–60 minutes for Bitcoin.
  The example server creates the route handler per request so the absolute
  mppx `expires` becomes a rolling window. **`charge({ expiresWindow })` MUST
  equal the `expires` you pass to `mppx.charge({ expires })`** — mppx computes
  the challenge `expires` before this method can read it, so the coupling is
  manual. Setting the route `expires` *larger* than `expiresWindow` can make a
  challenge advertise an `expires` past the quote deadline; a client depositing
  just before it is refunded instead of swapped (recoverable, but wasteful).
  The example/demo servers keep the two in lock-step.
- **Under-deposits are terminal.** If a deposit lands below
  `methodDetails.minAmountIn`, 1Click reports `INCOMPLETE_DEPOSIT`, which this
  method treats as a terminal outcome (per spec §Settlement): the deposit is
  refunded to `refundTo`, the credential is consumed, and the client recovers
  with a fresh challenge — it does **not** hold the quote open waiting for a
  top-up (that is async-delivery territory, out of scope here). Backend
  aggregation of multiple deposits that reach `SUCCESS` *is* honored: any one
  of the observed origin-chain tx hashes is accepted as the credential.
- **Slow settlements.** `verify` holds the connection at most
  `settlementTimeout` seconds, then returns **504** with a problem body —
  the credential is *not* consumed and the client re-presents the same
  credential later (the deposit keeps settling in the background). Backend
  unavailability returns **503**, never `verification-failed`. Long-running
  origins can layer a `202 Accepted`/webhook pattern on top; that is out of
  scope for this package.
- **After a failed settlement** the immediate 402 echoes the spent challenge
  (mppx computes the retry challenge before `verify` runs); the client's next
  request receives a fresh quote. Conformant clients re-request on 402.
- **Trust model.** Settlement is not trustless: for the duration of the swap
  the deposit is custodied by the NEAR Intents settlement system
  (`methodDetails.settlementBackend: "near-intents"`), which either delivers
  the destination asset to the merchant or refunds the deposit. Comparable to
  entrusting a payment processor with a transfer; agents applying per-method
  risk policies can key off the `method` and `settlementBackend` fields.  

## Observability

The library never logs on its own. Merchant-side visibility comes from two
layers:

```ts
const method = nearintents.charge({
  // in-flight settlement progress (structured events → your logger):
  // quote.minted / quote.reused / deposit.submitted / settlement.status /
  // settlement.terminal / settlement.suspended / receipt.issued
  onEvent: (event) => logger.info(event),
  /* … */
})

const mppx = Mppx.create({ secretKey, methods: [method] })
// outcome-level events, from mppx itself:
mppx.on('payment.success', ({ receipt }) => logger.info(receipt))
mppx.on('payment.failed', ({ error }) => logger.warn(error.type, error.message))
```

`settlement.suspended` (backend unavailable / settlement timeout) means the
credential was **not** consumed and the client will re-present it. The
example and demo servers wire `onEvent` to the console, so `pnpm
example:server` shows each payment progressing live. Everything the events
carry (deposit addresses, tx hashes) is public on-chain data.

## Advanced: the settlement core

The spec's server steps 7 ("verify deposit") and 8 ("submit + await swap
finality") are implemented *inside* the method's `verify()`. Merchants never
call them directly, and the safety rails (atomic in-flight hash claim,
consume-on-terminal, release-on-5xx) live in that sequence. This package uses
**status observation** (spec §Verification step 3, second mode): 1Click
detecting a qualifying deposit *is* the origin-chain verification, and on
`SUCCESS` the presented `payload.hash` must appear among the backend's
observed `originChainTxHashes`. Direct per-chain RPC verification is a
possible future hardening hook, deliberately not part of v1.

For advanced integrations (custom settlement flows, background workers, ops
tooling), the underlying 1Click client is exported as the `OneClick`
namespace: `quote`, `submitDeposit`, `getStatus`, `pollToTerminal`,
`matchesOriginTx`, `destinationTxHash`, `terminalError`, plus the CAIP-19 ↔
1Click asset mapping (`createAssetMap`). If you drive settlement yourself you
also own replay protection.

## Spec

The normative wire contract is
[`docs/spec/draft-nearintents-charge-00.md`](docs/spec/draft-nearintents-charge-00.md)
(registered in
[`tempoxyz/mpp-specs`](https://github.com/tempoxyz/mpp-specs) under
`specs/methods/nearintents/`). Conformance vectors in
[`test/vectors.test.ts`](test/vectors.test.ts) are generated through mppx
primitives from the spec's examples.

## Development

```sh
npx pnpm@11 install   # pnpm pinned via packageManager
pnpm check            # typecheck + lint + tests
```

Tests are **mock-only** (in-process mock 1Click server in
[`test/OneClickMock.ts`](test/OneClickMock.ts)); the suite never calls live
1Click.

Note: `mppx` **0.8.6 or later** is required — it ships the upstream
receipt-extensibility fix ([wevm/mppx#612](https://github.com/wevm/mppx/pull/612))
that lets the method-specific receipt fields (`challengeId`, `originTxHash`,
`destinationNetwork`) survive the `Payment-Receipt` codec; earlier releases
strip them. mppx is an exact-pinned peer dependency while it is pre-1.0.

### Releasing

Releases are automated with [changesets](https://github.com/changesets/changesets):
PRs that change published behavior include one (`pnpm changeset`). On merge to
`main`, the release workflow maintains a "Version Packages" PR; merging *that*
builds and publishes to npm with
[provenance](https://docs.npmjs.com/generating-provenance-statements).

## License

[MIT](LICENSE)
