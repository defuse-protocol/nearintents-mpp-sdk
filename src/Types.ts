import { Receipt, z } from 'mppx'

/** Payment method name for `nearintents` challenges. */
export const paymentMethod = 'nearintents' as const

/** Payment intent name for one-time cross-chain charges. */
export const chargeIntent = 'charge' as const

/** `methodDetails.settlementBackend` disclosure value for this method. */
export const settlementBackend = 'near-intents' as const

/** Credential types supported by this method (spec: the only valid value is "hash"). */
export const credentialTypes = ['hash'] as const

// ---------------------------------------------------------------------------
// CAIP-2 / CAIP-19 identifiers
//
// The wire format uses CAIP-19 for `currency` and `methodDetails.destinationAsset`
// and CAIP-2 for `methodDetails.originNetwork` / `methodDetails.destinationNetwork`.
// Identifiers MUST be compared by parsed components, with the asset reference
// compared in the chain's canonical form (EVM addresses case-insensitively).
// ---------------------------------------------------------------------------

const caip2Regex = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32})$/
const caip19Regex =
  /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32})\/([-a-z0-9]{3,8}):([-.%a-zA-Z0-9]{1,128})$/

/** Parsed CAIP-2 chain identifier. */
export type Caip2 = {
  namespace: string
  reference: string
}

/** Parsed CAIP-19 asset identifier. */
export type Caip19 = {
  chain: Caip2
  assetNamespace: string
  assetReference: string
}

/** Parses a CAIP-2 chain identifier (e.g. `eip155:42161`). Throws on invalid input. */
export function parseCaip2(id: string): Caip2 {
  const match = caip2Regex.exec(id)
  if (!match) throw new Error(`Invalid CAIP-2 chain identifier: "${id}".`)
  return { namespace: match[1]!, reference: match[2]! }
}

/** Parses a CAIP-19 asset identifier (e.g. `eip155:42161/erc20:0xaf88…`). Throws on invalid input. */
export function parseCaip19(id: string): Caip19 {
  const match = caip19Regex.exec(id)
  if (!match) throw new Error(`Invalid CAIP-19 asset identifier: "${id}".`)
  return {
    chain: { namespace: match[1]!, reference: match[2]! },
    assetNamespace: match[3]!,
    assetReference: match[4]!,
  }
}

/** Returns the CAIP-2 chain component of a CAIP-19 asset identifier. */
export function chainOf(assetId: string): string {
  const { chain } = parseCaip19(assetId)
  return `${chain.namespace}:${chain.reference}`
}

/**
 * Non-throwing {@link chainOf} for schema refines: zod runs object-level
 * checks even when a field-level check already failed, so a malformed
 * CAIP-19 must yield `false` (a normal validation issue), not an exception.
 */
function chainOfSafe(assetId: string): string | undefined {
  try {
    return chainOf(assetId)
  } catch {
    return undefined
  }
}

/** Compares two CAIP-2 identifiers by parsed components. */
export function networkEqual(a: string, b: string): boolean {
  let left: Caip2
  let right: Caip2
  try {
    left = parseCaip2(a)
    right = parseCaip2(b)
  } catch {
    return false
  }
  return left.namespace === right.namespace && left.reference === right.reference
}

/** Compares chain-native addresses using the origin network's casing rules. */
export function addressEqual(network: string, a: string, b: string): boolean {
  try {
    return parseCaip2(network).namespace === 'eip155'
      ? a.toLowerCase() === b.toLowerCase()
      : a === b
  } catch {
    return false
  }
}

/**
 * Compares two CAIP-19 identifiers by parsed components.
 *
 * The asset reference is compared in the chain's canonical form: for `eip155`
 * chains (hex addresses) the comparison is case-insensitive; for all other
 * chains it is exact (e.g. base58 references are case-sensitive).
 */
export function assetEqual(a: string, b: string): boolean {
  let left: Caip19
  let right: Caip19
  try {
    left = parseCaip19(a)
    right = parseCaip19(b)
  } catch {
    return false
  }
  if (left.chain.namespace !== right.chain.namespace) return false
  if (left.chain.reference !== right.chain.reference) return false
  if (left.assetNamespace !== right.assetNamespace) return false
  if (left.chain.namespace === 'eip155')
    return left.assetReference.toLowerCase() === right.assetReference.toLowerCase()
  return left.assetReference === right.assetReference
}

