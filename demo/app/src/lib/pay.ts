import { Challenge, Receipt } from 'mppx'
import { Mppx } from 'mppx/client'

// The demo dogfoods the actual package client straight from source.
import { charge } from '../../../../src/client/Charge.js'
import type * as Types from '../../../../src/Types.js'

export type DecodedChallenge = {
  id: string
  expires: string | undefined
  request: Types.ChargeRequest
}

export type PayOutcome = {
  status: number
  body: unknown
  receipt?: Types.NearIntentsReceipt | undefined
  problem?: { type?: string; title?: string; detail?: string } | undefined
}

const ARB_USDC = 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const BTC = 'bip122:000000000019d6689c085ae165831e93/slip44:0'
const NEAR_USDC =
  'near:mainnet/nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'

/** Client-side payment policy — hard caps the demo will never pay beyond. */
export const policy = {
  allowedOriginNetworks: ['eip155:42161', 'bip122:000000000019d6689c085ae165831e93'],
  maxAmountIn: {
    [ARB_USDC]: '2000000', // 2 USDC
    [BTC]: '20000', // 20k sats
  },
} as const

/** Known demo assets for human-readable amounts. */
export function formatAmount(assetId: string, baseUnits: string): string {
  const known: Record<string, { decimals: number; symbol: string }> = {
    [ARB_USDC.toLowerCase()]: { decimals: 6, symbol: 'USDC' },
    [BTC.toLowerCase()]: { decimals: 8, symbol: 'BTC' },
    [NEAR_USDC.toLowerCase()]: { decimals: 6, symbol: 'USDC' },
  }
  const meta = known[assetId.toLowerCase()]
  if (!meta) return `${baseUnits} base units`
  const value = Number(baseUnits) / 10 ** meta.decimals
  return `${value.toLocaleString('en', { maximumFractionDigits: meta.decimals })} ${meta.symbol}`
}

/** Fetches the resource without paying; decodes the 402 challenge if present. */
export async function probe(
  url: string,
): Promise<{ status: number; challenge?: DecodedChallenge; body?: unknown }> {
  const response = await fetch(url)
  if (response.status !== 402) {
    return { status: response.status, body: await response.json().catch(() => undefined) }
  }
  const challenge = Challenge.fromResponse(response)
  return {
    status: 402,
    challenge: {
      id: challenge.id,
      expires: challenge.expires,
      request: challenge.request as Types.ChargeRequest,
    },
  }
}

// One client for the page: its method remembers the deposits each wallet made,
// so a retry re-presents a deposit instead of paying its address again.
const mppx = Mppx.create({ methods: [charge({ policy })], polyfill: false })

/**
 * Pays the resource through the package's client method: either presenting an
 * already-broadcast tx hash, or broadcasting via the connected EVM wallet.
 */
export async function pay(
  url: string,
  options: {
    hash?: string | undefined
    walletClient?: charge.EvmWalletClient | undefined
  },
): Promise<PayOutcome> {
  const response = await mppx.fetch(url, {
    context: {
      ...(options.hash && { hash: options.hash }),
      ...(options.walletClient && { walletClient: options.walletClient }),
    },
  } as RequestInit)

  if (response.ok) {
    return {
      status: response.status,
      body: await response.json().catch(() => undefined),
      receipt: Receipt.fromResponse(response) as Types.NearIntentsReceipt,
    }
  }
  return {
    status: response.status,
    body: undefined,
    problem: await response.json().catch(() => undefined),
  }
}
