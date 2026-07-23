# nearintents-mpp-sdk

Reference implementation of the **`nearintents` payment method for MPP**
(Machine Payments Protocol) as a TypeScript package extending
[`mppx`](https://github.com/wevm/mppx). MPP gates HTTP resources behind
payments (`402` + `WWW-Authenticate: Payment`); this method settles them
cross-chain via the **NEAR Intents 1Click Swap API**: the server's 402
challenge carries a unique single-use 1Click deposit address as `recipient`;
the client pays the source asset on its origin chain and presents the tx hash
as a `{type:"hash"}` credential; the server verifies the deposit and drives the
swap to `SUCCESS` (`EXACT_OUTPUT` — the merchant receives an exact amount of
its chosen asset on its chosen chain).

**Normative wire contract:** `docs/spec/draft-nearintents-charge-00.md`
(registered in `tempoxyz/mpp-specs` as `specs/methods/nearintents/`). Tests
cite it. The dev plan is `DEVPLAN-nearintents-mpp-sdk-v1.md` at the repo root.

## Commands

- `npx pnpm@11 install` — pnpm is not installed globally (or use corepack; `packageManager` is pinned)
- `pnpm check:types` / `pnpm lint` / `pnpm test` / `pnpm check` (all three)
- `pnpm build` — tsc to `dist/`

## Layout

- `src/Types.ts` — method consts, CAIP-2/CAIP-19 helpers, request/payload/receipt schemas
- `src/Methods.ts` — the shared `Method.from` definition (`nearintents`/`charge`)
- `src/Errors.ts` — method-specific MPP problem types (`settlement-failed`)
- `src/internal/OneClick.ts` — 1Click settlement core (quote/depositSubmit/status/poll, CAIP-19 ↔ 1Click asset mapping, terminal/error mapping)
- `src/server/Charge.ts` — server `charge()`: quote mint + cache (early refresh), credential-path store resolution, stableBinding, verify (atomic in-flight claim → status-observation deposit confirmation → poll to terminal → extended receipt / mapped problem)
- `src/client/Charge.ts` — client `charge()`: schema + expires + policy assertions, hash credential, built-in EVM broadcast (`walletClient`), `sendDeposit` for non-EVM origins
- `test/` — mock 1Click server (`OneClickMock.ts`), wire-vector fixtures, e2e
- `examples/` — two-origin merchant server (`server.ts`: Arbitrum 5-min + BTC 45-min windows, rolling expires via per-request route creation) and paying client (`client.ts`: dry-run / `DEPOSIT_TX_HASH` / `PRIVATE_KEY`-viem modes); run with `pnpm example:server` / `example:client` (env in `.env`)
- `demo/` — browser storefront: `demo/server` (paid modules + static serving; the deployable reference endpoint, see root `Dockerfile`) and `demo/app` (Vite React **workspace package** — declared in `pnpm-workspace.yaml` — running the real client in-browser: injected-wallet EVM path + manual-hash path). `pnpm demo:server` / `demo:app` / `demo:build`. Note: pnpm's default 24h release-age gate excludes `mppx` (`minimumReleaseAgeExclude`) because we adopt its releases same-day.

## Hard constraints (verified upstream — do not rediscover)

1. **mppx ≥ 0.8.6 is required** — it ships the receipt-extensibility fix
   (wevm/mppx#612: `Receipt.Schema = z.looseObject(shape)`) that lets the
   spec-REQUIRED receipt fields (`challengeId`, `originTxHash`,
   `destinationNetwork`) survive parse/serialize. 0.8.5 and earlier strip
   them. (History: this repo carried `patches/mppx@0.8.5.patch` until 0.8.6
   shipped on 2026-07-07.) mppx is an exact-pinned peer dep (pre-1.0 churn);
   bump devDependency and peerDependency together.
2. **Challenge `expires` is route-static in mppx** (computed before the
   `request` hook runs; the hook cannot set it). The quote cache must refresh
   early: treat a cached quote as stale once `now + expiresWindow >
   quoteDeadline` so `expires` always precedes the active quote's deadline.
3. **The `request` hook runs on both challenge and credential requests.** On
   credential-bearing requests, resolve the quote from the echoed challenge
   (store lookup keyed by deposit address) — never mint a new quote there.
4. **`stableBinding`** binds `recipient` (deposit address) + `amount` +
   `currency` + `methodDetails.originNetwork`. A rotated quote then yields a
   binding mismatch → 402 with a fresh challenge = the spec's client-recovery
   flow, for free.
5. **Replay protection:** claim `payload.hash` in-flight atomically via
   `AtomicStore.update` (mirror tempo's `markHashUsed`); permanently consume
   only on a terminal settlement state; give in-flight claims a TTL lease
   (≈ expires + timeEstimate + margin) so a crashed settlement never strands a
   legitimate retry. Requires an atomic store (memory dev / redis prod).
6. **Never re-implement mppx core primitives** (challenge HMAC binding, JCS +
   base64url `request` encoding, credential/receipt codecs, middleware). Build
   test fixtures **through these APIs**, never by hand-encoding.
7. **Client-side spec MUSTs are assertions, not docs:** verify
   `amount`/`currency`/`recipient`/`originNetwork` and the destination leg
   before paying; refuse past `expires`; payment policy config (allowed origin
   networks/assets, `maxAmountIn` cap); `source` as `did:pkh`.
8. **Post-terminal 402 nuance:** mppx computes the retry challenge BEFORE
   `verify` runs, so the 402 returned immediately after a non-success terminal
   echoes the just-spent quote. The client's next plain request gets a fresh
   challenge (the cache pointer is dropped on terminal) — one extra round trip;
   spec-recoverable and covered by the e2e suite. An upstream mppx hook to
   re-resolve the retry challenge post-verify would remove it.

## 1Click essentials

- Base `https://1click.chaindefuser.com`; JWT via `Authorization: Bearer`
  (env `ONE_CLICK_JWT`, server-side only — **never in any challenge field**;
  unauthenticated costs 0.2%).
- `POST /v0/quote` with `dry: false`, `swapType: EXACT_OUTPUT` → unique
  single-use `depositAddress`, `amountIn` (= challenge `amount`),
  `minAmountIn`, `deadline`, `timeEstimate`, `depositMemo?`. Every quote the
  server method mints carries `referral: "mpp"` (distribution-channel
  attribution, mirrors the x402 gateway; override via `charge({ referral })`).
- `POST /v0/deposit/submit` `{txHash, depositAddress}` after verification —
  optional, accelerates processing.
- `GET /v0/status/{depositAddress}` → terminal: `SUCCESS | FAILED | REFUNDED |
  INCOMPLETE_DEPOSIT`. Match `payload.hash` against
  `swapDetails.originChainTxHashes` (status-observation is the v1 deposit
  confirmation — no per-chain RPC); receipt `reference` =
  `swapDetails.destinationChainTxHashes[0]`.
- Wire uses CAIP-19; 1Click uses `nep141:…` asset ids. Mapping is token-list
  driven (`GET /v0/tokens`) in `internal/OneClick.ts`; compare CAIP-19 by
  parsed components (EVM addresses case-insensitively).
- Error mapping: deposit below `minAmountIn` → `payment-insufficient`;
  `FAILED`/`REFUNDED` after a verified deposit → `settlement-failed` (402 +
  fresh challenge); deadline passed → `payment-expired`; 1Click/RPC
  unavailable during a required check → **5xx, never `verification-failed`**,
  and do not settle.

## Guardrails

- Docker is unavailable; tests are **mock-only** (in-process mock 1Click).
  Never call live 1Click from CI or the test suite.
- ESM-only, Biome (single quotes, no semicolons), vitest, changesets.
- Published as **`@defuse-protocol/nearintents-mpp-sdk`** with npm provenance.
  Releases flow through changesets: PRs that change published behavior add a
  changeset; the release workflow maintains a "Version Packages" PR whose
  merge builds and publishes via **npm Trusted Publishing** (OIDC — no npm
  token anywhere; the publisher on npmjs.com is bound to this repo, the
  `release.yml` workflow, and the `npm-publish` GitHub environment). The
  defuse-protocol org requires every workflow action pinned to a full-length
  commit SHA.

## Definition of done (v1)

- Spec-conformance wire vectors pass (generated through mppx primitives; both
  example origins: Arbitrum USDC and native BTC).
- Mock-1Click e2e green: success path; all four non-success terminals with
  correct problem-type mapping and fresh-challenge recovery; replay +
  concurrency invariants (same credential twice → exactly one settlement);
  quote rotation → binding mismatch recovery.
- `Payment-Receipt` carries `challengeId`, `originTxHash`
  (+ `destinationNetwork`) per the spec's receipt table.
- One real small-amount cross-chain payment via the example server (manual). ✓
- Package published as `@defuse-protocol/nearintents-mpp-sdk` with provenance;
  mpp.dev method-page PR opened. ✓

**Deliberately out of scope for v1** (revisit when a real product endpoint
exists — e.g. the x402/1CS gateway, which shares this settlement core): hosting
a public reference endpoint and the mpp.dev service-directory (`services.ts`) /
MPPScan registration. The directory lists *live* services and implies an
operational commitment (uptime, JWT rotation, merchant reconciliation); a
synthetic demo is the wrong first entry. The demo remains runnable locally
(`pnpm demo:server` + `demo:app`) and the root `Dockerfile` stays deploy-ready
for when that decision flips.
