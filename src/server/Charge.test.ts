import { Challenge, Receipt, Store } from 'mppx'
import { Mppx } from 'mppx/server'
import { afterEach, describe, expect, test } from 'vitest'

import { createOneClickMock, type OneClickMock } from '../../test/OneClickMock.js'
import { charge as clientCharge } from '../client/Charge.js'
import type * as Types from '../Types.js'
import { charge } from './Charge.js'

const URL_ = 'https://api.example.com/resource'
const SECRET = 'e2e-secret-key-of-at-least-32-bytes!'
const ARB_USDC = 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const NEAR_USDC =
  'near:mainnet/nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const HASH = '0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a'

let mock: OneClickMock

afterEach(() => {
  mock?.close()
})

async function setup(overrides: Partial<charge.Parameters> = {}) {
  mock = await createOneClickMock()
  const store = Store.memory()
  const method = charge({
    originAsset: ARB_USDC,
    destinationAsset: NEAR_USDC,
    destinationRecipient: 'merchant.near',
    refundTo: '0x2527D02599Ba641c19FEa793cD0F9a6e8457C317',
    amountOut: '1000000',
    oneClick: { baseUrl: mock.url },
    store,
    settlementTimeout: 5,
    pollInterval: 5,
    ...overrides,
  })
  const mppx = Mppx.create({ secretKey: SECRET, methods: [method] })
  const handler = mppx.charge({})
  return { handler, store }
}

type Handler = Awaited<ReturnType<typeof setup>>['handler']

async function get402(handler: Handler) {
  const result = await handler(new Request(URL_))
  expect(result.status).toBe(402)
  if (result.status !== 402) throw new Error('unreachable')
  return Challenge.fromResponse(result.challenge)
}

async function credentialFor(challenge: Awaited<ReturnType<typeof get402>>, hash: string) {
  const client = clientCharge()
  return client.createCredential({ challenge, context: { hash } } as never)
}

async function pay(handler: Handler, challenge: Awaited<ReturnType<typeof get402>>, hash: string) {
  const authorization = await credentialFor(challenge, hash)
  return handler(new Request(URL_, { headers: { authorization } }))
}

async function problemOf(result: Awaited<ReturnType<Handler>>) {
  expect(result.status).toBe(402)
  if (result.status !== 402) throw new Error('unreachable')
  const body = (await result.challenge.clone().json()) as { type: string; status: number }
  return { body, response: result.challenge }
}

