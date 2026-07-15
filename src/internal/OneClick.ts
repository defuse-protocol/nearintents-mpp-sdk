import { Errors } from 'mppx'

import { SettlementFailedError } from '../Errors.js'
import * as Types from '../Types.js'

/**
 * 1Click Swap API settlement core.
 *
 * Thin, dependency-free client for the three endpoints this method uses
 * (`POST /v0/quote`, `POST /v0/deposit/submit`, `GET /v0/status`) plus the
 * token-list-driven CAIP-19 ↔ 1Click asset mapping and the terminal-state →
 * MPP problem-type mapping. Everything is injectable (`fetch`, `baseUrl`) so
 * tests run against the in-process mock — never live 1Click.
 *
 * Designed to be shared with the x402 1CS Gateway workstream: one settlement
 * core, two protocol adapters.
 */

export const defaultBaseUrl = 'https://1click.chaindefuser.com'

export type Config = {
  /** API base URL. @default "https://1click.chaindefuser.com" */
  baseUrl?: string | undefined
  /**
   * Partner JWT (env `ONE_CLICK_JWT`). Server-side only — MUST never appear
   * in any challenge field. Unauthenticated requests incur a 0.2% fee.
   */
  jwt?: string | undefined
  /** Fetch implementation. @default globalThis.fetch */
  fetch?: typeof globalThis.fetch | undefined
  /** Per-request timeout in milliseconds. @default 30000 */
  requestTimeoutMs?: number | undefined
  /** Additional CAIP-2 → 1Click blockchain-code entries, merged over {@link defaultNetworks}. */
  networks?: Record<string, string> | undefined
  /** Additional blockchain-code → SLIP-44 coin-type entries, merged over {@link defaultNativeCoinTypes}. */
  nativeCoinTypes?: Record<string, number> | undefined
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The 1Click API request failed (application error or unusable response).
 * Note {@link OneClickUnavailableError} (network failure / 5xx) is a subclass —
 * narrow on it first when the distinction matters.
 */
export class OneClickError extends Error {
  override readonly name: string = 'OneClickError'
  readonly status: number
  readonly body: unknown

  constructor(message: string, options: { status?: number; body?: unknown; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.status = options.status ?? 0
    this.body = options.body
  }
}

/**
 * The 1Click API was unreachable or returned a server error (network failure
 * or HTTP 5xx). Per the spec, callers MUST surface this as an HTTP 5xx —
 * never as `verification-failed` — and MUST NOT settle the credential.
 */
export class OneClickUnavailableError extends OneClickError {
  override readonly name = 'OneClickUnavailableError'
}

/** `pollToTerminal` exceeded its time budget without reaching a terminal status. */
export class PollTimeoutError extends Error {
  override readonly name = 'PollTimeoutError'
  /** Last successfully observed status, if any poll succeeded. */
  readonly lastStatus: SwapStatus | undefined
  /** Last transport error, if polling was failing when the budget ran out. */
  readonly lastError: unknown

  constructor(options: { timeoutMs: number; lastStatus?: SwapStatus; lastError?: unknown }) {
    super(
      `1Click status polling timed out after ${options.timeoutMs}ms` +
        (options.lastStatus ? ` (last status: ${options.lastStatus})` : ''),
    )
    this.lastStatus = options.lastStatus
    this.lastError = options.lastError
  }
}

// ---------------------------------------------------------------------------
// API types (subset of the 1Click OpenAPI actually used by this method)
// ---------------------------------------------------------------------------

export type TokenInfo = {
  /** 1Click-native asset id (e.g. `nep141:arb-0xaf88….omft.near`). */
  assetId: string
  decimals: number
  /** 1Click blockchain code (e.g. "arb", "btc", "near"). */
  blockchain: string
  symbol: string
  /** Absent for chain-native assets (e.g. BTC). */
  contractAddress?: string | undefined
}

export type Quote = {
  /** Unique single-use deposit address on the origin chain. */
  depositAddress: string
  /** Required alongside the deposit on memo-based chains (e.g. Stellar). */
  depositMemo?: string | undefined
  /** Input amount with slippage buffer baked in — the challenge `amount`. */
  amountIn: string
  /** Minimum input that still guarantees `amountOut` — the verification threshold. */
  minAmountIn: string
  /** Exact output amount the merchant receives (EXACT_OUTPUT). */
  amountOut: string
  minAmountOut?: string | undefined
  /** Deposit deadline (ISO 8601) — the challenge `expires` upper bound. */
  deadline: string
  timeWhenInactive?: string | undefined
  /** Estimated swap completion time in seconds after deposit confirmation. */
  timeEstimate: number
}

export type QuoteResult = {
  quote: Quote
  /** Echo of the quote request. */
  quoteRequest: Record<string, unknown>
  /** 1Click service signature over the quote — persist for dispute resolution. */
  signature?: string | undefined
  timestamp?: string | undefined
}

export type SwapStatus =
  | 'KNOWN_DEPOSIT_TX'
  | 'PENDING_DEPOSIT'
  | 'INCOMPLETE_DEPOSIT'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'REFUNDED'
  | 'FAILED'

export type TransactionDetails = {
  hash: string
  explorerUrl?: string | undefined
}

export type SwapDetails = {
  originChainTxHashes?: TransactionDetails[] | undefined
  destinationChainTxHashes?: TransactionDetails[] | undefined
  intentHashes?: string[] | undefined
  nearTxHashes?: string[] | undefined
  amountIn?: string | undefined
  amountOut?: string | undefined
  depositedAmount?: string | undefined
  refundedAmount?: string | undefined
  refundReason?: string | undefined
}

export type StatusResult = {
  status: SwapStatus
  updatedAt?: string | undefined
  swapDetails?: SwapDetails | undefined
  quoteResponse?: Record<string, unknown> | undefined
}

/**
 * Terminal settlement statuses per the spec (§Settlement Procedure): the swap
 * either delivered (`SUCCESS`) or the deposit is refunded to `refundTo`.
 * `INCOMPLETE_DEPOSIT` is treated as terminal for settlement even though the
 * backend may still accept top-ups before the deadline.
 */
export const terminalStatuses = ['SUCCESS', 'FAILED', 'REFUNDED', 'INCOMPLETE_DEPOSIT'] as const

export function isTerminal(status: SwapStatus): boolean {
  return (terminalStatuses as readonly string[]).includes(status)
}

// ---------------------------------------------------------------------------
// HTTP core
// ---------------------------------------------------------------------------

async function request<result>(
  config: Config,
  path: string,
  init: {
    method: 'GET' | 'POST'
    body?: unknown
    searchParams?: Record<string, string>
    /** Optional caller deadline for this request; capped by Config.requestTimeoutMs. */
    timeoutMs?: number | undefined
    signal?: AbortSignal | undefined
  },
): Promise<result> {
  const baseUrl = config.baseUrl ?? defaultBaseUrl
  const fetchFn = config.fetch ?? globalThis.fetch
  const url = new URL(path, baseUrl)
  for (const [key, value] of Object.entries(init.searchParams ?? {})) {
    url.searchParams.set(key, value)
  }

  const configuredTimeoutMs = config.requestTimeoutMs ?? 30_000
  if (!Number.isFinite(configuredTimeoutMs) || configuredTimeoutMs <= 0)
    throw new RangeError('1Click requestTimeoutMs must be a positive finite number.')
  if (init.timeoutMs !== undefined && (!Number.isFinite(init.timeoutMs) || init.timeoutMs <= 0))
    throw new RangeError('1Click request timeoutMs must be a positive finite number.')

  let response: Response
  try {
    const timeoutMs = Math.max(
      1,
      Math.ceil(Math.min(configuredTimeoutMs, init.timeoutMs ?? Number.POSITIVE_INFINITY)),
    )
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    response = await fetchFn(url, {
      method: init.method,
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
        ...(config.jwt && { authorization: `Bearer ${config.jwt}` }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      signal: init.signal ? combineAbortSignals(init.signal, timeoutSignal) : timeoutSignal,
    })
  } catch (error) {
    // Preserve an explicit caller abort (for example an HTTP disconnect)
    // instead of misclassifying it as backend unavailability.
    init.signal?.throwIfAborted()
    throw new OneClickUnavailableError(`1Click request failed: ${init.method} ${path}`, {
      cause: error,
    })
  }

  const body = await response.json().catch(() => undefined)

  if (response.status >= 500)
    throw new OneClickUnavailableError(
      `1Click returned ${response.status} for ${init.method} ${path}`,
      { status: response.status, body },
    )
  if (!response.ok)
    throw new OneClickError(
      `1Click returned ${response.status} for ${init.method} ${path}: ${detailOf(body)}`,
      { status: response.status, body },
    )

  return body as result
}

function combineAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController()
  const cleanup = () => {
    a.removeEventListener('abort', onA)
    b.removeEventListener('abort', onB)
  }
  const abortFrom = (signal: AbortSignal) => {
    cleanup()
    controller.abort(signal.reason)
  }
  const onA = () => abortFrom(a)
  const onB = () => abortFrom(b)
  if (a.aborted) abortFrom(a)
  else if (b.aborted) abortFrom(b)
  else {
    a.addEventListener('abort', onA, { once: true })
    b.addEventListener('abort', onB, { once: true })
  }
  return controller.signal
}

function detailOf(body: unknown): string {
  if (body && typeof body === 'object' && 'message' in body) return String(body.message)
  return body === undefined ? 'no response body' : JSON.stringify(body)
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** Fetches the supported token list (`GET /v0/tokens`). No auth required. */
export async function getTokens(config: Config): Promise<TokenInfo[]> {
  const tokens = await request<TokenInfo[]>(config, '/v0/tokens', { method: 'GET' })
  if (!Array.isArray(tokens))
    throw new OneClickError('1Click token list response is not an array.', { body: tokens })
  return tokens
}

export type QuoteParameters = {
  /** Origin asset as a 1Click asset id (map from CAIP-19 via {@link AssetMap}). */
  originAsset: string
  /** Destination asset as a 1Click asset id. */
  destinationAsset: string
  /** Exact output amount the merchant must receive, in base units (EXACT_OUTPUT). */
  amountOut: string
  /** Merchant address on the destination chain. */
  recipient: string
  /** Quote-bound refund address on the origin chain (prefer payer-controlled). */
  refundTo: string
  /** Slippage tolerance in basis points (applied to the input side). */
  slippageTolerance: number
  /** Quote/deposit deadline (ISO 8601). Size to the origin chain (BTC ≈ 45–60 min). */
  deadline: string
  /** `SIMPLE` (default) or `MEMO` for memo-based chains. */
  depositMode?: 'SIMPLE' | 'MEMO' | undefined
  referral?: string | undefined
  sessionId?: string | undefined
  quoteWaitingTimeMs?: number | undefined
  /** Escape hatch merged last into the raw request body. */
  overrides?: Record<string, unknown> | undefined
}

/**
 * Requests a wet (`dry: false`) EXACT_OUTPUT quote (`POST /v0/quote`),
 * yielding the unique single-use deposit address for one challenge.
 */
export async function quote(config: Config, parameters: QuoteParameters): Promise<QuoteResult> {
  const {
    amountOut,
    deadline,
    depositMode,
    destinationAsset,
    originAsset,
    overrides,
    quoteWaitingTimeMs,
    recipient,
    referral,
    refundTo,
    sessionId,
    slippageTolerance,
  } = parameters

  const body = {
    dry: false,
    swapType: 'EXACT_OUTPUT',
    depositType: 'ORIGIN_CHAIN',
    recipientType: 'DESTINATION_CHAIN',
    refundType: 'ORIGIN_CHAIN',
    amount: amountOut,
    originAsset,
    destinationAsset,
    recipient,
    refundTo,
    slippageTolerance,
    deadline,
    ...(depositMode !== undefined && { depositMode }),
    ...(referral !== undefined && { referral }),
    ...(sessionId !== undefined && { sessionId }),
    ...(quoteWaitingTimeMs !== undefined && { quoteWaitingTimeMs }),
    ...overrides,
  }

  const result = await request<{ quote?: Quote; quoteRequest?: Record<string, unknown> }>(
    config,
    '/v0/quote',
    { method: 'POST', body },
  )

  const quote_ = result?.quote
  for (const field of ['depositAddress', 'amountIn', 'minAmountIn', 'deadline'] as const) {
    if (!quote_?.[field])
      throw new OneClickError(`1Click quote response is missing "quote.${field}".`, {
        body: result,
      })
  }
  if (!/^\d+$/.test(quote_!.amountIn) || !/^\d+$/.test(quote_!.minAmountIn))
    throw new OneClickError('1Click quote response contains a non-integer input amount.', {
      body: result,
    })
  if (!Number.isFinite(Date.parse(quote_!.deadline)))
    throw new OneClickError('1Click quote response contains an invalid deadline.', { body: result })
  if (!Number.isFinite(quote_!.timeEstimate) || quote_!.timeEstimate < 0)
    throw new OneClickError('1Click quote response contains an invalid timeEstimate.', {
      body: result,
    })

  return {
    quote: quote_ as Quote,
    quoteRequest: result.quoteRequest ?? body,
    ...(hasString(result, 'signature') && { signature: result.signature }),
    ...(hasString(result, 'timestamp') && { timestamp: result.timestamp }),
  }
}

function hasString<key extends string>(value: unknown, key: key): value is Record<key, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)[key] === 'string'
  )
}

