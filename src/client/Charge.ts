import { Credential, Errors, Expires, Method, z } from 'mppx'

import * as Methods from '../Methods.js'
import * as Types from '../Types.js'

/**
 * Creates a `nearintents` charge method for usage on the client.
 *
 * The client pays before delivery, so the spec's client-side MUSTs are
 * enforced as assertions: the challenge request is schema-validated, `expires`
 * is refused when passed, and the configured payment policy (allowed origin
 * networks/assets, per-asset `maxAmountIn` caps, expected destination leg) is
 * checked before any deposit is made.
 *
 * The deposit itself is provided one of three ways (first match wins):
 * 1. `context.hash` — the deposit was already broadcast; present its tx hash.
 * 2. `sendDeposit` — a callback that pays the origin-chain leg and resolves
 *    with the confirmed tx hash (bring-your-own-chain).
 * 3. `walletClient` (config or context) — built-in EVM broadcast for
 *    `eip155:*` origins (native transfers and ERC-20 `transfer`); any viem
 *    WalletClient extended with public actions satisfies the interface.
 *
 * @example
 * ```ts
 * import { Mppx } from 'mppx/client'
 * import { nearintents } from '@defuse-protocol/nearintents-mpp-sdk/client'
 *
 * const mppx = Mppx.create({
 *   methods: [
 *     nearintents.charge({
 *       walletClient,
 *       policy: {
 *         allowedOriginNetworks: ['eip155:42161'],
 *         maxAmountIn: { 'eip155:42161/erc20:0xaf88…5831': '5000000' },
 *       },
 *     }),
 *   ],
 * })
 * const response = await mppx.fetch('https://api.example.com/paid-resource')
 * ```
 */
export function charge(parameters: charge.Parameters = {}) {
  return Method.toClient(Methods.charge, {
    context: z.object({
      /** Tx hash of an already-broadcast deposit (push mode, bring-your-own-broadcast). */
      hash: z.optional(z.string()),
      /** Per-request EVM wallet client (overrides the configured one). */
      walletClient: z.optional(z.custom<charge.EvmWalletClient>()),
    }),

    canHandleChallenge({ challenge }) {
      if (challenge.method !== Types.paymentMethod || challenge.intent !== Types.chargeIntent)
        return false
      const parsed = Types.ChargeRequestSchema.safeParse(challenge.request)
      if (!parsed.success) return false
      try {
        assertPolicy(parameters.policy, parsed.data)
        return true
      } catch {
        return false
      }
    },

    async createCredential({ challenge, context }) {
      // Spec §Amount and Asset Verification: decode and verify the challenge
      // request before paying; never rely on `description`.
      const request = Types.ChargeRequestSchema.parse(challenge.request)
      // Spec §Expiry: MUST NOT broadcast a deposit after `expires`.
      Expires.assert(challenge.expires, challenge.id)
      assertPolicy(parameters.policy, request)

      const walletClient = context?.walletClient ?? parameters.walletClient
      const hash = await (async () => {
        if (context?.hash) return context.hash
        if (parameters.sendDeposit) return parameters.sendDeposit({ challenge, request })
        if (walletClient) return broadcastEvmDeposit(walletClient, request)
        throw new Error(
          'nearintents-mpp-sdk: no way to pay — provide context.hash, a sendDeposit callback, or a walletClient.',
        )
      })()

      const source =
        parameters.source ??
        (walletClient?.account?.address
          ? Types.toSource({
              network: request.methodDetails.originNetwork,
              address: walletClient.account.address,
            })
          : undefined)

      return Credential.serialize(
        Credential.from({
          challenge,
          payload: { type: 'hash', hash },
          ...(source && { source }),
        }),
      )
    },
  })
}

export declare namespace charge {
  /**
   * Payment policy — the client's safety surface (it pays before delivery).
   * Every configured list is an allowlist; `maxAmountIn` entries double as a
   * currency allowlist when present.
   */
  type Policy = {
    /** CAIP-2 origin networks the client is willing to pay on. */
    allowedOriginNetworks?: readonly string[] | undefined
    /** CAIP-19 source assets the client is willing to pay with. */
    allowedCurrencies?: readonly string[] | undefined
    /**
     * Per-asset deposit caps in base units, keyed by CAIP-19 id. When set,
     * a challenge whose `currency` has no entry is refused.
     */
    maxAmountIn?: Record<string, string> | undefined
    /** Expected merchant destination leg; mismatches are refused. */
    expectedDestination?:
      | {
          destinationAsset?: string | undefined
          destinationRecipient?: string | undefined
          amountOut?: string | undefined
        }
      | undefined
  }

  /**
   * Minimal EVM wallet surface for the built-in `eip155:*` deposit broadcast.
   * A viem `WalletClient` created with `account` and `chain` (so both default
   * per call) and extended with public actions satisfies it;
   * `waitForTransactionReceipt` is optional but strongly recommended — the
   * spec expects a *confirmed* deposit hash.
   */
  type EvmWalletClient = {
    account?: { address: string } | undefined
    chain?: { id: number } | undefined
    sendTransaction: (args: {
      to: `0x${string}`
      value?: bigint | undefined
      data?: `0x${string}` | undefined
    }) => Promise<string>
    waitForTransactionReceipt?:
      | ((args: { hash: `0x${string}` }) => Promise<{ status?: string | undefined }>)
      | undefined
  }