describe('402 → deposit → credential → 200 + receipt (success path)', () => {
  test('full flow with a spec-conformant challenge and extended receipt', async () => {
    const { handler } = await setup()
    const challenge = await get402(handler)

    // Challenge surface (spec §Request Schema): unique deposit address as
    // recipient, EXACT_OUTPUT legs, expires present.
    const request = challenge.request as Types.ChargeRequest
    expect(challenge.method).toBe('nearintents')
    expect(challenge.intent).toBe('charge')
    expect(challenge.expires).toBeDefined()
    expect(request.recipient).toBe('mock-deposit-1')
    expect(request.currency).toBe(ARB_USDC)
    expect(request.amount).toBe('1010000') // minAmountIn + 100 bps slippage buffer
    expect(request.methodDetails).toMatchObject({
      originNetwork: 'eip155:42161',
      destinationNetwork: 'near:mainnet',
      destinationAsset: NEAR_USDC,
      destinationRecipient: 'merchant.near',
      amountOut: '1000000',
      minAmountIn: '1000000',
      depositMemo: null,
      settlementBackend: 'near-intents',
      credentialTypes: ['hash'],
      refundTo: '0x2527D02599Ba641c19FEa793cD0F9a6e8457C317',
    })

    const result = await pay(handler, challenge, HASH)
    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error('unreachable')

    const response = result.withReceipt(Response.json({ data: 'paid' }))
    const receipt = Receipt.fromResponse(response) as Types.NearIntentsReceipt
    expect(receipt.method).toBe('nearintents')
    expect(receipt.status).toBe('success')
    expect(receipt.challengeId).toBe(challenge.id)
    expect(receipt.originTxHash).toBe(HASH)
    expect(receipt.reference).toBe('mock-dest-mock-deposit-1')
    expect(receipt.destinationNetwork).toBe('near:mainnet')

    // The deposit notification accelerator was sent.
    expect(mock.requests.some((r) => r.path === '/v0/deposit/submit')).toBe(true)
  })

  test('quote cache: repeated 402s reuse one wet quote (same deposit address)', async () => {
    const { handler } = await setup()
    const first = await get402(handler)
    const second = await get402(handler)
    expect((second.request as Types.ChargeRequest).recipient).toBe(
      (first.request as Types.ChargeRequest).recipient,
    )
    expect(mock.requests.filter((r) => r.path === '/v0/quote')).toHaveLength(1)
  })

  test('every minted quote carries the "mpp" distribution-channel referral by default', async () => {
    const { handler } = await setup()
    await get402(handler)
    const quoteRequest = mock.requests.find((r) => r.path === '/v0/quote')
    expect(quoteRequest).toBeDefined()
    expect((quoteRequest!.body as { referral?: string }).referral).toBe('mpp')
  })

  test('the referral is overridable per method instance', async () => {
    const { handler } = await setup({ referral: 'custom-partner' })
    await get402(handler)
    const quoteRequest = mock.requests.find((r) => r.path === '/v0/quote')
    expect(quoteRequest).toBeDefined()
    expect((quoteRequest!.body as { referral?: string }).referral).toBe('custom-partner')
  })

  test('onEvent reports the settlement lifecycle in order (and survives a throwing handler)', async () => {
    const events: charge.Event[] = []
    const { handler } = await setup({
      onEvent: (event) => {
        events.push(event)
        throw new Error('observer bug — must not affect settlement')
      },
    })
    const challenge = await get402(handler)
    expect((await pay(handler, challenge, HASH)).status).toBe(200)

    const types = events.map((event) => event.type)
    expect(types[0]).toBe('quote.minted')
    expect(types).toContain('deposit.submitted')
    expect(types).toContain('settlement.status')
    expect(types.indexOf('settlement.terminal')).toBeGreaterThan(types.indexOf('deposit.submitted'))
    expect(types.at(-1)).toBe('receipt.issued')

    const terminal = events.find((event) => event.type === 'settlement.terminal')
    expect(terminal).toMatchObject({ status: 'SUCCESS', originTxHash: HASH })
    const issued = events.find((event) => event.type === 'receipt.issued')
    expect(issued).toMatchObject({ challengeId: challenge.id, originTxHash: HASH })
  })

  test('onEvent reports settlement.suspended on timeout (credential not consumed)', async () => {
    const events: charge.Event[] = []
    const { handler } = await setup({
      settlementTimeout: 0.1,
      pollInterval: 10,
      onEvent: (event) => events.push(event),
    })
    mock.script({ statuses: ['PROCESSING'] })
    const challenge = await get402(handler)
    const result = await pay(handler, challenge, HASH)
    expect(result.status).toBe(402)

    expect(events.find((event) => event.type === 'settlement.suspended')).toMatchObject({
      reason: 'timeout',
      originTxHash: HASH,
    })
    expect(events.some((event) => event.type === 'settlement.terminal')).toBe(false)
  })
})

describe('non-success terminals → 402 with mapped problem type + fresh-challenge recovery', () => {
  test.each([
    ['REFUNDED', 'https://paymentauth.org/problems/settlement-failed'],
    ['FAILED', 'https://paymentauth.org/problems/settlement-failed'],
    ['INCOMPLETE_DEPOSIT', 'https://paymentauth.org/problems/payment-insufficient'],
  ] as const)('%s maps to %s', async (outcome, problemType) => {
    const { handler } = await setup()
    mock.script({ outcome })
    const challenge = await get402(handler)

    const { body } = await problemOf(await pay(handler, challenge, HASH))
    expect(body.type).toBe(problemType)

    // Recovery: the next request mints a fresh quote (new deposit address)…
    const fresh = await get402(handler)
    expect((fresh.request as Types.ChargeRequest).recipient).not.toBe(
      (challenge.request as Types.ChargeRequest).recipient,
    )
    // …and the spent hash is permanently consumed, even against the fresh challenge.
    const { body: replayBody } = await problemOf(await pay(handler, fresh, HASH))
    expect(replayBody.type).toBe('https://paymentauth.org/problems/verification-failed')
  })
})

describe('replay protection', () => {
  test('a settled credential cannot be replayed', async () => {
    const { handler } = await setup()
    const challenge = await get402(handler)
    const authorization = await credentialFor(challenge, HASH)

    const first = await handler(new Request(URL_, { headers: { authorization } }))
    expect(first.status).toBe(200)

    const replay = await handler(new Request(URL_, { headers: { authorization } }))
    const { body } = await problemOf(replay)
    expect(body.type).toBe('https://paymentauth.org/problems/invalid-challenge')
  })

  test('a consumed hash is rejected against a brand-new challenge', async () => {
    const { handler } = await setup()
    const challenge = await get402(handler)
    expect((await pay(handler, challenge, HASH)).status).toBe(200)

    const fresh = await get402(handler)
    const { body } = await problemOf(await pay(handler, fresh, HASH))
    expect(body.type).toBe('https://paymentauth.org/problems/verification-failed')
  })

  test('concurrency: the same credential presented twice settles exactly once', async () => {
    const { handler } = await setup()
    const challenge = await get402(handler)
    const authorization = await credentialFor(challenge, HASH)

    const [a, b] = await Promise.all([
      handler(new Request(URL_, { headers: { authorization } })),
      handler(new Request(URL_, { headers: { authorization } })),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 402])
  })

  test('an expired in-flight lease is reclaimable (crashed settlement recovery)', async () => {
    const { handler, store } = await setup()
    const challenge = await get402(handler)
    // Simulate a crashed settlement that left a stale in-flight claim.
    await store.put(`nearintents-mpp-sdk:hash:${HASH.toLowerCase()}`, {
      state: 'inflight',
      leaseUntil: Date.now() - 1000,
    })
    expect((await pay(handler, challenge, HASH)).status).toBe(200)
  })
})