/**
 * Notifies 1Click of a sent deposit (`POST /v0/deposit/submit`). Optional but
 * recommended after verification — it accelerates deposit detection.
 */
export async function submitDeposit(
  config: Config,
  parameters: { txHash: string; depositAddress: string; memo?: string | undefined },
): Promise<StatusResult> {
  const { depositAddress, memo, txHash } = parameters
  return request<StatusResult>(config, '/v0/deposit/submit', {
    method: 'POST',
    body: { txHash, depositAddress, ...(memo !== undefined && { memo }) },
  })
}

/** Fetches the swap status for a deposit address (`GET /v0/status`). */
export async function getStatus(
  config: Config,
  parameters: {
    depositAddress: string
    depositMemo?: string | undefined
    /** Per-call cap used by pollToTerminal to enforce its total budget. */
    timeoutMs?: number | undefined
    signal?: AbortSignal | undefined
  },
): Promise<StatusResult> {
  const { depositAddress, depositMemo, signal, timeoutMs } = parameters
  return request<StatusResult>(config, '/v0/status', {
    method: 'GET',
    searchParams: {
      depositAddress,
      ...(depositMemo !== undefined && { depositMemo }),
    },
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(signal !== undefined && { signal }),
  })
}

export type PollParameters = {
  depositAddress: string
  depositMemo?: string | undefined
  /** Total time budget. Derive from the challenge window + `timeEstimate` + margin. */
  timeoutMs: number
  /** Delay between polls. @default 2000 */
  intervalMs?: number | undefined
  /** Invoked once per observed status change (not per poll tick). */
  onStatus?: ((status: SwapStatus) => void) | undefined
  signal?: AbortSignal | undefined
}

