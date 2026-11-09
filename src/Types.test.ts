import { describe, expect, test } from 'vitest'

import * as Types from './Types.js'

describe('CAIP-2 / CAIP-19 helpers', () => {
  test('parseCaip2', () => {
    expect(Types.parseCaip2('eip155:42161')).toEqual({ namespace: 'eip155', reference: '42161' })
    expect(Types.parseCaip2('near:mainnet')).toEqual({ namespace: 'near', reference: 'mainnet' })
    expect(() => Types.parseCaip2('not-caip2')).toThrow('Invalid CAIP-2')
    expect(() => Types.parseCaip2('eip155:42161/erc20:0xabc')).toThrow('Invalid CAIP-2')
  })

  test('parseCaip19 covers the spec table forms', () => {
    // EVM erc20
    expect(
      Types.parseCaip19('eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
    ).toEqual({
      chain: { namespace: 'eip155', reference: '42161' },
      assetNamespace: 'erc20',
      assetReference: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    })
    // Solana token
    expect(
      Types.parseCaip19(
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      ).assetNamespace,
    ).toBe('token')
    // NEAR nep141
    expect(Types.parseCaip19('near:mainnet/nep141:wrap.near').assetReference).toBe('wrap.near')
    // Native slip44 (BTC)
    expect(
      Types.parseCaip19('bip122:000000000019d6689c085ae165831e93/slip44:0').assetNamespace,
    ).toBe('slip44')
    // Informal short identifiers are rejected (spec MUST NOT)
    expect(() => Types.parseCaip19('arb')).toThrow('Invalid CAIP-19')
    expect(() => Types.parseCaip19('0xaf88d065e77c8cC2239327C5EDb3A432268e5831')).toThrow(
      'Invalid CAIP-19',
    )
  })

  test('networkEqual compares by parsed components', () => {
    expect(Types.networkEqual('eip155:42161', 'eip155:42161')).toBe(true)
    expect(Types.networkEqual('eip155:42161', 'eip155:1')).toBe(false)
    expect(Types.networkEqual('eip155:42161', 'near:mainnet')).toBe(false)
    expect(Types.networkEqual('bogus', 'bogus')).toBe(false)
  })

  test('assetEqual: EVM addresses case-insensitive, others exact', () => {
    expect(
      Types.assetEqual(
        'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      ),
    ).toBe(true)
    expect(Types.assetEqual('near:mainnet/nep141:wrap.near', 'near:mainnet/nep141:WRAP.near')).toBe(
      false,
    )
    expect(
      Types.assetEqual(
        'eip155:1/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831',
        'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      ),
    ).toBe(false)
  })

  test('assetEqual compares percent-decoded references', () => {
    expect(
      Types.assetEqual('sui:mainnet/token:0xab%3a%3ausdc', 'sui:mainnet/token:0xab%3A%3Ausdc'),
    ).toBe(true)
    expect(Types.assetEqual('sui:mainnet/token:0xab%ZZ', 'sui:mainnet/token:0xab%ZZ')).toBe(false)
  })

  test('chainOf / toSource', () => {
    expect(Types.chainOf('eip155:42161/erc20:0xabcdef0123456789abcdef0123456789abcdef01')).toBe(
      'eip155:42161',
    )
    expect(Types.toSource({ network: 'eip155:42161', address: '0xAbC' })).toBe(
      'did:pkh:eip155:42161:0xAbC',
    )
  })
})

describe('ChargeRequestSchema cross-field asserts', () => {
  const valid = {
    amount: '1005000',
    currency: 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    recipient: '0x76b4c56085ED136a8744D52bE956396624a730E8',
    methodDetails: {
      originNetwork: 'eip155:42161',
      destinationNetwork: 'near:mainnet',
      destinationAsset: 'near:mainnet/nep141:wrap.near',
      destinationRecipient: 'merchant.near',
      amountOut: '1000000',
      minAmountIn: '1000000',
      refundTo: '0x2527D02599Ba641c19FEa793cD0F9a6e8457C317',
    },
  }

  test('accepts a minimal valid request (optionals omitted)', () => {
    expect(Types.ChargeRequestSchema.parse(valid)).toEqual(valid)
  })

  test('rejects currency chain ≠ originNetwork', () => {
    expect(() =>
      Types.ChargeRequestSchema.parse({
        ...valid,
        methodDetails: { ...valid.methodDetails, originNetwork: 'eip155:1' },
      }),
    ).toThrow(/originNetwork/)
  })

  test('rejects destinationAsset chain ≠ destinationNetwork', () => {
    expect(() =>
      Types.ChargeRequestSchema.parse({
        ...valid,
        methodDetails: { ...valid.methodDetails, destinationNetwork: 'eip155:8453' },
      }),
    ).toThrow(/destinationNetwork/)
  })

  test('rejects non-atomic amounts and informal asset ids', () => {
    expect(() => Types.ChargeRequestSchema.parse({ ...valid, amount: '1.005' })).toThrow()
    expect(() => Types.ChargeRequestSchema.parse({ ...valid, currency: 'USDC' })).toThrow()
  })

  test('malformed asset ids fail as zod validation issues, never raw exceptions', () => {
    // safeParse must return { success: false } — a plain Error escaping the
    // schema would surface as an HTTP 500 instead of a 402 problem response.
    for (const invalid of [
      { ...valid, currency: 'USDC' },
      { ...valid, methodDetails: { ...valid.methodDetails, destinationAsset: 'wNEAR' } },
    ]) {
      const result = Types.ChargeRequestSchema.safeParse(invalid)
      expect(result.success).toBe(false)
    }
  })

  test('rejects credential types other than "hash"', () => {
    expect(() =>
      Types.ChargeRequestSchema.parse({
        ...valid,
        methodDetails: { ...valid.methodDetails, credentialTypes: ['signature'] },
      }),
    ).toThrow()
    expect(() =>
      Types.ChargeRequestSchema.parse({
        ...valid,
        methodDetails: { ...valid.methodDetails, credentialTypes: [] },
      }),
    ).toThrow()
  })

  test('rejects a settlementBackend other than "near-intents"', () => {
    expect(() =>
      Types.ChargeRequestSchema.parse({
        ...valid,
        methodDetails: { ...valid.methodDetails, settlementBackend: 'other' },
      }),
    ).toThrow()
  })
})

describe('HashPayloadSchema', () => {
  test('accepts the push-mode payload, rejects other types', () => {
    expect(Types.HashPayloadSchema.parse({ type: 'hash', hash: '0xabc' })).toEqual({
      type: 'hash',
      hash: '0xabc',
    })
    expect(() => Types.HashPayloadSchema.parse({ type: 'signature', hash: '0xabc' })).toThrow()
    expect(() => Types.HashPayloadSchema.parse({ type: 'hash', hash: '' })).toThrow()
  })
})
