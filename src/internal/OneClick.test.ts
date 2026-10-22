import { Errors } from 'mppx'
import { afterEach, describe, expect, test } from 'vitest'

import { createOneClickMock, defaultTokens, type OneClickMock } from '../../test/OneClickMock.js'
import { SettlementFailedError } from '../Errors.js'
import { assetEqual } from '../Types.js'
import * as OneClick from './OneClick.js'

let mock: OneClickMock

afterEach(() => {
  mock?.close()
})

async function setup() {
  mock = await createOneClickMock()
  return { config: { baseUrl: mock.url } satisfies OneClick.Config, mock }
}

const quoteParameters: OneClick.QuoteParameters = {
  originAsset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
  destinationAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  amountOut: '1000000',
  recipient: 'merchant.near',
  refundTo: '0x2527D02599Ba641c19FEa793cD0F9a6e8457C317',
  slippageTolerance: 100,
  deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
}

describe('endpoints', () => {
  test('getTokens returns the token list and sends the JWT when configured', async () => {
    const { config } = await setup()
    const tokens = await OneClick.getTokens({ ...config, jwt: 'test-jwt' })
    expect(tokens).toEqual(defaultTokens)
    expect(mock.requests.at(-1)?.headers.authorization).toBe('Bearer test-jwt')
  })

  test('quote sends the wet EXACT_OUTPUT wire shape and returns the deposit address', async () => {
    const { config } = await setup()
    const result = await OneClick.quote(config, quoteParameters)

    const sent = mock.requests.at(-1)
    expect(sent?.path).toBe('/v0/quote')
    expect(sent?.body).toMatchObject({
      dry: false,
      swapType: 'EXACT_OUTPUT',
      depositType: 'ORIGIN_CHAIN',
      recipientType: 'DESTINATION_CHAIN',
      refundType: 'ORIGIN_CHAIN',
      amount: '1000000',
      slippageTolerance: 100,
    })

    expect(result.quote.depositAddress).toBe('mock-deposit-1')
    // Mock pricing: minAmountIn = amountOut (1:1), amountIn adds 100 bps.
    expect(result.quote.minAmountIn).toBe('1000000')
    expect(result.quote.amountIn).toBe('1010000')
    expect(result.quote.deadline).toBeDefined()
    expect(result.quote.timeEstimate).toBe(120)
  })

  test('quote rejects responses missing critical fields', async () => {
    const { config } = await setup()
    mock.script({ depositAddress: '' })
    await expect(OneClick.quote(config, quoteParameters)).rejects.toThrow(
      /missing "quote.depositAddress"/,
    )
  })

  test('quote rejects malformed amounts, deadlines, and time estimates', async () => {
    const { config } = await setup()

    mock.script({ amountIn: 'not-an-integer' })
    await expect(OneClick.quote(config, quoteParameters)).rejects.toThrow(/non-integer input/)

    mock.script({ deadline: 'not-a-date' })
    await expect(OneClick.quote(config, quoteParameters)).rejects.toThrow(/invalid deadline/)

    mock.script({ timeEstimate: Number.NaN })
    await expect(OneClick.quote(config, quoteParameters)).rejects.toThrow(/invalid timeEstimate/)
  })

  test('4xx maps to OneClickError, 5xx and network failure to OneClickUnavailableError', async () => {
    const { config } = await setup()

    await expect(OneClick.getStatus(config, { depositAddress: 'unknown' })).rejects.toBeInstanceOf(
      OneClick.OneClickError,
    )
    await expect(OneClick.getStatus(config, { depositAddress: 'unknown' })).rejects.toMatchObject({
      status: 404,
    })

    mock.failNextRequests(1)
    await expect(OneClick.getTokens(config)).rejects.toBeInstanceOf(
      OneClick.OneClickUnavailableError,
    )

    await expect(OneClick.getTokens({ baseUrl: 'http://127.0.0.1:1' })).rejects.toBeInstanceOf(
      OneClick.OneClickUnavailableError,
    )
  })

  test('rejects invalid request timeout configuration before network I/O', async () => {
    await expect(OneClick.getTokens({ requestTimeoutMs: 0 })).rejects.toThrow(/positive finite/)
  })

  test('submitDeposit records the tx hash and advances the swap toward the outcome', async () => {
    const { config } = await setup()
    const { quote } = await OneClick.quote(config, quoteParameters)

    const result = await OneClick.submitDeposit(config, {
      txHash: '0xDEADBEEFdeadbeefDEADBEEFdeadbeefDEADBEEFdeadbeefDEADBEEFdeadbeef',
      depositAddress: quote.depositAddress,
    })
    expect(result.status).toBe('KNOWN_DEPOSIT_TX')
    expect(mock.quotes.get(quote.depositAddress)?.submittedTxHashes).toHaveLength(1)
  })
})