describe('quote rotation → binding mismatch → fresh challenge (client recovery)', () => {
  test('a credential for a rotated (spent) quote gets 402 invalid-challenge with a new deposit address', async () => {
    const { handler, store } = await setup()
    const challenge = await get402(handler)
    const spent = (challenge.request as Types.ChargeRequest).recipient

    // Simulate rotation: the quote behind the echoed challenge is spent.
    const key = `nearintents-mpp-sdk:deposit:${spent}`
    const deposit = (await store.get(key)) as Record<string, unknown>
    await store.put(key, { ...deposit, state: 'settled' })

    const { body, response } = await problemOf(await pay(handler, challenge, HASH))
    expect(body.type).toBe('https://paymentauth.org/problems/invalid-challenge')

    // The 402 carries a freshly minted challenge the client can pay.
    const fresh = Challenge.fromResponse(response)
    const freshRecipient = (fresh.request as Types.ChargeRequest).recipient
    expect(freshRecipient).not.toBe(spent)
    expect((await pay(handler, fresh, HASH)).status).toBe(200)
  })
})

describe('backend unavailability and settlement timeout (5xx, never verification-failed)', () => {
  test('1Click down during settlement → 503; the same credential succeeds after recovery', async () => {
    const { handler } = await setup({ settlementTimeout: 0.2, pollInterval: 20 })
    const challenge = await get402(handler)
    const authorization = await credentialFor(challenge, HASH)

    mock.failNextRequests(1000)
    const down = await handler(new Request(URL_, { headers: { authorization } }))
    expect(down.status).toBe(402) // wrapper status; the HTTP response carries 503
    if (down.status !== 402) throw new Error('unreachable')
    expect(down.challenge.status).toBe(503)

    mock.failNextRequests(0)
    const retry = await handler(new Request(URL_, { headers: { authorization } }))
    expect(retry.status).toBe(200)
  })

  test('swap still in flight past the budget → 504; the same credential succeeds later', async () => {
    const { handler } = await setup({ settlementTimeout: 0.1, pollInterval: 10 })
    mock.script({ statuses: ['PROCESSING'] })
    const challenge = await get402(handler)
    const recipient = (challenge.request as Types.ChargeRequest).recipient
    const authorization = await credentialFor(challenge, HASH)

    const pending = await handler(new Request(URL_, { headers: { authorization } }))
    expect(pending.status).toBe(402)
    if (pending.status !== 402) throw new Error('unreachable')
    expect(pending.challenge.status).toBe(504)

    mock.setStatuses(recipient, ['SUCCESS'])
    const retry = await handler(new Request(URL_, { headers: { authorization } }))
    expect(retry.status).toBe(200)
  })
})

describe('deposit confirmation (spec §Verification step 3)', () => {
  test('SUCCESS whose observed deposits do not include the presented hash → verification-failed; hash stays usable', async () => {
    const { handler } = await setup()
    mock.script({
      originTxHashes: ['0x1111111111111111111111111111111111111111111111111111111111111111'],
    })
    const challenge = await get402(handler)

    const { body } = await problemOf(await pay(handler, challenge, HASH))
    expect(body.type).toBe('https://paymentauth.org/problems/verification-failed')

    // The presented hash settled nothing — it must remain usable for a fresh attempt.
    const fresh = await get402(handler)
    expect((await pay(handler, fresh, HASH)).status).toBe(200)
  })
})

describe('expired challenges', () => {
  test('a deposit presented after expires is rejected with payment-expired', async () => {
    const { handler } = await setup()
    const challenge = await get402(handler)

    const expired = Challenge.fromMethod((await import('../Methods.js')).charge, {
      realm: challenge.realm,
      request: challenge.request as Types.ChargeRequest,
      secretKey: SECRET,
      expires: new Date(Date.now() - 60_000).toISOString(),
    })
    // Built directly (a conformant client refuses to pay past expires).
    const { Credential } = await import('mppx')
    const authorization = Credential.serialize(
      Credential.from({ challenge: expired, payload: { type: 'hash', hash: HASH } }),
    )
    const result = await handler(new Request(URL_, { headers: { authorization } }))
    const { body } = await problemOf(result)
    expect(body.type).toBe('https://paymentauth.org/problems/payment-expired')
  })
})
