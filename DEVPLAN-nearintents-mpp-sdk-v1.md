# Dev Plan — `nearintents-mpp-sdk` v1

**Task:** build the reference implementation of the `nearintents` payment method for MPP (Machine Payments Protocol) as a **first-party TypeScript package extending `mppx`**, plus a live reference endpoint and mpp.dev docs.

**What the method does:** MPP gates HTTP resources behind payments (`402` + `WWW-Authenticate: Payment`). The `nearintents` method (spec: `draft-nearintents-charge-00`, registered in `tempoxyz/mpp-specs`) settles those payments cross-chain via the NEAR Intents 1Click API: the server's 402 challenge carries a unique single-use 1Click **deposit address** as `recipient`; the client pays the source asset on its origin chain and presents the tx hash as a `{type:"hash"}` credential; the server verifies the deposit and drives the swap to `SUCCESS`, at which point the merchant has received an exact amount (`EXACT_OUTPUT`) of its chosen asset on its chosen chain.

**v1 deliverable:** the `nearintents-mpp-sdk` package (server + client method, conformance tests, examples) + a deployed reference merchant endpoint + mpp.dev method page and service-directory entry. Additional languages (Rust, Python) come later, by integrator demand.

---

## 1. Read first — bootstrap for the implementing session

You are building a **new, empty repo**. Everything below is context you must not re-derive.

### Context pack (local paths)

- **The spec (normative wire contract):** `draft-nearintents-charge-00.md` — current revision (CAIP-19 asset ids, `originNetwork`). **Vendor a copy into the repo** (`docs/spec/`) in the first commit; tests cite it.
- **mppx clone (reference reading only — no code is copied):** `/Users/iker/Documents/MPP_impl/mppx`. Study:
  - `src/stripe/server/Charge.ts` — hosted-API verification + idempotency; the closest architectural analog to 1Click settlement.
  - `src/tempo/server/Charge.ts:343` — atomic mark-hash-used replay protection via `store.update`; mirror this pattern.
  - `src/evm/**` — module layout, `Types/Methods/client/server` split, client payment-policy config, subpath exports.
  - `src/Method.ts`, `src/Store.ts`, `src/Receipt.ts`, `src/Challenge.ts` — the core primitives this package builds on.
- If the `near-intents-engineer` skill is available, load it for 1Click context; otherwise §5 below is sufficient.

### mppx dependency bootstrap (sharp edge)

