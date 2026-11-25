import { Challenge, Credential } from 'mppx'
import { describe, expect, test } from 'vitest'

import { arbitrumUsdcRequest, btcRequest, makeChallenge, secretKey } from '../../test/vectors.js'
import type * as Types from '../Types.js'
import { charge } from './Charge.js'

const HASH = '0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a'

function createCredential(
  method: ReturnType<typeof charge>,
  challenge: ReturnType<typeof makeChallenge>,
  context?: { hash?: string; walletClient?: charge.EvmWalletClient },
) {
  return method.createCredential({ challenge, context } as never)
}

type SentTransaction = {
  to: string
  value?: bigint | undefined
  data?: string | undefined
}

function fakeWallet(
  options: {
    chainId?: number
    address?: string
    revert?: boolean
    waitError?: Error
    minedHash?: string
  } = {},
): {
  wallet: charge.EvmWalletClient
  sent: SentTransaction[]
} {
  const sent: SentTransaction[] = []
  const wallet: charge.EvmWalletClient = {
    account: { address: options.address ?? '0x2527D02599Ba641c19FEa793cD0F9a6e8457C317' },
    chain: { id: options.chainId ?? 42161 },
    async sendTransaction(args) {
      sent.push({ to: args.to, value: args.value, data: args.data })
      return HASH
    },
    async waitForTransactionReceipt() {
      if (options.waitError) throw options.waitError
      return {
        status: options.revert ? 'reverted' : 'success',
        ...(options.minedHash && { transactionHash: options.minedHash }),
      }
    },
  }
  return { wallet, sent }
}

describe('createCredential with context.hash (bring-your-own-broadcast)', () => {
  test('produces a spec-conformant push-mode credential', async () => {
    const method = charge({ source: 'did:pkh:eip155:42161:0xPayer' })
    const challenge = makeChallenge(arbitrumUsdcRequest)
    const header = await createCredential(method, challenge, { hash: HASH })

    const credential = Credential.deserialize<Types.HashPayload>(header)
    expect(credential.payload).toEqual({ type: 'hash', hash: HASH })
    expect(credential.source).toBe('did:pkh:eip155:42161:0xPayer')
    expect(credential.challenge).toEqual(challenge)
    expect(Challenge.verify(credential.challenge, { secretKey })).toBe(true)
  })

  test('refuses to pay past expires (spec §Expiry MUST)', async () => {
    const method = charge()
    const challenge = makeChallenge(arbitrumUsdcRequest, {
      expires: new Date(Date.now() - 1000).toISOString(),
    })
    await expect(createCredential(method, challenge, { hash: HASH })).rejects.toThrow(/expired/i)
  })

  test('throws when no payment path is configured', async () => {
    const method = charge()
    const challenge = makeChallenge(arbitrumUsdcRequest)
    await expect(createCredential(method, challenge)).rejects.toThrow(/no way to pay/)
  })
})

describe('payment policy (client safety surface)', () => {
  const challenge = () => makeChallenge(arbitrumUsdcRequest)

  test('allowedOriginNetworks / allowedCurrencies allowlists', async () => {
    await expect(
      createCredential(charge({ policy: { allowedOriginNetworks: ['eip155:1'] } }), challenge(), {
        hash: HASH,
      }),
    ).rejects.toThrow(/origin network/)

    await expect(
      createCredential(
        charge({ policy: { allowedCurrencies: ['near:mainnet/nep141:wrap.near'] } }),
        challenge(),
        { hash: HASH },
      ),
    ).rejects.toThrow(/currency/)

    // Case-insensitive EVM comparison admits the lowercase form.
    const ok = charge({
      policy: {
        allowedOriginNetworks: ['eip155:42161'],
        allowedCurrencies: ['eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831'],
      },
    })
    await expect(createCredential(ok, challenge(), { hash: HASH })).resolves.toBeDefined()
  })

  test('maxAmountIn caps by asset, and doubles as an allowlist', async () => {
    const capped = charge({
      policy: { maxAmountIn: { [arbitrumUsdcRequest.currency]: '1000000' } },
    })
    // Challenge asks 1005000 > 1000000 cap.
    await expect(createCredential(capped, challenge(), { hash: HASH })).rejects.toThrow(/cap/)

    const roomy = charge({
      policy: { maxAmountIn: { [arbitrumUsdcRequest.currency]: '2000000' } },
    })
    await expect(createCredential(roomy, challenge(), { hash: HASH })).resolves.toBeDefined()

    const unlisted = charge({
      policy: { maxAmountIn: { 'near:mainnet/nep141:wrap.near': '1' } },
    })
    await expect(createCredential(unlisted, challenge(), { hash: HASH })).rejects.toThrow(
      /no maxAmountIn entry/,
    )
  })

  test('expectedDestination pins the merchant leg', async () => {
    const wrongRecipient = charge({
      policy: { expectedDestination: { destinationRecipient: 'other.near' } },
    })
    await expect(createCredential(wrongRecipient, challenge(), { hash: HASH })).rejects.toThrow(
      /destination recipient/,
    )

    const pinned = charge({
      policy: {
        expectedDestination: {
          destinationAsset: arbitrumUsdcRequest.methodDetails.destinationAsset,
          destinationRecipient: 'merchant.near',
          amountOut: '1000000',
        },
      },
    })
    await expect(createCredential(pinned, challenge(), { hash: HASH })).resolves.toBeDefined()
  })

  test('expectedRefundTo pins refunds for bring-your-own broadcast paths', async () => {
    const payerControlled = charge({
      policy: { expectedRefundTo: arbitrumUsdcRequest.methodDetails.refundTo.toLowerCase() },
    })
    await expect(
      createCredential(payerControlled, challenge(), { hash: HASH }),
    ).resolves.toBeDefined()

    const wrongRefund = charge({
      policy: { expectedRefundTo: '0x1111111111111111111111111111111111111111' },
    })
    await expect(createCredential(wrongRefund, challenge(), { hash: HASH })).rejects.toThrow(
      /refund address/,
    )
  })

  test('canHandleChallenge reflects method identity and policy', () => {
    const method = charge({ policy: { allowedOriginNetworks: ['eip155:42161'] } })
    expect(method.canHandleChallenge?.({ challenge: makeChallenge(arbitrumUsdcRequest) })).toBe(
      true,
    )

    const other = charge({ policy: { allowedOriginNetworks: ['eip155:1'] } })
    expect(other.canHandleChallenge?.({ challenge: makeChallenge(arbitrumUsdcRequest) })).toBe(
      false,
    )

    const foreign = { ...makeChallenge(arbitrumUsdcRequest), method: 'tempo' }
    expect(method.canHandleChallenge?.({ challenge: foreign as never })).toBe(false)
  })
})