  type SendDeposit = (parameters: {
    challenge: { id: string; expires?: string | undefined }
    request: Types.ChargeRequest
  }) => Promise<string>

  type Parameters = {
    /** Payment policy asserted before every deposit. */
    policy?: Policy | undefined
    /** Pays the origin-chain leg and resolves with the confirmed tx hash. */
    sendDeposit?: SendDeposit | undefined
    /** EVM wallet for the built-in `eip155:*` broadcast. */
    walletClient?: EvmWalletClient | undefined
    /** Payer DID for the credential `source` (defaults to did:pkh from the wallet). */
    source?: string | undefined
  }
}

/** @internal */
function assertPolicy(policy: charge.Policy | undefined, request: Types.ChargeRequest): void {
  if (!policy) return
  const { methodDetails } = request

  if (
    policy.allowedOriginNetworks &&
    !policy.allowedOriginNetworks.some((network) =>
      Types.networkEqual(network, methodDetails.originNetwork),
    )
  )
    throw new PolicyError(`origin network ${methodDetails.originNetwork} is not allowed`)

  if (
    policy.allowedCurrencies &&
    !policy.allowedCurrencies.some((asset) => Types.assetEqual(asset, request.currency))
  )
    throw new PolicyError(`currency ${request.currency} is not allowed`)

  if (policy.maxAmountIn) {
    const cap = Object.entries(policy.maxAmountIn).find(([asset]) =>
      Types.assetEqual(asset, request.currency),
    )?.[1]
    if (cap === undefined)
      throw new PolicyError(`currency ${request.currency} has no maxAmountIn entry`)
    if (BigInt(request.amount) > BigInt(cap))
      throw new PolicyError(`amount ${request.amount} exceeds the ${cap} cap for this asset`)
  }

  const expected = policy.expectedDestination
  if (expected) {
    if (
      expected.destinationAsset !== undefined &&
      !Types.assetEqual(expected.destinationAsset, methodDetails.destinationAsset)
    )
      throw new PolicyError('destination asset does not match the expected destination')
    if (
      expected.destinationRecipient !== undefined &&
      expected.destinationRecipient !== methodDetails.destinationRecipient
    )
      throw new PolicyError('destination recipient does not match the expected destination')
    if (expected.amountOut !== undefined && expected.amountOut !== methodDetails.amountOut)
      throw new PolicyError('amountOut does not match the expected destination')
  }
}

/** @internal Policy violations map to invalid-payload problems client-side. */
class PolicyError extends Errors.PaymentError {
  override readonly name = 'PolicyError'
  readonly title = 'Payment Policy Violation'
  readonly type = 'https://paymentauth.org/problems/invalid-payload'

  constructor(reason: string) {
    super(`Payment policy violation: ${reason}.`)
  }
}

/** @internal Broadcasts the deposit for `eip155:*` origins and returns the confirmed hash. */
async function broadcastEvmDeposit(
  walletClient: charge.EvmWalletClient,
  request: Types.ChargeRequest,
): Promise<string> {
  const currency = Types.parseCaip19(request.currency)
  if (currency.chain.namespace !== 'eip155')
    throw new Error(
      `nearintents-mpp-sdk: the built-in wallet broadcast only supports eip155 origins (got ${request.methodDetails.originNetwork}); use sendDeposit or context.hash.`,
    )
  if (request.methodDetails.depositMemo != null)
    throw new Error('nearintents-mpp-sdk: EVM deposits cannot carry a deposit memo.')

  const expectedChainId = Number(currency.chain.reference)
  if (walletClient.chain?.id !== expectedChainId)
    throw new Error(
      `nearintents-mpp-sdk: wallet is on chain ${walletClient.chain?.id ?? 'unknown'} but the challenge origin is eip155:${expectedChainId}.`,
    )

  const amount = BigInt(request.amount)
  const recipient = request.recipient as `0x${string}`

  // account/chain are intentionally omitted — the wallet's own defaults apply
  // (and the chain-id assertion above already pinned the network).
  const hash = await (async () => {
    if (currency.assetNamespace === 'slip44')
      return walletClient.sendTransaction({ to: recipient, value: amount })
    // ERC-20 transfer(address,uint256) calldata — 0xa9059cbb + padded args.
    const data =
      `0xa9059cbb${recipient.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}` as `0x${string}`
    return walletClient.sendTransaction({
      to: currency.assetReference as `0x${string}`,
      data,
    })
  })()

  // Present a *confirmed* hash when the client can wait for inclusion.
  if (walletClient.waitForTransactionReceipt) {
    const receipt = await walletClient.waitForTransactionReceipt({
      hash: hash as `0x${string}`,
    })
    if (receipt.status && receipt.status !== 'success')
      throw new Error(`nearintents-mpp-sdk: deposit transaction ${hash} reverted.`)
  }

  return hash
}
