import { Errors, Method, Store } from 'mppx'

import {
  SettlementFailedError,
  SettlementTimeoutError,
  SettlementUnavailableError,
} from '../Errors.js'
import * as OneClick from '../internal/OneClick.js'
import * as Methods from '../Methods.js'
import * as Types from '../Types.js'

/**
 * Creates a `nearintents` charge method for usage on the server.
 *
 * Each 402 challenge carries a unique single-use 1Click deposit address as
 * `recipient` (minted via a wet `EXACT_OUTPUT` quote and cached with early
 * refresh so the challenge `expires` always precedes the quote deadline).
 * Verification confirms the client's deposit by 1Click status observation,
 * drives the swap to a terminal state, and issues the extended receipt on
 * `SUCCESS`.
 *
 * @example
 * ```ts
 * import { Mppx } from 'mppx/server'
 * import { nearintents } from '@defuse-protocol/nearintents-mpp-sdk/server'
 *
 * const mppx = Mppx.create({
 *   secretKey: process.env.MPP_SECRET_KEY!,
 *   methods: [
 *     nearintents.charge({
 *       originAsset: 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
 *       destinationAsset: 'near:mainnet/nep141:1720…33a1',
 *       destinationRecipient: 'merchant.near',
 *       refundTo: '0x2527D02599Ba641c19FEa793cD0F9a6e8457C317',
 *       amountOut: '1000000',
 *       oneClick: { jwt: process.env.ONE_CLICK_JWT },
 *     }),
 *   ],
 * })
 * ```
 */
