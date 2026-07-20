# Demo — cross-chain 402 in the browser

A merchant with two paid endpoints (`demo/server`) and a browser storefront
(`demo/app`) that pays them by running the **real `nearintents-mpp-sdk` client**
in the page:

- **Alpha terminal** — 0.10 USDC to the merchant, paid from **Arbitrum USDC**
  (5-minute window). One-click via an injected EVM wallet (MetaMask et al.),
  or manually.
- **Cross-chain flow report** — 6 USDC to the merchant, paid from **native
  Bitcoin** (45-minute window; priced above the PoA-bridge minimum). Manual:
  send the deposit from any BTC wallet, paste the txid.

Both deliver the exact `amountOut` in USDC on NEAR to the merchant. The page
shows the decoded 402 challenge (single-use deposit address, amount, expiry
countdown) and, after settlement, the decoded `Payment-Receipt`.

## Run it

```sh
# from the repo root — .env needs ONE_CLICK_JWT (see .env.example)
npx pnpm@11 install          # installs the app workspace too

# development (two terminals; Vite proxies /api to the server)
pnpm demo:server             # http://localhost:8402 (API)
pnpm demo:app                # http://localhost:5173 (UI, hot reload)

# production shape (server serves the built app same-origin)
pnpm demo:build
pnpm demo:server             # http://localhost:8402 (UI + API)
```

For real payouts set `MERCHANT_RECIPIENT`, `REFUND_TO_ARB`, `REFUND_TO_BTC`,
and `MPP_SECRET_KEY` in `.env` — the defaults are visibly placeholders.

## Safety

Real funds move when you pay. The in-page client enforces a payment policy
(`demo/app/src/lib/pay.ts`): origins limited to Arbitrum + Bitcoin, hard caps
of **2 USDC / 20k sats** per purchase — challenges asking for more are refused
before any wallet interaction.

## Deploy

The repo-root [`Dockerfile`](../Dockerfile) builds the app and runs this
server as a single container (the M4 reference endpoint). Supply the env vars
above at runtime.