describe('built-in EVM deposit broadcast', () => {
  test('erc20 origin: transfer(recipient, amountIn) calldata to the token contract', async () => {
    const { wallet, sent } = fakeWallet()
    const method = charge({ walletClient: wallet })
    const header = await createCredential(method, makeChallenge(arbitrumUsdcRequest))

    expect(sent).toHaveLength(1)
    expect(sent[0]!.to.toLowerCase()).toBe('0xaf88d065e77c8cc2239327c5edb3a432268e5831')
    expect(sent[0]!.value).toBeUndefined()
    // transfer(0x76b4…730E8, 1005000): selector + padded address + padded amount (0xf55c8).
    expect(sent[0]!.data).toBe(
      '0xa9059cbb' +
        '00000000000000000000000076b4c56085ed136a8744d52be956396624a730e8' +
        '00000000000000000000000000000000000000000000000000000000000f55c8',
    )

    const credential = Credential.deserialize<Types.HashPayload>(header)
    expect(credential.payload.hash).toBe(HASH)
    // source derived from the wallet as did:pkh with the CAIP-2 origin.
    expect(credential.source).toBe(
      'did:pkh:eip155:42161:0x2527D02599Ba641c19FEa793cD0F9a6e8457C317',
    )
  })

  test('erc20 origin: a percent-encoded token reference is paid to the decoded contract', async () => {
    const { wallet, sent } = fakeWallet()
    const method = charge({ walletClient: wallet })
    await createCredential(
      method,
      makeChallenge({
        ...arbitrumUsdcRequest,
        currency: 'eip155:42161/erc20:%30xaf88d065e77c8cc2239327c5edb3a432268e5831',
      }),
    )
    expect(sent[0]!.to).toBe('0xaf88d065e77c8cc2239327c5edb3a432268e5831')
  })

  test('native (slip44) origin: value transfer to the deposit address', async () => {
    const { wallet, sent } = fakeWallet({ chainId: 1 })
    const method = charge({ walletClient: wallet })
    const request: Types.ChargeRequest = {
      amount: '5000000000000000',
      currency: 'eip155:1/slip44:60',
      recipient: '0x76b4c56085ED136a8744D52bE956396624a730E8',
      methodDetails: {
        ...arbitrumUsdcRequest.methodDetails,
        originNetwork: 'eip155:1',
        minAmountIn: '5000000000000000',
      },
    }
    await createCredential(method, makeChallenge(request))

    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('0x76b4c56085ED136a8744D52bE956396624a730E8')
    expect(sent[0]!.value).toBe(5000000000000000n)
    expect(sent[0]!.data).toBeUndefined()
  })

  test('refuses chain mismatch, memo-bearing deposits, non-EVM origins, and reverted deposits', async () => {
    const method = charge({ walletClient: fakeWallet({ chainId: 1 }).wallet })
    await expect(createCredential(method, makeChallenge(arbitrumUsdcRequest))).rejects.toThrow(
      /chain 1/,
    )

    const memoRequest: Types.ChargeRequest = {
      ...arbitrumUsdcRequest,
      methodDetails: { ...arbitrumUsdcRequest.methodDetails, depositMemo: 'memo-1' },
    }
    const arbWallet = charge({ walletClient: fakeWallet().wallet })
    await expect(createCredential(arbWallet, makeChallenge(memoRequest))).rejects.toThrow(/memo/)

    const { btcRequest } = await import('../../test/vectors.js')
    await expect(createCredential(arbWallet, makeChallenge(btcRequest))).rejects.toThrow(
      /eip155 origins/,
    )

    const reverting = charge({ walletClient: fakeWallet({ revert: true }).wallet })
    await expect(createCredential(reverting, makeChallenge(arbitrumUsdcRequest))).rejects.toThrow(
      /reverted/,
    )
  })
})