describe('pollToTerminal', () => {
  test('polls through PROCESSING to SUCCESS', async () => {
    const { config } = await setup()
    const { quote } = await OneClick.quote(config, quoteParameters)
    await OneClick.submitDeposit(config, {
      txHash: '0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a',
      depositAddress: quote.depositAddress,
    })

    const result = await OneClick.pollToTerminal(config, {
      depositAddress: quote.depositAddress,
      timeoutMs: 5000,
      intervalMs: 5,
    })
    expect(result.status).toBe('SUCCESS')
    expect(OneClick.destinationTxHash(result)).toBe(`mock-dest-${quote.depositAddress}`)
    expect(
      OneClick.matchesOriginTx(
        result,
        '0x9BCFF372AEE89B648C922B850573B22387C31D693079F5E37CD255814E2D615A',
      ),
    ).toBe(true)
  })

  test('scripted non-success terminal outcomes are returned as-is', async () => {
    const { config } = await setup()
    mock.script({ outcome: 'REFUNDED', refundReason: 'solver timeout' })
    const { quote } = await OneClick.quote(config, quoteParameters)
    await OneClick.submitDeposit(config, { txHash: '0x1', depositAddress: quote.depositAddress })

    const result = await OneClick.pollToTerminal(config, {
      depositAddress: quote.depositAddress,
      timeoutMs: 5000,
      intervalMs: 5,
    })
    expect(result.status).toBe('REFUNDED')
    expect(result.swapDetails?.refundReason).toBe('solver timeout')
  })

  test('times out with PollTimeoutError while the swap is still in flight', async () => {
    const { config } = await setup()
    mock.script({ statuses: ['PROCESSING'] })
    const { quote } = await OneClick.quote(config, quoteParameters)

    await expect(
      OneClick.pollToTerminal(config, {
        depositAddress: quote.depositAddress,
        timeoutMs: 40,
        intervalMs: 10,
      }),
    ).rejects.toMatchObject({ name: 'PollTimeoutError', lastStatus: 'PROCESSING' })
  })

  test('retries transient 5xx, and rethrows unavailability if the budget ends failing', async () => {
    const { config } = await setup()
    const { quote } = await OneClick.quote(config, quoteParameters)
    mock.setStatuses(quote.depositAddress, ['SUCCESS'])

    // One transient 500, then success on retry.
    mock.failNextRequests(1)
    const result = await OneClick.pollToTerminal(config, {
      depositAddress: quote.depositAddress,
      timeoutMs: 5000,
      intervalMs: 5,
    })
    expect(result.status).toBe('SUCCESS')

    // Endpoint down for the whole budget → unavailability, not a false timeout.
    mock.failNextRequests(1000)
    await expect(
      OneClick.pollToTerminal(config, {
        depositAddress: quote.depositAddress,
        timeoutMs: 30,
        intervalMs: 10,
      }),
    ).rejects.toBeInstanceOf(OneClick.OneClickUnavailableError)
  })

  test('the total polling budget caps a single hanging status request', async () => {
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return
        const onAbort = () => reject(signal.reason)
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })) as typeof globalThis.fetch
    const started = Date.now()

    await expect(
      OneClick.pollToTerminal(
        { fetch: hangingFetch, requestTimeoutMs: 30_000 },
        { depositAddress: 'hanging-deposit', timeoutMs: 40, intervalMs: 5 },
      ),
    ).rejects.toBeInstanceOf(OneClick.OneClickUnavailableError)
    expect(Date.now() - started).toBeLessThan(500)
  })

  test('rejects invalid timeout and polling interval configuration', async () => {
    const { config } = await setup()
    await expect(
      OneClick.pollToTerminal(config, { depositAddress: 'x', timeoutMs: 0 }),
    ).rejects.toThrow(/positive finite/)
    await expect(
      OneClick.pollToTerminal(config, {
        depositAddress: 'x',
        timeoutMs: 100,
        intervalMs: -1,
      }),
    ).rejects.toThrow(/non-negative finite/)
  })

  test('aborts via signal', async () => {
    const { config } = await setup()
    mock.script({ statuses: ['PROCESSING'] })
    const { quote } = await OneClick.quote(config, quoteParameters)

    const controller = new AbortController()
    const polling = OneClick.pollToTerminal(config, {
      depositAddress: quote.depositAddress,
      timeoutMs: 60_000,
      intervalMs: 50,
      signal: controller.signal,
    })
    controller.abort(new Error('client disconnected'))
    await expect(polling).rejects.toThrow('client disconnected')
  })
})