The receipt-extensibility change this method needs is **merged upstream ([wevm/mppx#612](https://github.com/wevm/mppx/pull/612), merge commit `591ecf4374bd5cdb8e534629413e5458c9231d5a`) but not yet in a published release** (npm latest: `0.8.5`, which predates it). A git dependency will NOT work out of the box (mppx publishes built `dist/`; git installs don't run its `zile` build). Until a release > 0.8.5 ships:

- **`pnpm patch mppx@0.8.5`** applying the #612 `src/Receipt.ts` diff (~15 lines: field-`shape` const + internal `BaseSchema` for the type + `Schema = z.looseObject(shape)`) — copy it from the local clone (already contains it) or the merge commit.
- Drop the patch as soon as the fixed release ships (Dependabot flags it; pin that version).
- Only receipt-extension tests need the patch; everything else builds against stock 0.8.5.

### Environment notes

- pnpm is not installed globally — use `npx pnpm@11` or corepack.
- Docker is unavailable — all tests must be mock-only (in-process mock 1Click server; mirror `mppx/test/Http.ts`). Never call live 1Click from CI.

### First-commit requirement

Include a **`CLAUDE.md` in the repo** distilling this plan's §1, §4, §5, and §8 (mission, spec pointer, constraints, commands, guardrails) — the repo must carry its own context from day one.

---

## 2. Preconditions & open items

**Done (do not redo):**
- Method spec registered and merged in `tempoxyz/mpp-specs` (`specs/methods/nearintents/`).
- mppx core can carry the spec's receipt fields (`originTxHash`, `challengeId`, `destinationNetwork`) — wevm/mppx#612, merged. Residual: await the first release > 0.8.5 (see §1 bootstrap).

**Open, parallel, non-blocking:**
- **Ops:** partner JWT for the reference endpoint; confirm 402-time quote/deposit-address minting fits 1Click rate limits.
- **npm scope decision** (`@near-intents/...` vs existing `@defuse-protocol/...`) — required **before first `npm publish`**, not before scaffolding. GitHub repos transfer with redirects; npm scopes don't.

---

## 3. Repo & scaffold spec

- **Repo:** `mpp-nearintents` — fresh standalone repo (NOT a fork; mppx is a dependency). Initially under the author's personal GitHub account (`IkerAlus`), transferred to the org later.
- **About:** "Reference implementation of the `nearintents` payment method for MPP (Machine Payments Protocol) — cross-chain HTTP 402 payments settled by NEAR Intents: clients pay on any supported chain, merchants receive an exact amount on theirs. Extends mppx." Topics: `mpp` `machine-payments` `http-402` `payments` `near` `near-intents` `cross-chain` `typescript`.
- **Settings:** public; MIT; default branch `main`; squash-merge only + auto-delete head branches; Issues on, wiki/projects/discussions off; ruleset on `main` = PRs with passing checks (no signed-commit requirement).
- **Package plumbing:** ESM-only (`"type": "module"`), `sideEffects: false`, exports `.` / `./client` / `./server`, pinned `packageManager`, `mppx` as pinned peer dep, optional `viem` peer for the EVM-origin helper, zod/mini for schemas.
- **Tooling:** vitest (colocated `*.test.ts`); Biome for lint+format; changesets from day 1; Dependabot weekly (npm + actions — doubles as the mppx-release watcher); CI = install → typecheck → lint → mock-only tests; npm provenance via Actions when publishing starts.
- **Hygiene:** `SECURITY.md` (NEAR Intents security contact); `.env.example` with `ONE_CLICK_JWT=` placeholder; `.env` gitignored.

---

## 4. Design constraints (verified against the mppx codebase — do not rediscover)

1. **Challenge `expires` is route-static** in mppx (default `Expires.minutes(5)`, computed before the request hook runs; the hook cannot set it). Therefore the quote cache must **refresh early**: treat a cached quote as stale once `now + expiresWindow > quoteDeadline`, so the challenge's `expires` always precedes the active quote's deadline (spec: expires MUST be at or slightly before the quote deadline). Configure larger static windows for slow origins (BTC ≈ 45–60 min; fast chains minutes).
2. **The `request` hook runs on both challenge and credential requests**, receiving `{capturedRequest, credential, request}`. On credential-bearing requests, resolve the quote from the echoed challenge (store lookup keyed by deposit address) — never mint a new quote there.
3. **`stableBinding`** is how the framework matches an echoed challenge against the current route request. Bind `recipient` (deposit address) + `amount` + `currency` + `methodDetails.originNetwork`. A rotated quote then yields a binding mismatch → 402 with a fresh challenge — which is exactly the spec's client-recovery flow, for free.
4. **Replay protection:** claim `payload.hash` in-flight atomically via `AtomicStore.update` (mirror tempo's `markHashUsed`); permanently consume only on a terminal settlement state; give in-flight claims a TTL lease (≈ challenge `expires` + `timeEstimate` + margin) so a crashed settlement never strands a legitimate retry. Document that replay protection requires an atomic store (memory for dev, redis for production).
5. **Never re-implement core primitives.** Challenge HMAC binding, JCS + base64url encoding of `request`, credential/receipt (de)serialization, header codecs, and framework middleware all come from mppx (`Challenge.from`, `Credential.*`, `Receipt.*`, `Method.toServer/toClient`). Build test fixtures **through these APIs**, not by hand-encoding.
6. **Receipts:** return `Receipt.from({ method: 'nearintents', reference, status, timestamp, externalId?, challengeId, originTxHash, destinationNetwork? })`. `reference` = destination-chain tx hash from 1Click status; `originTxHash` = the credential's `payload.hash`. Export a typed `NearIntentsReceipt = Receipt.Receipt & {...}` for consumers.
7. **Client-side spec MUSTs are assertions, not docs:** verify `amount`/`currency`/`recipient`/`originNetwork` and the destination leg before paying; refuse to proceed past `expires`; ship a payment policy config (allowed origin networks/assets, `maxAmountIn` cap) mirroring `evm/client` — the client pays before delivery, so this is its safety surface. Provide `canHandleChallenge` for multi-origin 402s and `source` as `did:pkh`.

---

## 5. 1Click API essentials (settlement backend)

- Base `https://1click.chaindefuser.com`; JWT via `Authorization: Bearer` (env `ONE_CLICK_JWT`, server-side only — **never in any challenge field**; unauthenticated works but costs 0.2%).
- `POST /v0/quote` with `dry: false`, `swapType: EXACT_OUTPUT`, quote-bound `refundTo` (prefer a payer-controlled address resolved from authenticated request context), destination leg (asset/recipient/amount) → returns unique single-use `depositAddress`, input-amount bounds, `deadline`, `timeEstimate`, `depositMemo?`. One quote per challenge; cache per §4.1/4.3.
- `POST /v0/deposit/submit` `{txHash, depositAddress}` right after verification — optional but accelerates processing.
- `GET /v0/status/{depositAddress}` → poll to a terminal status: `SUCCESS | FAILED | REFUNDED | INCOMPLETE_DEPOSIT`. The response carries origin- and destination-chain tx hashes: match `payload.hash` against the origin hashes (this is the spec's deposit-confirmation step — **status-observation is the v1 default; no per-chain RPC**), and take the destination hash for the receipt `reference`.
- Asset identifiers are 1Click-native (`nep141:…omft.near` style); the wire uses CAIP-19. Build the CAIP-19 ↔ 1Click mapping from `GET /v0/tokens` inside `internal/OneClick.ts`; compare CAIP-19 ids by parsed components (EVM addresses case-insensitively).
- Error mapping to MPP problem types: deposit below `minAmountIn` → `payment-insufficient`; swap `FAILED`/`REFUNDED` after a verified deposit → `settlement-failed` (402 + fresh challenge); quote/challenge deadline passed → `payment-expired`; 1Click/RPC unavailable during a required check → **5xx, never `verification-failed`**, and do not settle.

---

## 6. Workplan

### M0 — Scaffold + fixtures (2–3 days)
Repo per §3; vendored spec; `CLAUDE.md`; mppx patch per §1; **wire-vector fixtures generated through mppx primitives** from the spec's examples (Arbitrum-origin USDC→NEAR, BTC-origin; challenge + credential + receipt); in-process mock 1Click server (quote/depositSubmit/status with scriptable terminal outcomes).

### M1 — Core modules (~1 wk)
- `src/Types.ts` — method/intent consts (`nearintents`/`charge`); CAIP-19 parse/validate/compare helpers; request schema (top-level `amount`/`currency`/`recipient` + `methodDetails`: `originNetwork`, `destinationNetwork`, `destinationAsset`, `destinationRecipient`, `amountOut`, `minAmountIn`, `depositMemo?`, `slippageTolerance?`, `timeEstimate?`, `refundTo`, `settlementBackend?`, `credentialTypes: ['hash']`); cross-field asserts (currency chain == `originNetwork`; `destinationAsset` chain == `destinationNetwork`); payload schema `{type:'hash', hash}`.
- `src/Methods.ts` — `Method.from({...})`.
- `src/internal/OneClick.ts` — settlement core: `quote` / `depositSubmit` / `status` / `pollToTerminal` (timeout from challenge window + `timeEstimate`), token-list-driven asset mapping, terminal-state + error mapping, destination-tx-hash extraction. **Coordinate with the x402 gateway workstream — one shared settlement-core design, two protocol adapters.**

### M2 — Server + client methods (~1–1.5 wk)
- `src/server/Charge.ts` — `charge(config)` via `Method.toServer`: defaults (destination leg, origin asset/network, slippage, merchant `refundTo`, per-route expires window); async `request` hook (quote + cache with early refresh per §4.1; credential-path resolution per §4.2); `stableBinding` per §4.3; `verify` = assert hash type → in-flight claim (§4.4) → deposit confirmation via 1Click status (≥ `minAmountIn` to `recipient`, memo honored) → `depositSubmit` + `pollToTerminal` → `SUCCESS`: extended receipt (§4.6) + consume hash; non-success terminal: consume + mapped error (§5).
- `src/client/Charge.ts` — `charge(config)` via `Method.toClient`: context `{hash?, account?}`; policy + assertions per §4.7; credential via `Credential.serialize`; optional EVM-origin deposit broadcast via `viem` when `context.account` is set and origin is `eip155:*`.
- Unit + e2e (mock 1Click): full 402 → deposit → credential → poll → 200 + receipt; every non-success terminal → 402 + fresh challenge; replay (in-flight rejected, consumed-on-terminal, lease-expiry recovery); concurrency (same credential twice → exactly one settlement — atomic-store requirement); quote rotation → binding mismatch → fresh challenge; conformance vectors pass.

### M3 — Examples + live smoke (few days)
Example merchant server (hono or express) + client script; multi-origin demo (Arbitrum + BTC windows); one real small-amount swap against live 1Click (manual, not CI); README (quickstart, trust model incl. custody-during-swap disclosure and `settlementBackend: "near-intents"`, refund policy, per-origin expiry guidance, 202-for-slow-origins pattern).

### M4 — Distribution (≈1 wk, ops-dependent)
Deploy the reference merchant endpoint (built on the package; co-locate/share the settlement core with the x402 1CS Gateway where practical); first `npm publish` (scope decision from §2); docs PRs to `tempoxyz/mpp`: method page under `payment-methods/` (Lightning's page is the template — install instructions pointing at this package), service-directory entry in `schemas/services.ts`, optional MPPScan registration.

### Deferred — language parity (by integrator demand, +2–3 wks each)
- **Rust** (`mpp-nearintents` crate on `mpp-rs`): external async quoter (the `ChargeMethod::prepare_request` trait is sync/no-I/O); per-challenge `expires` passed at challenge construction (no expiry issue in Rust); reuse core `PaymentPayload::hash`; background-refreshed quote cache for tower/axum `PaymentLayer` users; **requires the receipt twin upstream first** (`#[serde(flatten)]` extras on `mpp-rs::Receipt`).
- **Python** (`pympp` extension) — assess extension points then; prioritize over Rust if AI-agent-framework demand leads.

---

## 7. Locked configuration defaults

| Decision | Default | Note |
| --- | --- | --- |
| `refundTo` | Fixed address or per-request resolver | Prefer authenticated payer context and client-side pinning. A fixed merchant address requires explicit off-band recovery terms. |
| Deposit verification | 1Click-status-only | Per-chain origin RPC = optional pluggable hardening, not default. |
| Challenge expires | Per-route static window sized to origin chain | Quote cache refreshes early so expires ≤ quote deadline (§4.1). |
| Replay store | mppx `AtomicStore` (`memory` dev / `redis` prod) | Atomicity is a hard requirement (concurrency test in M2). |
| 1Click auth | `ONE_CLICK_JWT` env, server-side only | Unauthenticated = 0.2% fee; fine for demos only. |

---

## 8. Definition of done (v1)

- Spec-conformance wire vectors pass (generated through mppx primitives; both example origins).
- Mock-1Click e2e green: success path, all four non-success terminals with correct problem-type mapping and fresh-challenge recovery, replay and concurrency invariants, quote-rotation recovery.
- `Payment-Receipt` carries `challengeId`, `originTxHash` (and `destinationNetwork`) — verified against the spec's receipt table.
- One real small-amount cross-chain payment executed against live 1Click via the example server.
- Reference endpoint deployed; mpp.dev method page + service-directory PRs opened; package published under the final npm scope.

## 9. Risks

- **mppx pre-1.0 churn** — pinned peer dep + Dependabot + a CI job against `mppx@latest` for early warning.
- **Receipt fix release lag** — patch workaround in place (§1); drop on first release > 0.8.5.
- **1Click rate limits / quote spam at 402-time** — caching is designed in (§4.1); ops confirmation still open (§2); multi-origin challenges multiply wet quotes — offer per-origin routes or Accept-Payment-driven quoting rather than always quoting every origin.
- **Long-settlement origins vs. HTTP timeouts** — document the `202 + retry` pattern for BTC-class origins; v1 holds the connection within `maxTimeout`-style bounds and errors cleanly past them.
