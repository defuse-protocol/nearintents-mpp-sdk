/**
 * Demo merchant server — the API behind demo/app (and a deployable reference
 * endpoint). Two paid modules on two origin windows:
 *
 *   GET /api/insight — alpha terminal, 0.10 USDC out, pay from Arbitrum (5 min)
 *   GET /api/report  — flow report, 6 USDC out, pay from native BTC (45 min)
 *
 * Serves demo/app/dist statically when built (same-origin in production; the
 * Vite dev server proxies /api during development).
 *
 * Run:  pnpm demo:server
 * Env:  ONE_CLICK_JWT, MPP_SECRET_KEY, MERCHANT_RECIPIENT,
 *       REFUND_TO_ARB, REFUND_TO_BTC, PORT (default 8402)
 */
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Expires, Mppx, NodeListener } from 'mppx/server'

import { nearintents } from '../../src/server/index.js'
import * as insight from './modules/insight.js'
import * as report from './modules/report.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDist = path.join(__dirname, '..', 'app', 'dist')

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

const arb = Mppx.create({
  secretKey,
  methods: [
    nearintents.charge({
      ...shared,
      originAsset: ARB_USDC,
      refundTo: process.env.REFUND_TO_ARB ?? '0x2527D02599Ba641c19Fea793Cd0f9A6e8457c317',
      amountOut: '100000', // 0.10 USDC to the merchant
      description: 'Alpha terminal insight (pay with USDC on Arbitrum)',
      expiresWindow: 300,
      onEvent: logEvent('insight'),
    }),
  ],
})

const btc = Mppx.create({
  secretKey,
  methods: [
    nearintents.charge({
      ...shared,
      originAsset: BTC,
      refundTo: process.env.REFUND_TO_BTC ?? 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h',
      // Above the PoA-bridge minimum for BTC-origin deposits.
      amountOut: '6000000', // 6 USDC to the merchant
      description: 'Cross-chain flow report (pay with native BTC)',
      expiresWindow: 45 * 60,
      quoteDeadlineBuffer: 60 * 60,
      settlementTimeout: 120,
      onEvent: logEvent('report'),
    }),
  ],
})

// Outcome-level events come from mppx itself.
for (const [route, mppx] of [
  ['insight', arb],
  ['report', btc],
] as const) {
  mppx.on('payment.success', ({ receipt }) =>
    console.log(`[${route}] payment.success reference=${receipt.reference}`),
  )
  mppx.on('payment.failed', ({ error }) =>
    console.log(`[${route}] payment.failed ${error.type} — ${error.message}`),
  )
}

async function serveApi(request: Request, route: string): Promise<Response> {
  // Route handlers are created per request so the absolute mppx `expires`
  // becomes a rolling window sized to the origin chain.
  if (route === '/api/insight') {
    const result = await arb.charge({ expires: Expires.minutes(5) })(request)
    if (result.status === 402) return result.challenge
    return result.withReceipt(Response.json(insight.generate()))
  }
  if (route === '/api/report') {
    const result = await btc.charge({ expires: Expires.minutes(45) })(request)
    if (result.status === 402) return result.challenge
    return result.withReceipt(Response.json(report.generate()))
  }
  if (route === '/api/health') return Response.json({ ok: true })
  return Response.json({ error: `no route ${route}` }, { status: 404 })
}

const contentTypes: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function serveStatic(route: string): Response | undefined {
  if (!fs.existsSync(appDist)) return undefined
  const relative = route === '/' ? 'index.html' : route.slice(1)
  const resolved = path.resolve(appDist, relative)
  // Reject anything that escapes appDist. `startsWith(appDist)` alone would
  // admit sibling dirs like `<appDist>-evil`; compare the relative path.
  const rel = path.relative(appDist, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  const file = fs.existsSync(resolved) ? resolved : path.join(appDist, 'index.html')
  if (!fs.existsSync(file)) return undefined
  return new Response(fs.readFileSync(file), {
    headers: { 'content-type': contentTypes[path.extname(file)] ?? 'application/octet-stream' },
  })
}

const port = Number(process.env.PORT ?? 8402)
http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`)
    const request = new Request(url, {
      method: req.method ?? 'GET',
      headers: Object.entries(req.headers).flatMap(([key, value]) =>
        value === undefined
          ? []
          : Array.isArray(value)
            ? value.map((entry) => [key, entry] as [string, string])
            : [[key, value] as [string, string]],
      ),
    })

    const respond = url.pathname.startsWith('/api/')
      ? serveApi(request, url.pathname)
      : Promise.resolve(
          serveStatic(url.pathname) ??
            Response.json(
              { hint: 'build the app first: pnpm -C demo/app install && pnpm -C demo/app build' },
              { status: 404 },
            ),
        )

    respond
      .then((response) => NodeListener.sendResponse(res, response))
      .catch((error) => {
        console.error(error)
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal error' }))
      })
  })
  .listen(port, () => {
    console.log(`nearintents demo server on http://localhost:${port}`)
    console.log('  GET /api/insight — 0.10 USDC out, pay from Arbitrum')
    console.log('  GET /api/report  — 6 USDC out, pay from native BTC')
  })