describe('sendDeposit callback (bring-your-own-chain)', () => {
  test('receives the verified request and its hash is presented', async () => {
    let seen: Types.ChargeRequest | undefined
    const method = charge({
      sendDeposit: async ({ request }) => {
        seen = request
        return 'btc-txid-abc'
      },
    })
    const { btcRequest } = await import('../../test/vectors.js')
    const header = await createCredential(method, makeChallenge(btcRequest))

    expect(seen?.recipient).toBe(btcRequest.recipient)
    expect(Credential.deserialize<Types.HashPayload>(header).payload.hash).toBe('btc-txid-abc')
  })
})

describe('each deposit address is paid at most once', () => {
  const hashOf = (header: string) => Credential.deserialize<Types.HashPayload>(header).payload.hash

  test('a later challenge for a paid address re-presents its hash', async () => {
    const { wallet, sent } = fakeWallet()
    const method = charge({ walletClient: wallet })
    const first = await createCredential(method, makeChallenge(arbitrumUsdcRequest))
    const second = await createCredential(method, makeChallenge(arbitrumUsdcRequest))

    expect(sent).toHaveLength(1)
    expect(hashOf(second)).toBe(hashOf(first))
  })

  test('concurrent challenges for one address share a single deposit', async () => {
    const { wallet, sent } = fakeWallet()
    const method = charge({ walletClient: wallet })
    await Promise.all([
      createCredential(method, makeChallenge(arbitrumUsdcRequest)),
      createCredential(method, makeChallenge(arbitrumUsdcRequest)),
    ])
    expect(sent).toHaveLength(1)
  })

  test('another memo is another deposit, and a failed deposit stays payable', async () => {
    let calls = 0
    const method = charge({
      sendDeposit: async ({ request }) => {
        calls++
        if (calls === 1) throw new Error('broadcast failed')
        return `txid-${request.methodDetails.depositMemo}`
      },
    })
    const withMemo = (depositMemo: string) =>
      makeChallenge({ ...btcRequest, methodDetails: { ...btcRequest.methodDetails, depositMemo } })

    await expect(createCredential(method, withMemo('a'))).rejects.toThrow(/broadcast failed/)
    expect(hashOf(await createCredential(method, withMemo('a')))).toBe('txid-a')
    expect(hashOf(await createCredential(method, withMemo('b')))).toBe('txid-b')
    expect(hashOf(await createCredential(method, withMemo('a')))).toBe('txid-a')
    expect(calls).toBe(3)
  })

  test('payers sharing one instance each pay their own deposit', async () => {
    const a = fakeWallet({ address: '0x000000000000000000000000000000000000000A' })
    const b = fakeWallet({ address: '0x000000000000000000000000000000000000000B' })
    const method = charge()
    await createCredential(method, makeChallenge(arbitrumUsdcRequest), { walletClient: a.wallet })
    await createCredential(method, makeChallenge(arbitrumUsdcRequest), { walletClient: b.wallet })
    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(1)

    // Without an account address the payer is unknown, so nothing is remembered.
    const anonymous = fakeWallet()
    const untracked = charge({ walletClient: { ...anonymous.wallet, account: undefined } })
    await createCredential(untracked, makeChallenge(arbitrumUsdcRequest))
    await createCredential(untracked, makeChallenge(arbitrumUsdcRequest))
    expect(anonymous.sent).toHaveLength(2)
  })

  test('a sent deposit whose confirmation fails is presented again; a reverted one is paid again', async () => {
    const unconfirmed = fakeWallet({ waitError: new Error('timed out') })
    const method = charge({ walletClient: unconfirmed.wallet })
    await expect(createCredential(method, makeChallenge(arbitrumUsdcRequest))).rejects.toThrow(
      /broadcast but its confirmation failed/,
    )
    expect(hashOf(await createCredential(method, makeChallenge(arbitrumUsdcRequest)))).toBe(HASH)
    expect(unconfirmed.sent).toHaveLength(1)

    const reverting = fakeWallet({ revert: true })
    const retried = charge({ walletClient: reverting.wallet })
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(createCredential(retried, makeChallenge(arbitrumUsdcRequest))).rejects.toThrow(
        /reverted/,
      )
    expect(reverting.sent).toHaveLength(2)
  })

  test('the hash of the mined transaction is presented after a wallet speed-up', async () => {
    const minedHash = '0x1111111111111111111111111111111111111111111111111111111111111111'
    const method = charge({ walletClient: fakeWallet({ minedHash }).wallet })
    expect(hashOf(await createCredential(method, makeChallenge(arbitrumUsdcRequest)))).toBe(
      minedHash,
    )
  })
})