describe('terminal-state → MPP problem mapping (spec §Error Codes)', () => {
  test('SUCCESS → no error', () => {
    expect(OneClick.terminalError({ status: 'SUCCESS' })).toBeUndefined()
  })

  test('INCOMPLETE_DEPOSIT → payment-insufficient', () => {
    const error = OneClick.terminalError({
      status: 'INCOMPLETE_DEPOSIT',
      swapDetails: { depositedAmount: '900000' },
    })
    expect(error).toBeInstanceOf(Errors.PaymentInsufficientError)
    expect(error?.type).toBe('https://paymentauth.org/problems/payment-insufficient')
    expect(error?.status).toBe(402)
  })

  test.each(['FAILED', 'REFUNDED'] as const)('%s → settlement-failed', (status) => {
    const error = OneClick.terminalError({
      status,
      swapDetails: { refundReason: 'no solver' },
    })
    expect(error).toBeInstanceOf(SettlementFailedError)
    expect(error?.type).toBe('https://paymentauth.org/problems/settlement-failed')
    expect(error?.status).toBe(402)
    expect(error?.message).toContain('no solver')
  })

  test('non-terminal statuses throw', () => {
    expect(() => OneClick.terminalError({ status: 'PROCESSING' })).toThrow('not terminal')
  })
})

describe('tx hash matching', () => {
  test('hex hashes compare case-insensitively, with or without 0x', () => {
    const result: OneClick.StatusResult = {
      status: 'SUCCESS',
      swapDetails: {
        originChainTxHashes: [
          { hash: '0x9BCFF372AEE89B648C922B850573B22387C31D693079F5E37CD255814E2D615A' },
        ],
        destinationChainTxHashes: [{ hash: 'FtChYxxQh1k6vKjQ9wq5q1f8s2n3p4r5t6u7v8w9x0yz' }],
      },
    }
    expect(
      OneClick.matchesOriginTx(
        result,
        '0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a',
      ),
    ).toBe(true)
    expect(
      OneClick.matchesOriginTx(
        result,
        '9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a',
      ),
    ).toBe(true)
    expect(OneClick.matchesOriginTx(result, '0x1111')).toBe(false)
  })

  test('non-hex (base58) hashes compare exactly', () => {
    const result: OneClick.StatusResult = {
      status: 'SUCCESS',
      swapDetails: {
        originChainTxHashes: [{ hash: 'FtChYxxQh1k6vKjQ9wq5q1f8s2n3p4r5t6u7v8w9x0yz' }],
        destinationChainTxHashes: [],
      },
    }
    expect(OneClick.matchesOriginTx(result, 'FtChYxxQh1k6vKjQ9wq5q1f8s2n3p4r5t6u7v8w9x0yz')).toBe(
      true,
    )
    expect(OneClick.matchesOriginTx(result, 'ftchyxxqh1k6vkjq9wq5q1f8s2n3p4r5t6u7v8w9x0yz')).toBe(
      false,
    )
  })

  test('canonical replay keys normalize hex but preserve case-sensitive hashes', () => {
    expect(
      OneClick.canonicalTxHash(
        '0x9BCFF372AEE89B648C922B850573B22387C31D693079F5E37CD255814E2D615A',
        'eip155:42161',
      ),
    ).toBe('9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a')
    expect(
      OneClick.canonicalTxHash('FtChYxxQh1k6vKjQ9wq5q1f8s2n3p4r5t6u7v8w9x0yz', 'near:mainnet'),
    ).toBe('FtChYxxQh1k6vKjQ9wq5q1f8s2n3p4r5t6u7v8w9x0yz')
    // An all-hex string on a case-sensitive network remains exact.
    expect(OneClick.canonicalTxHash('ABCDEF1234567890', 'near:mainnet')).toBe('ABCDEF1234567890')
  })

  test('an all-hex-shaped hash remains case-sensitive on NEAR', () => {
    const result: OneClick.StatusResult = {
      status: 'SUCCESS',
      swapDetails: { originChainTxHashes: [{ hash: 'ABCDEF1234567890' }] },
    }
    expect(OneClick.matchesOriginTx(result, 'abcdef1234567890', 'near:mainnet')).toBe(false)
  })

  test('canonical hex namespaces compare transaction hashes case-insensitively', () => {
    const result: OneClick.StatusResult = {
      status: 'SUCCESS',
      swapDetails: { originChainTxHashes: [{ hash: 'ABCDEF1234567890' }] },
    }
    expect(OneClick.matchesOriginTx(result, 'abcdef1234567890', 'xrpl:0')).toBe(true)
    expect(OneClick.matchesOriginTx(result, '0xabcdef1234567890', 'starknet:SN_MAIN')).toBe(true)
    expect(OneClick.matchesOriginTx(result, 'abcdef1234567890', 'stellar:pubnet')).toBe(true)
  })
})