/**
 * Polls the status endpoint until a terminal status ({@link terminalStatuses})
 * or the time budget is exceeded.
 *
 * Transient transport failures ({@link OneClickUnavailableError}) are retried
 * until the budget runs out; if the budget ends on a failing endpoint the last
 * error is rethrown (so callers surface 5xx, not a false timeout). A budget
 * that ends while the swap is still in flight throws {@link PollTimeoutError}.
 */
export async function pollToTerminal(
  config: Config,
  parameters: PollParameters,
): Promise<StatusResult> {
  const { depositAddress, depositMemo, onStatus, signal, timeoutMs } = parameters
  const intervalMs = parameters.intervalMs ?? 2000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError('pollToTerminal timeoutMs must be a positive finite number.')
  if (!Number.isFinite(intervalMs) || intervalMs < 0)
    throw new RangeError('pollToTerminal intervalMs must be a non-negative finite number.')
  const deadline = Date.now() + timeoutMs

  let lastStatus: SwapStatus | undefined
  let lastError: unknown

  while (true) {
    signal?.throwIfAborted()
    try {
      const remainingMs = Math.max(1, deadline - Date.now())
      const result = await getStatus(config, {
        depositAddress,
        depositMemo,
        timeoutMs: remainingMs,
        signal,
      })
      if (result.status !== lastStatus) onStatus?.(result.status)
      lastStatus = result.status
      lastError = undefined
      if (isTerminal(result.status)) return result
    } catch (error) {
      if (!(error instanceof OneClickUnavailableError)) throw error
      lastError = error
    }

    if (Date.now() + intervalMs > deadline) {
      if (lastStatus !== undefined)
        throw new PollTimeoutError({
          timeoutMs,
          lastStatus,
          ...(lastError !== undefined && { lastError }),
        })
      if (lastError !== undefined) throw lastError
      throw new PollTimeoutError({ timeoutMs })
    }
    await sleep(intervalMs, signal)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted.'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('Aborted.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ---------------------------------------------------------------------------
// Terminal-state → MPP problem mapping (spec §Error Codes)
// ---------------------------------------------------------------------------

/**
 * Maps a non-success terminal status to its MPP problem type:
 * `INCOMPLETE_DEPOSIT` → `payment-insufficient`; `FAILED`/`REFUNDED` →
 * `settlement-failed`. Returns `undefined` for `SUCCESS`. Throws if the
 * status is not terminal.
 */
export function terminalError(result: StatusResult): Errors.PaymentError | undefined {
  const { status, swapDetails } = result
  switch (status) {
    case 'SUCCESS':
      return undefined
    case 'INCOMPLETE_DEPOSIT':
      return new Errors.PaymentInsufficientError({
        reason: swapDetails?.depositedAmount
          ? `deposit of ${swapDetails.depositedAmount} is below the required minimum`
          : 'deposit is below the required minimum',
      })
    case 'FAILED':
    case 'REFUNDED':
      return new SettlementFailedError({
        reason: swapDetails?.refundReason ?? `1Click terminal status ${status}`,
      })
    default:
      throw new Error(`Status "${status}" is not terminal.`)
  }
}

/** Extracts the destination-chain delivery tx hash (the receipt `reference`). */
export function destinationTxHash(result: StatusResult): string | undefined {
  return result.swapDetails?.destinationChainTxHashes?.[0]?.hash
}

/**
 * Checks whether the credential's `payload.hash` is among the origin-chain
 * transactions the backend observed for this deposit address — the spec's
 * status-observation deposit confirmation. Hex hashes compare
 * case-insensitively; other formats (base58, …) compare exactly.
 */
export function matchesOriginTx(result: StatusResult, hash: string, network?: string): boolean {
  const hashes = result.swapDetails?.originChainTxHashes ?? []
  return hashes.some((tx) => txHashEqual(tx.hash, hash, network))
}

function txHashEqual(a: string, b: string, network?: string): boolean {
  if (isHexTxHash(a) && isHexTxHash(b))
    return canonicalTxHash(a, network) === canonicalTxHash(b, network)
  return a === b
}

const hexTxHash = /^(0x)?[0-9a-fA-F]{16,}$/

// CAIP namespaces whose transaction identifiers are canonically hexadecimal.
// Keep base58/base64 families out even when a particular identifier happens
// to contain only hexadecimal characters.
const caseInsensitiveHexHashNamespaces = new Set([
  'bip122',
  'eip155',
  'stellar',
  'starknet',
  'xrpl',
])

function isHexTxHash(hash: string): boolean {
  return hexTxHash.test(hash)
}

/**
 * Canonical transaction-hash representation for replay-store keys. EVM and
 * Bitcoin-family hashes compare case-insensitively and ignore the optional
 * `0x` prefix; base58 and all other chain-native formats remain byte-for-byte
 * exact. When `network` is omitted, an all-hex shape is treated as hex for
 * status matching compatibility.
 */
export function canonicalTxHash(hash: string, network?: string): string {
  const namespace = network ? Types.parseCaip2(network).namespace : undefined
  const usesHexHashes = namespace === undefined || caseInsensitiveHexHashNamespaces.has(namespace)
  if (usesHexHashes && isHexTxHash(hash)) return hash.toLowerCase().replace(/^0x/, '')
  return hash
}

// ---------------------------------------------------------------------------
// CAIP-19 ↔ 1Click asset mapping (token-list driven)
// ---------------------------------------------------------------------------

/**
 * CAIP-2 chain identifier → 1Click blockchain code, for chains whose CAIP-2
 * form is well established. Extensible per-instance via `Config.networks` —
 * unsupported chains need a config entry, not a package release.
 */
export const defaultNetworks: Record<string, string> = {
  'near:mainnet': 'near',
  'eip155:1': 'eth',
  'eip155:10': 'op',
  'eip155:56': 'bsc',
  'eip155:100': 'gnosis',
  'eip155:137': 'pol',
  'eip155:143': 'monad',
  'eip155:196': 'xlayer',
  'eip155:8453': 'base',
  'eip155:42161': 'arb',
  'eip155:43114': 'avax',
  'eip155:80094': 'bera',
  'eip155:534352': 'scroll',
  'bip122:000000000019d6689c085ae165831e93': 'btc',
  'bip122:12a765e31ffd4059bada1e25190f6e98': 'ltc',
  'bip122:1a91e3dace36e2be3bf030a65679fe82': 'doge',
  'bip122:000000000000000000651ef99cb9fcbe': 'bch',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'sol',
  'ton:-239': 'ton',
  'sui:mainnet': 'sui',
  'stellar:pubnet': 'stellar',
  'xrpl:0': 'xrp',
  'starknet:SN_MAIN': 'starknet',
}

/**
 * 1Click blockchain code → SLIP-44 coin type used to render chain-native
 * assets (`<caip2>/slip44:<coinType>`). Extensible via `Config.nativeCoinTypes`.
 */
export const defaultNativeCoinTypes: Record<string, number> = {
  btc: 0,
  ltc: 2,
  doge: 3,
  bch: 145,
  eth: 60,
  base: 60,
  arb: 60,
  op: 60,
  scroll: 60,
  bsc: 714,
  pol: 966,
  gnosis: 700,
  avax: 9000,
  xrp: 144,
  sol: 501,
  ton: 607,
  stellar: 148,
  sui: 784,
}

/** CAIP-19 asset-namespace used when rendering a contract asset for a chain namespace. */
const contractAssetNamespaces: Record<string, string> = {
  eip155: 'erc20',
  near: 'nep141',
  solana: 'token',
}

export type AssetMap = {
  /** Resolves a CAIP-19 asset id to the matching 1Click token, or `undefined`. */
  tokenOf(caip19Id: string): TokenInfo | undefined
  /** Resolves a CAIP-19 asset id to a 1Click asset id, or `undefined`. */
  toAssetId(caip19Id: string): string | undefined
  /** Renders a 1Click asset id as a CAIP-19 asset id, or `undefined` when unmapped. */
  toCaip19(assetId: string): string | undefined
}

/**
 * Builds a bidirectional CAIP-19 ↔ 1Click asset map from the `/v0/tokens`
 * list. Contract assets match on `contractAddress` (case-insensitively for
 * `eip155` chains); `slip44` assets match the chain's token that has no
 * `contractAddress` (chain-native), and only for the chain's canonical coin
 * type — a wrong coin type resolves to nothing rather than silently mapping
 * to the native asset.
 */
export function createAssetMap(tokens: TokenInfo[], config: Config = {}): AssetMap {
  const networks = { ...defaultNetworks, ...config.networks }
  const nativeCoinTypes = { ...defaultNativeCoinTypes, ...config.nativeCoinTypes }
  const blockchainToCaip2 = new Map<string, string>()
  for (const [caip2Id, code] of Object.entries(networks)) {
    if (!blockchainToCaip2.has(code)) blockchainToCaip2.set(code, caip2Id)
  }

  function blockchainOf(caip19Id: string): string | undefined {
    const chain = Types.chainOf(caip19Id)
    return Object.entries(networks).find(([caip2Id]) => Types.networkEqual(caip2Id, chain))?.[1]
  }

  function tokenOf(caip19Id: string): TokenInfo | undefined {
    const parsed = Types.parseCaip19(caip19Id)
    const blockchain = blockchainOf(caip19Id)
    if (!blockchain) return undefined

    if (parsed.assetNamespace === 'slip44') {
      const coinType = nativeCoinTypes[blockchain]
      if (coinType === undefined || parsed.assetReference !== String(coinType)) return undefined
      return tokens.find((token) => token.blockchain === blockchain && !token.contractAddress)
    }

    const caseInsensitive = parsed.chain.namespace === 'eip155'
    const reference = caseInsensitive ? parsed.assetReference.toLowerCase() : parsed.assetReference
    return tokens.find((token) => {
      if (token.blockchain !== blockchain || !token.contractAddress) return false
      const address = caseInsensitive ? token.contractAddress.toLowerCase() : token.contractAddress
      return address === reference
    })
  }

  return {
    tokenOf,
    toAssetId(caip19Id) {
      return tokenOf(caip19Id)?.assetId
    },
    toCaip19(assetId) {
      const token = tokens.find((entry) => entry.assetId === assetId)
      if (!token) return undefined
      const caip2Id = blockchainToCaip2.get(token.blockchain)
      if (!caip2Id) return undefined
      if (token.contractAddress) {
        const namespace = Types.parseCaip2(caip2Id).namespace
        const assetNamespace = contractAssetNamespaces[namespace] ?? 'token'
        return `${caip2Id}/${assetNamespace}:${token.contractAddress}`
      }
      const coinType = nativeCoinTypes[token.blockchain]
      if (coinType === undefined) return undefined
      return `${caip2Id}/slip44:${coinType}`
    },
  }
}
