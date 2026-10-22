/**
 * Example merchant server for the `nearintents` payment method.
 *
 * Two paid routes demonstrate two origin windows:
 * - GET /premium      — pay 0.10 USDC-equivalent from Arbitrum (5-minute window)
 * - GET /premium-btc  — pay from native Bitcoin (45-minute window)
 *
 * The merchant receives exactly `amountOut` USDC on NEAR either way.
 *
 * Run:  pnpm example:server
 * Env:  ONE_CLICK_JWT      1Click partner JWT (unauthenticated works, 0.2% fee)
 *       MPP_SECRET_KEY     challenge-HMAC secret, ≥32 bytes (dev default below)
 *       MERCHANT_RECIPIENT NEAR account receiving the funds
 *       REFUND_TO_ARB      custodial merchant refund address on Arbitrum
 *       REFUND_TO_BTC      custodial merchant refund address on Bitcoin
 *       PORT               listen port (default 8402)
 */
import * as http from 'node:http'
import { Expires, Mppx, NodeListener } from 'mppx/server'

import { nearintents } from '../src/server/index.js'

const ARB_USDC = 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const NEAR_USDC =
  'near:mainnet/nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const BTC = 'bip122:000000000019d6689c085ae165831e93/slip44:0'

const jwt = process.env.ONE_CLICK_JWT
if (!jwt) console.warn('ONE_CLICK_JWT is not set — quotes will incur the 0.2% unauthenticated fee.')

const secretKey = process.env.MPP_SECRET_KEY ?? 'dev-only-secret-key-of-at-least-32-bytes!'
const destinationRecipient = process.env.MERCHANT_RECIPIENT ?? 'merchant.near'
if (!process.env.MERCHANT_RECIPIENT)
  console.warn('MERCHANT_RECIPIENT is not set — using the "merchant.near" placeholder.')

const shared = {
  destinationAsset: NEAR_USDC,
  destinationRecipient,
  amountOut: '100000', // 0.10 USDC (6 decimals) delivered to the merchant
  oneClick: { ...(jwt && { jwt }) },
} satisfies Partial<Parameters<typeof nearintents.charge>[0]>

/** Merchant-side visibility: settlement progress as one log line per event. */
function logEvent(route: string) {
  return (event: nearintents.charge.Event) => {
    const { type, ...fields } = event
    const rendered = Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')
    console.log(`[${route}] ${type} ${rendered}`)
  }
}

// Separate Mppx instances: both methods are nearintents/charge, and route
// windows differ per origin.
const arb = Mppx.create({
  secretKey,
  methods: [
    nearintents.charge({
      ...shared,
      originAsset: ARB_USDC,
      refundTo: process.env.REFUND_TO_ARB ?? '0x2527D02599Ba641c19Fea793Cd0f9A6e8457c317',
      description: 'Premium data (pay with USDC on Arbitrum)',
      expiresWindow: 300,
      onEvent: logEvent('premium'),
    }),
  ],
})

const btc = Mppx.create({
  secretKey,
  methods: [
    nearintents.charge({
      ...shared,
      originAsset: BTC,
      // BTC-origin deposits ride the PoA bridge, which enforces a minimum
      // deposit (≈ a few USD) — micro-prices are Arbitrum-route territory.
      amountOut: '6000000', // 6 USDC
      refundTo: process.env.REFUND_TO_BTC ?? 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h',
      description: 'Premium data (pay with native BTC)',
      // Slow-finality origin: long deposit window, and cap how long a single
      // request is held during settlement (clients re-present the credential
      // on 504 — see the 202/retry discussion in the README).
      expiresWindow: 45 * 60,
      quoteDeadlineBuffer: 60 * 60,
      settlementTimeout: 120,
      onEvent: logEvent('premium-btc'),
    }),
  ],
})

// Outcome-level events come from mppx itself.
for (const [route, mppx] of [
  ['premium', arb],
  ['premium-btc', btc],
] as const) {
  mppx.on('payment.success', ({ receipt }) =>
    console.log(`[${route}] payment.success reference=${receipt.reference}`),
  )
  mppx.on('payment.failed', ({ error }) =>
    console.log(`[${route}] payment.failed ${error.type} — ${error.message}`),
  )
}

async function serve(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname

  // mppx route `expires` is an absolute timestamp, so the route handler is
  // created per request to get a rolling window sized to the origin chain.
  const handler =
    path === '/premium'
      ? arb.charge({ expires: Expires.minutes(5) })
      : path === '/premium-btc'
        ? btc.charge({ expires: Expires.minutes(45) })
        : undefined
  if (!handler) return Response.json({ routes: ['/premium', '/premium-btc'] }, { status: 404 })

  const result = await handler(request)
  if (result.status === 402) return result.challenge

  return result.withReceipt(
    Response.json({
      premium: true,
      insight: 'The merchant was paid an exact amount on NEAR before you saw this.',
      servedAt: new Date().toISOString(),
    }),
  )
}

const port = Number(process.env.PORT ?? 8402)
http
  .createServer((req, res) => {
    const request = new Request(`http://localhost:${port}${req.url ?? '/'}`, {
      method: req.method ?? 'GET',
      headers: Object.entries(req.headers).flatMap(([key, value]) =>
        value === undefined
          ? []
          : Array.isArray(value)
            ? value.map((entry) => [key, entry] as [string, string])
            : [[key, value] as [string, string]],
      ),
    })
    serve(request)
      .then((response) => NodeListener.sendResponse(res, response))
      .catch((error) => {
        console.error(error)
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal error' }))
      })
  })
  .listen(port, () => {
    console.log(`nearintents example merchant listening on http://localhost:${port}`)
    console.log('  GET /premium      — Arbitrum USDC origin (5 min window)')
    console.log('  GET /premium-btc  — native BTC origin (45 min window)')
  })
