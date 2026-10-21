import { Challenge, Credential } from 'mppx'

import * as Methods from '../src/Methods.js'
import type * as Types from '../src/Types.js'

/**
 * Spec-conformance wire vectors, generated THROUGH mppx primitives
 * (Challenge.fromMethod / Credential.serialize / Receipt.from) — never
 * hand-encoded. Request payloads are verbatim from the spec's Examples
 * appendix (docs/spec/draft-nearintents-charge-01.md).
 */

export const secretKey = 'vector-secret-key'
export const realm = 'api.example.com'

/** Spec §Examples — "Cross-Chain Charge — USDC on Arbitrum to merchant on NEAR". */
export const arbitrumUsdcRequest: Types.ChargeRequest = {
  amount: '1005000',
  currency: 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  recipient: '0x76b4c56085ED136a8744D52bE956396624a730E8',
  description: 'Cross-chain premium data access',
  externalId: 'order_12345',
  methodDetails: {
    originNetwork: 'eip155:42161',
    destinationNetwork: 'near:mainnet',
    destinationAsset:
      'near:mainnet/nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    destinationRecipient: 'merchant.near',
    amountOut: '1000000',
    minAmountIn: '1000000',
    depositMemo: null,
    slippageTolerance: 100,
    timeEstimate: 120,
    refundTo: '0x2527D02599Ba641c19FEa793cD0F9a6e8457C317',
    settlementBackend: 'near-intents',
    credentialTypes: ['hash'],
  },
}

/** Spec §Examples — "Native BTC origin". */
export const btcRequest: Types.ChargeRequest = {
  amount: '38000',
  currency: 'bip122:000000000019d6689c085ae165831e93/slip44:0',
  recipient: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
  methodDetails: {
    originNetwork: 'bip122:000000000019d6689c085ae165831e93',
    destinationNetwork: 'near:mainnet',
    destinationAsset:
      'near:mainnet/nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    destinationRecipient: 'merchant.near',
    amountOut: '1000000',
    minAmountIn: '37500',
    depositMemo: null,
    slippageTolerance: 150,
    timeEstimate: 1800,
    refundTo: 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h',
    settlementBackend: 'near-intents',
    credentialTypes: ['hash'],
  },
}

/** Spec §Examples — the credential's origin-chain deposit tx hash. */
export const arbitrumDepositTxHash =
  '0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a'

/** Spec §Examples — payer identity (`did:pkh` with the CAIP-2 origin network). */
export const arbitrumSource = 'did:pkh:eip155:42161:0x2527D02599Ba641c19FEa793cD0F9a6e8457C317'

/** Spec §Examples — the receipt's destination-chain (NEAR) delivery tx hash. */
export const nearDestinationTxHash = 'FtChYxxQh1k6vKjQ9wq5q1f8s2n3p4r5t6u7v8w9x0yz'

/** Builds an HMAC-bound challenge for a vector request through Challenge.fromMethod. */
export function makeChallenge(request: Types.ChargeRequest, options: { expires?: string } = {}) {
  return Challenge.fromMethod(Methods.charge, {
    realm,
    request,
    secretKey,
    expires: options.expires ?? new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  })
}

/** Builds a serialized push-mode credential (Authorization header value). */
export function makeCredentialHeader(
  challenge: ReturnType<typeof makeChallenge>,
  options: { hash: string; source?: string },
) {
  return Credential.serialize(
    Credential.from({
      challenge,
      payload: { type: 'hash', hash: options.hash },
      ...(options.source && { source: options.source }),
    }),
  )
}