export function charge(parameters: charge.Parameters) {
  const {
    amountOut: defaultAmountOut,
    description,
    destinationAsset,
    destinationRecipient,
    externalId,
    oneClick = {},
    originAsset,
    // Distribution-channel attribution: every 1Click swap minted by this
    // payment method carries the "mpp" referral (mirrors the x402 gateway).
    referral = 'mpp',
    refundTo: refundToOption,
    slippageTolerance = 100,
  } = parameters

  // Merchant observability: settlement progress is reported as structured
  // events (the library never logs). A throwing handler must not affect
  // payment processing.
  const emit = (event: charge.Event): void => {
    try {
      parameters.onEvent?.(event)
    } catch {
      // Observer errors are the observer's problem.
    }
  }

  // Fail fast on malformed merchant config (throws at construction time).
  const originNetwork = Types.chainOf(originAsset)
  const destinationNetwork = Types.chainOf(destinationAsset)

  if (typeof refundToOption === 'string' && !refundToOption.trim())
    throw new Error('mpp-nearintents: refundTo must not be empty.')

  const expiresWindowMs = (parameters.expiresWindow ?? 300) * 1000
  const quoteDeadlineBufferMs = (parameters.quoteDeadlineBuffer ?? 900) * 1000
  const pollIntervalMs = parameters.pollInterval ?? 2000

  assertPositiveFinite('expiresWindow', expiresWindowMs)
  assertPositiveFinite('quoteDeadlineBuffer', quoteDeadlineBufferMs)
  assertNonNegativeFinite('pollInterval', pollIntervalMs)
  if (parameters.settlementTimeout !== undefined)
    assertPositiveFinite('settlementTimeout', parameters.settlementTimeout)
  if (!Number.isInteger(slippageTolerance) || slippageTolerance < 0 || slippageTolerance > 10_000)
    throw new Error('mpp-nearintents: slippageTolerance must be an integer from 0 to 10000.')

  const backingStore = parameters.store ?? Store.memory()
  if (typeof backingStore.update !== 'function')
    throw new Error(
      'mpp-nearintents: charge() requires an atomic store with update() for replay protection.',
    )
  const store = Store.from(backingStore as Store.AtomicStore<charge.StoreItemMap>, {
    keyPrefix: parameters.storeKeyPrefix ?? '',
  })

  // Token list is fetched lazily and re-fetched once on an unresolved asset
  // (the list evolves); a persistent miss is a merchant-config error.
  let assetMapPromise: Promise<OneClick.AssetMap> | undefined
  function getAssetMap(refresh = false): Promise<OneClick.AssetMap> {
    if (!assetMapPromise || refresh) {
      assetMapPromise = OneClick.getTokens(oneClick)
        .then((tokens) => OneClick.createAssetMap(tokens, oneClick))
        .catch((error) => {
          assetMapPromise = undefined
          throw error
        })
    }
    return assetMapPromise
  }

  async function resolveAssetId(caip19Id: string): Promise<string> {
    let assetId = (await getAssetMap()).toAssetId(caip19Id)
    if (!assetId) assetId = (await getAssetMap(true)).toAssetId(caip19Id)
    if (!assetId)
      throw new Error(
        `nearintents-mpp-sdk: asset "${caip19Id}" is not on the 1Click token list — check the merchant configuration (or extend oneClick.networks).`,
      )
    return assetId
  }

  const depositKey = (address: string) => `nearintents-mpp-sdk:deposit:${address}` as const
  const quoteKey = (identity: string) => `nearintents-mpp-sdk:quote:${identity}` as const
  const hashKey = (network: string, hash: string) =>
    `nearintents-mpp-sdk:hash:${network}:${OneClick.canonicalTxHash(hash, network)}` as const

  function identityOf(amountOut: string, refundTo: string): string {
    return [
      originAsset,
      destinationAsset,
      amountOut,
      destinationRecipient,
      refundTo,
      slippageTolerance,
      referral,
    ].join('|')
  }

  async function resolveRefundTo(
    capturedRequest: Method.CapturedRequest | undefined,
  ): Promise<string> {
    const value =
      typeof refundToOption === 'function'
        ? await refundToOption({ capturedRequest, originNetwork })
        : refundToOption
    if (!value?.trim())
      throw new Error(
        'mpp-nearintents: refundTo resolver returned no address; the server must know the payer refund address before minting a wet quote.',
      )
    return value
  }

  /**
   * Returns the route's active canonical request, minting a fresh 1Click
   * quote when there is none — or when the cached one is stale (early
   * refresh: a quote is stale once `now + expiresWindow > quote deadline`,
   * so the challenge `expires` always precedes the active quote's deadline).
   */
  async function resolveActiveRequest(
    amountOut: string,
    refundTo: string,
  ): Promise<Types.ChargeRequest> {
    const identity = identityOf(amountOut, refundTo)

    const pointer = await store.get(quoteKey(identity))
    if (pointer && pointer.identity === identity) {
      const deposit = await store.get(depositKey(pointer.depositAddress))
      if (
        deposit &&
        deposit.state === 'active' &&
        deposit.identity === identity &&
        Date.parse(deposit.deadline) > Date.now() + expiresWindowMs
      ) {
        emit({ type: 'quote.reused', depositAddress: deposit.request.recipient })
        return deposit.request
      }
    }

    const [originAssetId, destinationAssetId] = await Promise.all([
      resolveAssetId(originAsset),
      resolveAssetId(destinationAsset),
    ])

    const requestedDeadline = new Date(
      Date.now() + expiresWindowMs + quoteDeadlineBufferMs,
    ).toISOString()
    const { quote } = await OneClick.quote(oneClick, {
      originAsset: originAssetId,
      destinationAsset: destinationAssetId,
      amountOut,
      recipient: destinationRecipient,
      refundTo,
      slippageTolerance,
      deadline: requestedDeadline,
      referral,
    })

    // Spec §Expiry: `expires` MUST be at or before the quote deadline. The
    // backend's deadline is authoritative; if it cannot cover the route's
    // static expires window, the route is misconfigured — fail loud.
    if (Date.parse(quote.deadline) <= Date.now() + expiresWindowMs)
      throw new Error(
        `nearintents-mpp-sdk: 1Click quote deadline (${quote.deadline}) does not cover the route's expires window (${expiresWindowMs / 1000}s) — lower expiresWindow or raise quoteDeadlineBuffer.`,
      )

    const request: Types.ChargeRequest = {
      amount: quote.amountIn,
      currency: originAsset,
      recipient: quote.depositAddress,
      ...(description !== undefined && { description }),
      ...(externalId !== undefined && { externalId }),
      methodDetails: {
        originNetwork,
        destinationNetwork,
        destinationAsset,
        destinationRecipient,
        amountOut,
        minAmountIn: quote.minAmountIn,
        depositMemo: quote.depositMemo ?? null,
        slippageTolerance,
        timeEstimate: quote.timeEstimate,
        refundTo,
        settlementBackend: Types.settlementBackend,
        credentialTypes: [...Types.credentialTypes],
      },
    }

    await store.put(depositKey(quote.depositAddress), {
      identity,
      request,
      deadline: quote.deadline,
      timeEstimate: quote.timeEstimate,
      depositMemo: quote.depositMemo ?? null,
      state: 'active',
    })
    await store.put(quoteKey(identity), { identity, depositAddress: quote.depositAddress })

    emit({
      type: 'quote.minted',
      depositAddress: quote.depositAddress,
      amountIn: quote.amountIn,
      minAmountIn: quote.minAmountIn,
      amountOut,
      deadline: quote.deadline,
      timeEstimate: quote.timeEstimate,
    })

    return request
  }

  /** Marks a deposit spent and drops the cache pointer so the next 402 mints fresh. */
  async function retireDeposit(depositAddress: string, identity: string): Promise<void> {
    await store.update(depositKey(depositAddress), (current) => {
      if (!current) return { op: 'noop', result: undefined }
      return { op: 'set', value: { ...current, state: 'settled' }, result: undefined }
    })
    await store.update(quoteKey(identity), (current) => {
      if (current?.depositAddress !== depositAddress) return { op: 'noop', result: undefined }
      return { op: 'delete', result: undefined }
    })
  }

  /** Atomically claims `hash` as in-flight. Expired leases are reclaimable. */
  async function claimHash(
    network: string,
    hash: string,
    leaseUntil: number,
  ): Promise<'claimed' | 'inflight' | 'consumed'> {
    return store.update(hashKey(network, hash), (current) => {
      if (current?.state === 'consumed') return { op: 'noop', result: 'consumed' }
      if (current?.state === 'inflight' && current.leaseUntil > Date.now())
        return { op: 'noop', result: 'inflight' }
      return { op: 'set', value: { state: 'inflight', leaseUntil }, result: 'claimed' }
    })
  }

  return Method.toServer<typeof Methods.charge, charge.Defaults>(Methods.charge, {
    // Valid canonical placeholder — replaced by the request hook on every
    // real path; only the fallback challenge (request hook threw a
    // PaymentError) ever serializes it.
    defaults: {
      amount: '0',
      currency: originAsset,
      recipient: 'unavailable',
      ...(description !== undefined && { description }),
      ...(externalId !== undefined && { externalId }),
      methodDetails: {
        originNetwork,
        destinationNetwork,
        destinationAsset,
        destinationRecipient,
        amountOut: defaultAmountOut ?? '0',
        minAmountIn: '0',
        depositMemo: null,
        slippageTolerance,
        refundTo: typeof refundToOption === 'string' ? refundToOption : 'payer-supplied',
        settlementBackend: Types.settlementBackend,
        credentialTypes: [...Types.credentialTypes],
      },
    } as charge.Defaults,

    // Spec §Challenge Binding: the deposit address, amount, and source asset
    // are challenge-specific. Binding them means a rotated quote yields a
    // binding mismatch → 402 with a fresh challenge (the client-recovery flow).
    stableBinding(request) {
      const { amount, currency, methodDetails, recipient } = request
      return {
        amount,
        currency,
        originNetwork: methodDetails.originNetwork,
        recipient,
        refundTo: methodDetails.refundTo,
      }
    },

    async request({ capturedRequest, credential, request }) {
      const amountOut =
        (request.methodDetails as Partial<Types.MethodDetails> | undefined)?.amountOut ??
        defaultAmountOut
      if (!amountOut || amountOut === '0')
        throw new Error(
          'nearintents-mpp-sdk: amountOut is required — set it in charge({ amountOut }) or per route via methodDetails.amountOut.',
        )

      // Credential-bearing request: resolve the quote the challenge was
      // minted from (store lookup keyed by deposit address) — never mint a
      // quote for a credential. Note the echoed challenge is NOT yet
      // HMAC-verified here; the lookup returns OUR stored request, so a
      // forged recipient can at most cause a cache-limited quote refresh.
      if (credential) {
        const recipient = (credential.challenge.request as Partial<Types.ChargeRequest>)?.recipient
        if (typeof recipient === 'string' && recipient) {
          const deposit = await store.get(depositKey(recipient))
          if (
            deposit &&
            deposit.state === 'active' &&
            deposit.identity === identityOf(amountOut, deposit.request.methodDetails.refundTo) &&
            Date.parse(deposit.deadline) > Date.now()
          )
            return deposit.request
        }
        // Unknown, spent, or expired deposit address: fall through to the
        // current active quote. The stableBinding mismatch then yields a 402
        // carrying this fresh challenge — the spec's client-recovery flow.
      }

      return resolveActiveRequest(amountOut, await resolveRefundTo(capturedRequest))
    },

    async verify({ credential, request }) {
      const { challenge } = credential
      const resolved = (() => {
        const parsed = Methods.charge.schema.request.safeParse(request)
        if (parsed.success) return parsed.data
        return request as unknown as Types.ChargeRequest
      })()

      const payload = credential.payload
      if (payload.type !== 'hash')
        throw new Errors.InvalidPayloadError({ reason: 'only "hash" credentials are accepted' })
      const hash = payload.hash

      // Spec §Verification step 4: the deposit address must correspond to an
      // active, non-expired, non-settled quote in the server's state.
      const recipient = resolved.recipient
      const deposit = await store.get(depositKey(recipient))
      if (!deposit)
        throw new Errors.InvalidChallengeError({
          id: challenge.id,
          reason: 'no active quote for this deposit address',
        })
      if (deposit.state === 'settled')
        throw new Errors.InvalidChallengeError({
          id: challenge.id,
          reason: 'the quote for this deposit address is already settled',
        })
      if (Date.parse(deposit.deadline) <= Date.now())
        throw new Errors.PaymentExpiredError({ expires: deposit.deadline })

      const settlementTimeoutMs =
        (parameters.settlementTimeout ?? deposit.timeEstimate + 120) * 1000

      // Spec §Verification step 5 / §Replay: claim the hash in-flight
      // atomically; consume permanently only on a terminal settlement state.
      // The lease covers the settlement budget so a crashed settlement never
      // strands a legitimate retry.
      const claim = await claimHash(
        resolved.methodDetails.originNetwork,
        hash,
        Date.now() + settlementTimeoutMs + 60_000,
      )
      if (claim === 'consumed')
        throw new Errors.VerificationFailedError({
          reason: 'transaction hash has already been used',
        })
      if (claim === 'inflight')
        throw new Errors.VerificationFailedError({
          reason: 'settlement for this transaction hash is already in progress',
        })

      let hashOutcome: 'release' | 'consume' = 'release'
      try {
        // Spec §Settlement step 1: notify the backend (optional accelerator;
        // status observation below is authoritative, so failures are benign).
        const accepted = await OneClick.submitDeposit(oneClick, {
          txHash: hash,
          depositAddress: recipient,
          ...(deposit.depositMemo !== null && { memo: deposit.depositMemo }),
        }).then(
          () => true,
          () => false,
        )
        emit({ type: 'deposit.submitted', depositAddress: recipient, originTxHash: hash, accepted })

        // Spec §Settlement step 2 + §Verification step 3: poll to a terminal
        // status; the backend detecting a qualifying deposit at `recipient`
        // IS the deposit confirmation (status-observation mode).
        const status = await OneClick.pollToTerminal(oneClick, {
          depositAddress: recipient,
          ...(deposit.depositMemo !== null && { depositMemo: deposit.depositMemo }),
          timeoutMs: settlementTimeoutMs,
          intervalMs: pollIntervalMs,
          onStatus: (observed) =>
            emit({ type: 'settlement.status', depositAddress: recipient, status: observed }),
        })

        // Deposit confirmation applies to every terminal outcome. Do not
        // retire the quote or consume an unrelated hash: the real payer must
        // still be able to present the observed transaction after a bad-hash
        // race. Hex hashes are canonicalized by matchesOriginTx; base58 and
        // other formats remain case-sensitive.
        if (!OneClick.matchesOriginTx(status, hash, resolved.methodDetails.originNetwork))
          throw new Errors.VerificationFailedError({
            reason:
              'the presented transaction hash is not among the deposits observed for this address',
          })

        // Observability: report the terminal state (retirement is handled per
        // outcome below, not here — a bad-hash race must not spend the quote).
        emit({
          type: 'settlement.terminal',
          depositAddress: recipient,
          originTxHash: hash,
          status: status.status,
          ...(OneClick.destinationTxHash(status) !== undefined && {
            destinationTxHash: OneClick.destinationTxHash(status),
          }),
        })

        if (status.status === 'SUCCESS') {
          const reference =
            OneClick.destinationTxHash(status) ?? status.swapDetails?.nearTxHashes?.[0]
          // The merchant has been paid at this point; a missing reference is
          // a backend anomaly worth failing loudly on (500), not a 402.
          if (!reference)
            throw new Error(
              `nearintents-mpp-sdk: swap for ${recipient} reached SUCCESS but reported no settlement transaction hash.`,
            )
          const receipt = Types.toReceipt({
            challengeId: challenge.id,
            reference,
            originTxHash: hash,
            destinationNetwork: resolved.methodDetails.destinationNetwork,
            ...(resolved.externalId !== undefined && { externalId: resolved.externalId }),
          })
          emit({
            type: 'receipt.issued',
            challengeId: challenge.id,
            depositAddress: recipient,
            originTxHash: hash,
            reference,
          })
          // Retire only after the receipt is complete. If the backend reports
          // SUCCESS before its settlement reference is indexed, the same
          // credential can be retried instead of being stranded.
          await retireDeposit(recipient, deposit.identity)
          hashOutcome = 'consume'
          return receipt
        }

        // Non-success terminal (FAILED/REFUNDED/INCOMPLETE_DEPOSIT): the
        // deposit is refunded to refundTo and the hash can never deliver —
        // consume it. The client recovers with a fresh challenge.
        await retireDeposit(recipient, deposit.identity)
        hashOutcome = 'consume'
        throw (
          OneClick.terminalError(status) ??
          new SettlementFailedError({ reason: `unexpected terminal status ${status.status}` })
        )
      } catch (error) {
        // Backend unavailability / settlement timeout: 5xx, never
        // verification-failed; do not settle, release the claim so the same
        // credential can be re-presented.
        if (error instanceof OneClick.OneClickUnavailableError) {
          emit({
            type: 'settlement.suspended',
            depositAddress: recipient,
            originTxHash: hash,
            reason: 'unavailable',
          })
          throw new SettlementUnavailableError({ reason: error.message })
        }
        if (error instanceof OneClick.PollTimeoutError) {
          emit({
            type: 'settlement.suspended',
            depositAddress: recipient,
            originTxHash: hash,
            reason: 'timeout',
          })
          throw new SettlementTimeoutError({ timeoutMs: settlementTimeoutMs })
        }
        throw error
      } finally {
        const key = hashKey(resolved.methodDetails.originNetwork, hash)
        if (hashOutcome === 'consume') await store.put(key, { state: 'consumed' })
        else await store.delete(key)
      }
    },
  })
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`mpp-nearintents: ${name} must be a positive finite number.`)
}

function assertNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`mpp-nearintents: ${name} must be a non-negative finite number.`)
}

export declare namespace charge {
  /**
   * Structured settlement-progress events for merchant observability (wire
   * them to your logger via `charge({ onEvent })`). All referenced values —
   * deposit addresses and tx hashes — are public on-chain data. Outcome-level
   * events (`payment.success` / `payment.failed` / `challenge.created`) come
   * from mppx itself via `mppx.on(...)`.
   */
  type Event =
    | {
        type: 'quote.minted'
        depositAddress: string
        amountIn: string
        minAmountIn: string
        amountOut: string
        deadline: string
        timeEstimate: number
      }
    | { type: 'quote.reused'; depositAddress: string }
    | { type: 'deposit.submitted'; depositAddress: string; originTxHash: string; accepted: boolean }
    | { type: 'settlement.status'; depositAddress: string; status: OneClick.SwapStatus }
    | {
        type: 'settlement.terminal'
        depositAddress: string
        originTxHash: string
        status: OneClick.SwapStatus
        destinationTxHash?: string | undefined
      }
    | {
        type: 'settlement.suspended'
        depositAddress: string
        originTxHash: string
        /** The credential was NOT consumed; the client re-presents it later. */
        reason: 'unavailable' | 'timeout'
      }
    | {
        type: 'receipt.issued'
        challengeId: string
        depositAddress: string
        originTxHash: string
        reference: string
      }

