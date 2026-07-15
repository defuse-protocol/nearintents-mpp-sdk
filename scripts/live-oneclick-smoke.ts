/**
 * Explicit, manual live-funds smoke harness for the 1Click settlement core.
 *
 * This file is intentionally outside the Vitest suite. It never runs in CI
 * and requires LIVE_ONE_CLICK=1. Quote creation and settlement are separate
 * invocations so the payer can inspect the wet quote and broadcast from an
 * external wallet before polling it to a terminal result.
 */
import * as OneClick from '../src/internal/OneClick.js'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`)
  return value
}

if (process.env.LIVE_ONE_CLICK !== '1')
  throw new Error(
    'Refusing to contact live 1Click. Set LIVE_ONE_CLICK=1 after reviewing the quote and real-funds instructions.',
  )

const jwt = process.env.ONE_CLICK_JWT?.trim()
if (!jwt && process.env.LIVE_ALLOW_UNAUTHENTICATED !== '1')
  throw new Error(
    'ONE_CLICK_JWT is required for a fee-free smoke. Set LIVE_ALLOW_UNAUTHENTICATED=1 to explicitly accept the unauthenticated 0.2% fee.',
  )

const config: OneClick.Config = {
  ...(jwt && { jwt }),
  ...(process.env.LIVE_ONE_CLICK_BASE_URL && {
    baseUrl: process.env.LIVE_ONE_CLICK_BASE_URL,
  }),
}

const depositAddress = process.env.LIVE_DEPOSIT_ADDRESS?.trim()

if (!depositAddress) {
  const originAsset = required('LIVE_ORIGIN_ASSET')
  const destinationAsset = required('LIVE_DESTINATION_ASSET')
  const amountOut = required('LIVE_AMOUNT_OUT')
  const recipient = required('LIVE_DESTINATION_RECIPIENT')
  const refundTo = required('LIVE_REFUND_TO')
  const slippageTolerance = positiveInteger('LIVE_SLIPPAGE_BPS', 100)
  const deadlineSeconds = positiveInteger('LIVE_QUOTE_DEADLINE_SECONDS', 900)

  const assetMap = OneClick.createAssetMap(await OneClick.getTokens(config), config)
  const originAssetId = assetMap.toAssetId(originAsset)
  const destinationAssetId = assetMap.toAssetId(destinationAsset)
  if (!originAssetId)
    throw new Error(`LIVE_ORIGIN_ASSET is not supported by 1Click: ${originAsset}`)
  if (!destinationAssetId)
    throw new Error(`LIVE_DESTINATION_ASSET is not supported by 1Click: ${destinationAsset}`)

  const result = await OneClick.quote(config, {
    originAsset: originAssetId,
    destinationAsset: destinationAssetId,
    amountOut,
    recipient,
    refundTo,
    slippageTolerance,
    deadline: new Date(Date.now() + deadlineSeconds * 1000).toISOString(),
    referral: 'mpp-live-smoke',
  })

  console.log(
    JSON.stringify(
      {
        phase: 'quote-created',
        realFunds: true,
        depositAddress: result.quote.depositAddress,
        depositMemo: result.quote.depositMemo ?? null,
        amountIn: result.quote.amountIn,
        minAmountIn: result.quote.minAmountIn,
        amountOut: result.quote.amountOut,
        deadline: result.quote.deadline,
        timeEstimate: result.quote.timeEstimate,
        originAsset,
        destinationAsset,
        destinationRecipient: recipient,
        refundTo,
      },
      null,
      2,
    ),
  )
  console.log(
    '\nInspect the quote, send exactly amountIn to depositAddress (with depositMemo when present), then rerun with LIVE_DEPOSIT_ADDRESS, LIVE_DEPOSIT_TX_HASH, and optional LIVE_DEPOSIT_MEMO.',
  )
  process.exit(0)
}

const txHash = required('LIVE_DEPOSIT_TX_HASH')
const depositMemo = process.env.LIVE_DEPOSIT_MEMO?.trim()
const expectedStatus = process.env.LIVE_EXPECT_STATUS?.trim() ?? 'SUCCESS'
const timeoutMs = positiveInteger('LIVE_POLL_TIMEOUT_MS', 15 * 60 * 1000)
const intervalMs = positiveInteger('LIVE_POLL_INTERVAL_MS', 2000)

// Notification is an accelerator only. A resumed smoke may already have been
// submitted, so status observation remains authoritative.
await OneClick.submitDeposit(config, {
  txHash,
  depositAddress,
  ...(depositMemo && { memo: depositMemo }),
}).catch((error) => {
  console.warn(`Deposit notification failed; continuing with status observation: ${String(error)}`)
})

const status = await OneClick.pollToTerminal(config, {
  depositAddress,
  ...(depositMemo && { depositMemo }),
  timeoutMs,
  intervalMs,
})
const observedOriginHash = OneClick.matchesOriginTx(status, txHash)
const destinationTxHash =
  OneClick.destinationTxHash(status) ?? status.swapDetails?.nearTxHashes?.[0] ?? null

console.log(
  JSON.stringify(
    {
      phase: 'terminal',
      depositAddress,
      status: status.status,
      observedOriginHash,
      originTxHash: txHash,
      destinationTxHash,
      depositedAmount: status.swapDetails?.depositedAmount ?? null,
      refundedAmount: status.swapDetails?.refundedAmount ?? null,
      refundReason: status.swapDetails?.refundReason ?? null,
      updatedAt: status.updatedAt ?? null,
    },
    null,
    2,
  ),
)

if (!observedOriginHash)
  throw new Error('The terminal 1Click result did not contain LIVE_DEPOSIT_TX_HASH.')
if (status.status !== expectedStatus)
  throw new Error(`Expected terminal status ${expectedStatus}, received ${status.status}.`)
if (status.status === 'SUCCESS' && !destinationTxHash)
  throw new Error('SUCCESS did not include a destination settlement transaction hash.')
