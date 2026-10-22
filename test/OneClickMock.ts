import type * as http from 'node:http'

import type { StatusResult, SwapStatus, TokenInfo } from '../src/internal/OneClick.js'
import { createServer, type TestServer } from './Http.js'

/**
 * In-process mock of the 1Click Swap API (quote / deposit-submit / status /
 * tokens) with scriptable terminal outcomes. Tests are mock-only by design —
 * never call live 1Click from the suite.
 */

/** Real-shaped token entries (mirrors live `/v0/tokens` data as of 2026-07). */
export const defaultTokens: TokenInfo[] = [
  {
    assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    decimals: 6,
    blockchain: 'arb',
    symbol: 'USDC',
    contractAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  },
  {
    assetId: 'nep141:btc.omft.near',
    decimals: 8,
    blockchain: 'btc',
    symbol: 'BTC',
  },
  {
    assetId: 'nep141:eth.omft.near',
    decimals: 18,
    blockchain: 'eth',
    symbol: 'ETH',
  },
  {
    assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    decimals: 6,
    blockchain: 'near',
    symbol: 'USDC',
    contractAddress: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  },
  {
    assetId: 'nep141:wrap.near',
    decimals: 24,
    blockchain: 'near',
    symbol: 'wNEAR',
    contractAddress: 'wrap.near',
  },
]

/** Per-quote scripting knobs. Applies to the next `POST /v0/quote` (FIFO). */
export type QuoteScript = {
  depositAddress?: string
  depositMemo?: string
  amountIn?: string
  minAmountIn?: string
  deadline?: string
  timeEstimate?: number
  /** Terminal status reached after a deposit is submitted. @default 'SUCCESS' */
  outcome?: SwapStatus
  /** Overrides the whole status sequence (each GET /v0/status consumes one, sticking on the last). */
  statuses?: SwapStatus[]
  destinationTxHash?: string
  /** SUCCESS temporarily has no destination or NEAR settlement reference. */
  omitSettlementReferences?: boolean
  /** Overrides the origin-chain tx hashes reported by /v0/status (defaults to the submitted hashes). */
  originTxHashes?: string[]
  refundReason?: string
  depositedAmount?: string
}

export type QuoteState = {
  depositAddress: string
  depositMemo: string | undefined
  quoteRequest: Record<string, unknown>
  quote: Record<string, unknown>
  script: QuoteScript
  /** Remaining scripted statuses; the last entry repeats forever. */
  sequence: SwapStatus[]
  submittedTxHashes: string[]
}

export type RequestLogEntry = {
  method: string
  path: string
  searchParams: Record<string, string>
  headers: http.IncomingHttpHeaders
  body: unknown
}

export type OneClickMock = {
  url: string
  close(): void
  /** Token list served at GET /v0/tokens. */
  tokens: TokenInfo[]
  /** Queues scripting for the next quote(s), FIFO. */
  script(script: QuoteScript): void
  /** Replaces the remaining status sequence for a deposit address. */
  setStatuses(depositAddress: string, statuses: SwapStatus[]): void
  /** Makes a SUCCESS settlement reference visible after an indexing delay. */
  setSettlementReference(depositAddress: string, hash: string): void
  /** Returns 500 for the next `n` requests (any endpoint). */
  failNextRequests(n: number): void
  /** All requests received, for wire-level assertions. */
  requests: RequestLogEntry[]
  /** Minted quotes by deposit address, for state assertions. */
  quotes: Map<string, QuoteState>
}