  type DepositState = {
    identity: string
    request: Types.ChargeRequest
    /** Quote deadline (ISO 8601) — the deposit address validity window. */
    deadline: string
    timeEstimate: number
    depositMemo: string | null
    state: 'active' | 'settled'
  }

  type HashState = { state: 'inflight'; leaseUntil: number } | { state: 'consumed' }

  type QuotePointer = { identity: string; depositAddress: string }

  type StoreItemMap = {
    [key: `nearintents-mpp-sdk:deposit:${string}`]: DepositState
    [key: `nearintents-mpp-sdk:quote:${string}`]: QuotePointer
    [key: `nearintents-mpp-sdk:hash:${string}`]: HashState
  }

  type Defaults = Types.ChargeRequest

  type Parameters = {
    /** Source asset the client pays with, as CAIP-19. Its chain is the origin network. */
    originAsset: string
    /** Destination asset the merchant receives, as CAIP-19. Its chain is the destination network. */
    destinationAsset: string
    /** Merchant address on the destination chain. */
    destinationRecipient: string
    /**
     * Origin-chain refund address, either fixed or resolved before each wet
     * quote. Prefer a resolver backed by authenticated payer context (or a
     * validated HTTP header) so failed swaps return funds directly to the
     * payer. A resolved address is quote-bound and echoed in the challenge.
     */
    refundTo:
      | string
      | ((parameters: {
          /** Captured transport request. HTTP integrations can read a payer hint from headers. */
          capturedRequest?: Method.CapturedRequest | undefined
          /** CAIP-2 origin network whose address format the resolver must return. */
          originNetwork: string
        }) => string | Promise<string>)
    /**
     * Default price: exact amount the merchant receives, in base units of
     * `destinationAsset` (EXACT_OUTPUT). Overridable per route via
     * `methodDetails.amountOut`.
     */
    amountOut?: string | undefined
    /** Slippage tolerance in basis points, applied to the input side. @default 100 */
    slippageTolerance?: number | undefined
    /**
     * 1Click referral identifier (distribution-channel attribution / fee
     * tracking) attached to every quote this method mints. @default "mpp"
     */
    referral?: string | undefined
    /**
     * Settlement-progress observer ({@link charge.Event}) — the library never
     * logs on its own; wire this to your logger. Handler errors are swallowed
     * and never affect payment processing.
     */
    onEvent?: ((event: Event) => void) | undefined
    /** Human-readable payment description for challenges. */
    description?: string | undefined
    /** Merchant reference echoed into challenges and receipts. */
    externalId?: string | undefined
    /** 1Click API configuration (base URL, JWT, fetch, network tables). */
    oneClick?: OneClick.Config | undefined
    /**
     * Atomic store for the quote cache and replay protection (in-flight /
     * consumed hashes). Defaults to in-memory; use a shared store (e.g.
     * redis) in production and multi-instance deployments — atomicity is a
     * hard requirement for the replay guarantees.
     */
    store?: Store.AtomicStore | undefined
    /** Prefix prepended to every store key. */
    storeKeyPrefix?: string | undefined
    /**
     * The route's challenge-expiry window in seconds.
     *
     * **MUST equal the `expires` you pass to the mppx route** (`mppx.charge({
     * expires })`). mppx computes the challenge `expires` per route, before
     * this method's `request` hook runs and unreadable by it, so the window
     * cannot be auto-derived — it is a manual coupling the caller owns.
     *
     * It sizes the quote-cache early refresh so the invariant "advertised
     * `expires` ≤ quote deadline" holds. If the route `expires` is set
     * **larger** than `expiresWindow`, that invariant can break near the
     * cache-staleness boundary: a challenge may advertise an `expires` after
     * the quote deadline, and a client depositing just before `expires` lands
     * after the deadline and is refunded rather than swapped (no fund loss —
     * the client recovers with a fresh challenge — but wasted gas and a silent
     * UX failure). Keep the two values identical. Size to the origin chain
     * (minutes for fast chains, 45–60 min for BTC).
     * @default 300
     */
    expiresWindow?: number | undefined
    /**
     * Extra seconds of quote (deposit-address) validity requested beyond the
     * expires window, so deposits made just before `expires` still settle
     * within the quote's validity. @default 900
     */
    quoteDeadlineBuffer?: number | undefined
    /**
     * Settlement budget in seconds verify() will hold the request while
     * polling for a terminal status. @default quote timeEstimate + 120
     */
    settlementTimeout?: number | undefined
    /** Status poll interval in milliseconds. @default 2000 */
    pollInterval?: number | undefined
  }
}