/** Formats a payer identity as a `did:pkh` source (CAIP-2 network + payer address). */
export function toSource(parameters: { network: string; address: string }): string {
  return `did:pkh:${parameters.network}:${parameters.address}`
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Base-unit integer amount (e.g. "1000000" for 1 USDC at 6 decimals). */
export function atomicAmount() {
  return z.string().check(z.regex(/^\d+$/, 'Invalid base-unit amount'))
}

/** CAIP-2 chain identifier string. */
export function caip2() {
  return z.string().check(z.regex(caip2Regex, 'Invalid CAIP-2 chain identifier'))
}

/** CAIP-19 asset identifier string. */
export function caip19() {
  return z.string().check(z.regex(caip19Regex, 'Invalid CAIP-19 asset identifier'))
}

/** NEAR Intents-specific `methodDetails` for the charge request (spec §Method Details). */
export const MethodDetailsSchema = z.object({
  /** CAIP-2 identifier of the origin chain (where `recipient` lives and the deposit tx is anchored). */
  originNetwork: caip2(),
  /** CAIP-2 identifier of the chain where the merchant receives the destination asset. */
  destinationNetwork: caip2(),
  /** Destination asset the merchant receives, as CAIP-19; chain component MUST equal `destinationNetwork`. */
  destinationAsset: caip19(),
  /** Merchant address on the destination chain that receives `amountOut`. */
  destinationRecipient: z.string().check(z.minLength(1)),
  /** Exact amount the merchant receives, in base units of `destinationAsset` (EXACT_OUTPUT). */
  amountOut: atomicAmount(),
  /** Minimum deposit the backend accepts, in base units of `currency` — the verification threshold. */
  minAmountIn: atomicAmount(),
  /** Deposit memo required by some origin chains (e.g. Stellar). Absent or null when not required. */
  depositMemo: z.optional(z.nullable(z.string())),
  /** Slippage tolerance in basis points (e.g. 100 = 1%). */
  slippageTolerance: z.optional(z.number()),
  /** Estimated swap completion time in seconds, from the 1Click quote. */
  timeEstimate: z.optional(z.number()),
  /** Origin-chain address refunded if the swap fails or excess exists. */
  refundTo: z.string().check(z.minLength(1)),
  /** Settlement backend disclosure. Always "near-intents" for this method. */
  settlementBackend: z.optional(z.literal(settlementBackend)),
  /** Ordered list of accepted credential types. Only "hash" is valid for this method. */
  credentialTypes: z.optional(z.array(z.literal('hash')).check(z.minLength(1))),
})
export type MethodDetails = z.infer<typeof MethodDetailsSchema>

/**
 * Canonical `nearintents` charge request (the decoded challenge `request` parameter).
 *
 * The standard fields describe the payment the client makes on the origin
 * chain (`recipient` is the single-use 1Click deposit address); the merchant's
 * destination leg is carried in `methodDetails`.
 */
export const ChargeRequestSchema = z
  .object({
    /**
     * Deposit amount the client is asked to send, in base units of `currency`:
     * the quote's maximum input that guarantees the merchant receives
     * `methodDetails.amountOut` (the spec calls this `maxAmountIn`; the 1Click
     * quote response field is `amountIn`).
     */
    amount: atomicAmount(),
    /** Source asset the client pays with, as CAIP-19; chain component MUST equal `methodDetails.originNetwork`. */
    currency: caip19(),
    /** 1Click deposit address on the origin chain — the payee of the client's on-chain transfer. */
    recipient: z.string().check(z.minLength(1)),
    /** Human-readable payment description. MUST NOT be relied upon for verification. */
    description: z.optional(z.string()),
    /** Merchant reference (order ID, invoice number, etc.). */
    externalId: z.optional(z.string()),
    methodDetails: MethodDetailsSchema,
  })
  .check(
    z.refine((request) => {
      const chain = chainOfSafe(request.currency)
      return chain !== undefined && networkEqual(chain, request.methodDetails.originNetwork)
    }, 'currency chain component must equal methodDetails.originNetwork'),
    z.refine((request) => {
      const chain = chainOfSafe(request.methodDetails.destinationAsset)
      return chain !== undefined && networkEqual(chain, request.methodDetails.destinationNetwork)
    }, 'destinationAsset chain component must equal methodDetails.destinationNetwork'),
  )
export type ChargeRequest = z.infer<typeof ChargeRequestSchema>

/** Push-mode credential payload: the confirmed origin-chain deposit transaction hash. */
export const HashPayloadSchema = z.object({
  type: z.literal('hash'),
  /** Transaction hash of the client's deposit on `methodDetails.originNetwork` (chain-native format). */
  hash: z.string().check(z.minLength(1)),
})
export type HashPayload = z.infer<typeof HashPayloadSchema>

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

/**
 * `nearintents` Payment-Receipt payload (spec §Receipt).
 *
 * Extends the mppx base receipt with the method's REQUIRED `challengeId` and
 * `originTxHash` fields (and optional `destinationNetwork`). `reference` is
 * the destination-chain transaction hash of the merchant delivery.
 */
export type NearIntentsReceipt = Receipt.Receipt & {
  method: typeof paymentMethod
  /** The `id` from the original challenge. */
  challengeId: string
  /** The client's origin-chain deposit transaction hash (`payload.hash`). */
  originTxHash: string
  /** CAIP-2 identifier of the chain where the merchant was paid. */
  destinationNetwork?: string | undefined
}

/** Builds a spec-conformant `nearintents` receipt through `Receipt.from`. */
export function toReceipt(parameters: {
  challengeId: string
  /** Destination-chain transaction hash of the merchant delivery. */
  reference: string
  originTxHash: string
  destinationNetwork?: string | undefined
  externalId?: string | undefined
  timestamp?: string | undefined
}): NearIntentsReceipt {
  const { challengeId, destinationNetwork, externalId, originTxHash, reference } = parameters
  return Receipt.from({
    method: paymentMethod,
    reference,
    status: 'success',
    timestamp: parameters.timestamp ?? new Date().toISOString(),
    challengeId,
    originTxHash,
    ...(destinationNetwork !== undefined && { destinationNetwork }),
    ...(externalId !== undefined && { externalId }),
  }) as NearIntentsReceipt
}
