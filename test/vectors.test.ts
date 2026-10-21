import { Challenge, Credential, Receipt } from 'mppx'
import { describe, expect, test } from 'vitest'

import * as Methods from '../src/Methods.js'
import * as Types from '../src/Types.js'
import * as vectors from './vectors.js'

/**
 * Spec-conformance wire vectors (docs/spec/draft-nearintents-charge-01.md).
 * Everything is generated and re-parsed through mppx primitives — the same
 * code paths production challenges/credentials/receipts take.
 */

describe.each([
  ['Arbitrum USDC origin', vectors.arbitrumUsdcRequest],
  ['native BTC origin', vectors.btcRequest],
])('challenge vector: %s', (_label, request) => {
  test('request parses through the method schema unchanged (canonical form)', () => {
    const parsed = Methods.charge.schema.request.parse(request)
    expect(parsed).toEqual(request)
  })

  test('challenge serializes to WWW-Authenticate and round-trips', () => {
    const challenge = vectors.makeChallenge(request)
    const header = Challenge.serialize(challenge)

    // ABNF surface: Payment scheme with the spec's auth-params.
    expect(header).toMatch(/^Payment /)
    expect(header).toContain('method="nearintents"')
    expect(header).toContain('intent="charge"')
    expect(header).toContain(`realm="${vectors.realm}"`)
    expect(header).toContain('request="')
    expect(header).toContain('expires="')

    const roundTripped = Challenge.deserialize(header)
    expect(roundTripped).toEqual(challenge)
    expect(roundTripped.request).toEqual(request)
  })

  test('HMAC-bound id verifies, and any request mutation breaks the binding', () => {
    const challenge = vectors.makeChallenge(request)
    expect(Challenge.verify(challenge, { secretKey: vectors.secretKey })).toBe(true)
    expect(Challenge.verify(challenge, { secretKey: 'wrong-key' })).toBe(false)

    // The deposit address (recipient), amount, and currency are all bound
    // into the challenge id (spec §Challenge Binding).
    for (const mutation of [
      { recipient: 'attacker-address' },
      { amount: '1' },
      { currency: `${request.currency.slice(0, -1)}${request.currency.endsWith('0') ? '1' : '0'}` },
    ]) {
      const tampered = {
        ...challenge,
        request: { ...challenge.request, ...mutation },
      }
      expect(Challenge.verify(tampered, { secretKey: vectors.secretKey })).toBe(false)
    }
  })
})

describe('credential vector (spec §Credential Schema)', () => {
  test('push-mode credential round-trips with challenge echo, payload, and source', () => {
    const challenge = vectors.makeChallenge(vectors.arbitrumUsdcRequest)
    const header = vectors.makeCredentialHeader(challenge, {
      hash: vectors.arbitrumDepositTxHash,
      source: vectors.arbitrumSource,
    })

    expect(header).toMatch(/^Payment [A-Za-z0-9_-]+$/) // base64url-nopad per ABNF

    const credential = Credential.deserialize<Types.HashPayload>(header)
    expect(credential.challenge).toEqual(challenge)
    expect(credential.payload).toEqual({ type: 'hash', hash: vectors.arbitrumDepositTxHash })
    expect(credential.source).toBe(vectors.arbitrumSource)

    // Payload validates against the method's credential schema.
    expect(Methods.charge.schema.credential.payload.parse(credential.payload)).toEqual(
      credential.payload,
    )

    // The echoed challenge still verifies against the server secret.
    expect(Challenge.verify(credential.challenge, { secretKey: vectors.secretKey })).toBe(true)
  })
})

describe('receipt vector (spec §Receipt)', () => {
  test('receipt carries the spec-REQUIRED extension fields through serialize/deserialize', () => {
    const challenge = vectors.makeChallenge(vectors.arbitrumUsdcRequest)
    const receipt = Types.toReceipt({
      challengeId: challenge.id,
      reference: vectors.nearDestinationTxHash,
      originTxHash: vectors.arbitrumDepositTxHash,
      destinationNetwork: 'near:mainnet',
      externalId: 'order_12345',
      timestamp: '2026-06-25T15:12:11Z',
    })

    // Spec receipt table: every REQUIRED field.
    expect(receipt.method).toBe('nearintents')
    expect(receipt.challengeId).toBe(challenge.id)
    expect(receipt.reference).toBe(vectors.nearDestinationTxHash)
    expect(receipt.status).toBe('success')
    expect(receipt.timestamp).toBe('2026-06-25T15:12:11Z')
    expect(receipt.originTxHash).toBe(vectors.arbitrumDepositTxHash)
    expect(receipt.destinationNetwork).toBe('near:mainnet')
    expect(receipt.externalId).toBe('order_12345')

    // Round-trip through the Payment-Receipt header codec preserves the
    // extension fields (requires the patched mppx Receipt — wevm/mppx#612).
    const roundTripped = Receipt.deserialize(Receipt.serialize(receipt)) as Types.NearIntentsReceipt
    expect(roundTripped).toEqual(receipt)
    expect(roundTripped.challengeId).toBe(challenge.id)
    expect(roundTripped.originTxHash).toBe(vectors.arbitrumDepositTxHash)
    expect(roundTripped.destinationNetwork).toBe('near:mainnet')
  })
})