export async function createOneClickMock(
  options: { tokens?: TokenInfo[] } = {},
): Promise<OneClickMock> {
  const tokens = options.tokens ?? defaultTokens
  const scripts: QuoteScript[] = []
  const quotes = new Map<string, QuoteState>()
  const requests: RequestLogEntry[] = []
  let failCount = 0
  let mintCounter = 0

  function buildStatusResult(state: QuoteState): StatusResult {
    const status = state.sequence[0] ?? 'PENDING_DEPOSIT'
    if (state.sequence.length > 1) state.sequence.shift()

    const originTxHashes = state.script.originTxHashes ?? state.submittedTxHashes
    const base: StatusResult = {
      status,
      updatedAt: new Date().toISOString(),
      quoteResponse: { quoteRequest: state.quoteRequest, quote: state.quote },
      swapDetails: {
        originChainTxHashes: originTxHashes.map((hash) => ({ hash })),
        destinationChainTxHashes: [],
      },
    }
    if (status === 'SUCCESS') {
      base.swapDetails = {
        ...base.swapDetails,
        amountIn: (state.quote.minAmountIn as string) ?? undefined,
        amountOut: (state.quoteRequest.amount as string) ?? undefined,
        ...(!state.script.omitSettlementReferences && {
          nearTxHashes: [`mock-near-${state.depositAddress}`],
          destinationChainTxHashes: [
            { hash: state.script.destinationTxHash ?? `mock-dest-${state.depositAddress}` },
          ],
        }),
      }
    }
    if (status === 'REFUNDED' || status === 'FAILED') {
      base.swapDetails = {
        ...base.swapDetails,
        refundReason: state.script.refundReason ?? 'mock refund',
      }
    }
    if (status === 'INCOMPLETE_DEPOSIT') {
      base.swapDetails = {
        ...base.swapDetails,
        depositedAmount: state.script.depositedAmount ?? '1',
      }
    }
    return base
  }

  const server: TestServer = await createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) : undefined
      requests.push({
        method: request.method ?? '',
        path: url.pathname,
        searchParams: Object.fromEntries(url.searchParams),
        headers: request.headers,
        body,
      })

      const json = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }

      if (failCount > 0) {
        failCount--
        return json(500, { message: 'mock internal error' })
      }

      if (request.method === 'GET' && url.pathname === '/v0/tokens') return json(200, tokens)

      if (request.method === 'POST' && url.pathname === '/v0/quote') {
        const quoteRequest = body as Record<string, unknown>
        if (quoteRequest?.dry === true)
          return json(400, { message: 'mock only supports wet quotes' })
        const script = scripts.shift() ?? {}
        mintCounter++
        const depositAddress = script.depositAddress ?? `mock-deposit-${mintCounter}`
        const depositMemo =
          script.depositMemo ??
          (quoteRequest.depositMode === 'MEMO' ? `memo-${mintCounter}` : undefined)

        // Deterministic pricing: 1:1 rate; amountIn adds the request's
        // slippageTolerance (bps) on top of minAmountIn, mirroring EXACT_OUTPUT.
        const amountOut = BigInt((quoteRequest.amount as string) ?? '0')
        const slippage = BigInt((quoteRequest.slippageTolerance as number) ?? 0)
        const minAmountIn = script.minAmountIn ?? amountOut.toString()
        const amountIn =
          script.amountIn ??
          ((BigInt(minAmountIn) * (10000n + slippage) + 9999n) / 10000n).toString()

        const quote = {
          depositAddress,
          ...(depositMemo !== undefined && { depositMemo }),
          amountIn,
          amountInFormatted: amountIn,
          amountInUsd: '0',
          minAmountIn,
          amountOut: amountOut.toString(),
          amountOutFormatted: amountOut.toString(),
          amountOutUsd: '0',
          minAmountOut: amountOut.toString(),
          deadline: script.deadline ?? new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          timeWhenInactive: script.deadline ?? new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          timeEstimate: script.timeEstimate ?? 120,
        }

        quotes.set(depositAddress, {
          depositAddress,
          depositMemo,
          quoteRequest,
          quote,
          script,
          sequence: script.statuses ? [...script.statuses] : ['PENDING_DEPOSIT'],
          submittedTxHashes: [],
        })

        return json(201, {
          correlationId: `mock-${mintCounter}`,
          timestamp: new Date().toISOString(),
          signature: `mock-signature-${mintCounter}`,
          quoteRequest,
          quote,
        })
      }

      if (request.method === 'POST' && url.pathname === '/v0/deposit/submit') {
        const { depositAddress, txHash } = (body ?? {}) as {
          depositAddress?: string
          txHash?: string
        }
        const state = depositAddress ? quotes.get(depositAddress) : undefined
        if (!state) return json(404, { message: 'Deposit address not found' })
        if (txHash && !state.submittedTxHashes.includes(txHash))
          state.submittedTxHashes.push(txHash)
        // A submitted deposit advances the pristine default sequence toward
        // the scripted outcome; sequences set via script.statuses or
        // setStatuses() are left untouched.
        const pristine = state.sequence.length === 1 && state.sequence[0] === 'PENDING_DEPOSIT'
        if (!state.script.statuses && pristine)
          state.sequence = ['KNOWN_DEPOSIT_TX', 'PROCESSING', state.script.outcome ?? 'SUCCESS']
        return json(201, buildStatusResult({ ...state, sequence: [state.sequence[0]!] }))
      }

      if (request.method === 'GET' && url.pathname === '/v0/status') {
        const depositAddress = url.searchParams.get('depositAddress')
        const state = depositAddress ? quotes.get(depositAddress) : undefined
        if (!state) return json(404, { message: 'Deposit address not found' })
        if (state.depositMemo && url.searchParams.get('depositMemo') !== state.depositMemo)
          return json(404, { message: 'Deposit address not found' })
        return json(200, buildStatusResult(state))
      }

      return json(404, { message: `mock: no route for ${request.method} ${url.pathname}` })
    })
  })

  return {
    url: server.url,
    close: () => server.close(),
    tokens,
    script: (script) => {
      scripts.push(script)
    },
    setStatuses: (depositAddress, statuses) => {
      const state = quotes.get(depositAddress)
      if (!state) throw new Error(`No mock quote for deposit address "${depositAddress}".`)
      state.sequence = [...statuses]
    },
    setSettlementReference: (depositAddress, hash) => {
      const state = quotes.get(depositAddress)
      if (!state) throw new Error(`No mock quote for deposit address "${depositAddress}".`)
      state.script.omitSettlementReferences = false
      state.script.destinationTxHash = hash
    },
    failNextRequests: (n) => {
      failCount = n
    },
    requests,
    quotes,
  }
}