describe('createAssetMap (CAIP-19 ↔ 1Click asset ids)', () => {
  const map = OneClick.createAssetMap(defaultTokens)

  test('erc20 assets resolve case-insensitively on eip155 chains', () => {
    expect(map.toAssetId('eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831')).toBe(
      'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    )
  })

  test('slip44 assets resolve to the chain-native token (no contractAddress)', () => {
    expect(map.toAssetId('bip122:000000000019d6689c085ae165831e93/slip44:0')).toBe(
      'nep141:btc.omft.near',
    )
    expect(map.toAssetId('eip155:1/slip44:60')).toBe('nep141:eth.omft.near')
  })

  test('slip44 with a non-canonical coin type resolves to nothing, not the native asset', () => {
    // ETH's coin type on the Bitcoin chain must not silently map to BTC.
    expect(map.toAssetId('bip122:000000000019d6689c085ae165831e93/slip44:60')).toBeUndefined()
    expect(map.toAssetId('eip155:1/slip44:0')).toBeUndefined()
  })

  test('nep141 assets resolve exactly on NEAR', () => {
    expect(map.toAssetId('near:mainnet/nep141:wrap.near')).toBe('nep141:wrap.near')
    expect(map.toAssetId('near:mainnet/nep141:WRAP.near')).toBeUndefined()
  })

  test('unmapped chains and unknown assets return undefined', () => {
    expect(map.toAssetId('eip155:999999/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831')).toBe(
      undefined,
    )
    expect(map.toAssetId('eip155:42161/erc20:0x0000000000000000000000000000000000000000')).toBe(
      undefined,
    )
  })

  test('config.networks extends the chain table without a release', () => {
    const extended = OneClick.createAssetMap(
      [
        {
          assetId: 'nep141:custom.omft.near',
          decimals: 18,
          blockchain: 'customchain',
          symbol: 'CST',
          contractAddress: '0x1111111111111111111111111111111111111111',
        },
      ],
      { networks: { 'eip155:424242': 'customchain' } },
    )
    expect(
      extended.toAssetId('eip155:424242/erc20:0x1111111111111111111111111111111111111111'),
    ).toBe('nep141:custom.omft.near')
  })

  test('toCaip19 renders contract and native assets', () => {
    expect(map.toCaip19('nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near')).toBe(
      'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    )
    expect(map.toCaip19('nep141:btc.omft.near')).toBe(
      'bip122:000000000019d6689c085ae165831e93/slip44:0',
    )
    expect(map.toCaip19('nep141:wrap.near')).toBe('near:mainnet/nep141:wrap.near')
    expect(map.toCaip19('nep141:unknown.near')).toBeUndefined()
  })

  test('round-trips through assetEqual for the spec example asset', () => {
    const rendered = map.toCaip19('nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near')
    expect(rendered).toBeDefined()
    // Token list stores lowercase; the spec example uses the checksummed form.
    const specForm = 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
    expect(assetEqual(rendered!, specForm)).toBe(true)
  })
})
