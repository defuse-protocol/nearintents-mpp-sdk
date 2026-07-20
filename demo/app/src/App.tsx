import { useCallback, useEffect, useMemo, useState } from 'react'

import { type DecodedChallenge, formatAmount, type PayOutcome, pay, probe } from './lib/pay.js'
import { type ConnectedWallet, connectArbitrumWallet } from './lib/wallet.js'

type Product = {
  key: string
  url: string
  name: string
  blurb: string
  price: string
  origin: string
  evm: boolean
}

const PRODUCTS: Product[] = [
  {
    key: 'insight',
    url: '/api/insight',
    name: 'Alpha terminal',
    blurb: 'One synthetic market insight, minted per minute.',
    price: '0.10 USDC to the merchant',
    origin: 'pay from Arbitrum (USDC) · 5 min window',
    evm: true,
  },
  {
    key: 'report',
    url: '/api/report',
    name: 'Cross-chain flow report',
    blurb: 'Synthetic settlement-flow corridors, refreshed every 5 minutes.',
    price: '6 USDC to the merchant',
    origin: 'pay from native Bitcoin · 45 min window',
    evm: false,
  },
]

type Flow =
  | { state: 'idle' }
  | { state: 'probing'; product: Product }
  | { state: 'challenge'; product: Product; challenge: DecodedChallenge }
  | { state: 'paying'; product: Product; challenge: DecodedChallenge; note: string }
  | { state: 'paid'; product: Product; outcome: PayOutcome }
  | {
      state: 'failed'
      product: Product
      problem?: { type?: string; title?: string; detail?: string } | undefined
      message?: string | undefined
    }

function useCountdown(expires: string | undefined): string {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  if (!expires) return '—'
  const remaining = Math.floor((new Date(expires).getTime() - now) / 1000)
  if (remaining <= 0) return 'expired — get a fresh challenge'
  return `${Math.floor(remaining / 60)}m ${remaining % 60}s`
}

function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="copyable"
      title="Copy"
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      <code>{value}</code>
      <span className="copy-badge">{copied ? 'copied' : 'copy'}</span>
    </button>
  )
}

function ChallengePanel(props: {
  product: Product
  challenge: DecodedChallenge
  wallet: ConnectedWallet | undefined
  onConnect: () => void
  onPayWallet: () => void
  onPayHash: (hash: string) => void
  onRefresh: () => void
}) {
  const { challenge, product } = props
  const { request } = challenge
  const countdown = useCountdown(challenge.expires)
  const [hash, setHash] = useState('')

  return (
    <div className="panel">
      <h3>402 Payment Required</h3>
      <p className="muted">
        The server minted a single-use 1Click deposit address for this exact purchase. Send the
        deposit on the origin chain, then present the transaction hash.
      </p>
      <div className="grid">
        <span>send</span>
        <strong>
          {formatAmount(request.currency, request.amount)}{' '}
          <span className="muted">({request.amount} base units)</span>
        </strong>
        <span>to deposit address</span>
        <Copyable value={request.recipient} />
        <span>origin network</span>
        <code>{request.methodDetails.originNetwork}</code>
        <span>merchant receives</span>
        <strong>
          {formatAmount(request.methodDetails.destinationAsset, request.methodDetails.amountOut)} on{' '}
          {request.methodDetails.destinationNetwork}
        </strong>
        <span>challenge expires</span>
        <strong>{countdown}</strong>
      </div>

      <div className="actions">
        {product.evm &&
          (props.wallet ? (
            <button type="button" className="primary" onClick={props.onPayWallet}>
              Pay {formatAmount(request.currency, request.amount)} with wallet
            </button>
          ) : (
            <button type="button" className="primary" onClick={props.onConnect}>
              Connect wallet to pay
            </button>
          ))}
        <div className="manual">
          <input
            value={hash}
            onChange={(event) => setHash(event.target.value)}
            placeholder="…or paste the deposit tx hash you sent"
            spellCheck={false}
          />
          <button
            type="button"
            disabled={!hash.trim()}
            onClick={() => props.onPayHash(hash.trim())}
          >
            Submit hash
          </button>
        </div>
        <button type="button" className="ghost" onClick={props.onRefresh}>
          Get fresh challenge
        </button>
      </div>
    </div>
  )
}

function ReceiptPanel({ outcome, product }: { outcome: PayOutcome; product: Product }) {
  return (
    <div className="panel">
      <h3>200 OK — {product.name} unlocked</h3>
      <pre className="payload">{JSON.stringify(outcome.body, null, 2)}</pre>
      {outcome.receipt && (
        <>
          <h4>Payment-Receipt</h4>
          <div className="grid">
            <span>method</span>
            <code>{outcome.receipt.method}</code>
            <span>challengeId</span>
            <code>{outcome.receipt.challengeId}</code>
            <span>origin tx (yours)</span>
            <code>{outcome.receipt.originTxHash}</code>
            <span>destination tx (merchant payout)</span>
            <code>{outcome.receipt.reference}</code>
            <span>destination network</span>
            <code>{outcome.receipt.destinationNetwork}</code>
          </div>
        </>
      )}
    </div>
  )
}

export default function App() {
  const [wallet, setWallet] = useState<ConnectedWallet | undefined>()
  const [flow, setFlow] = useState<Flow>({ state: 'idle' })
  const [walletError, setWalletError] = useState<string | undefined>()

  const startFlow = useCallback(async (product: Product) => {
    setFlow({ state: 'probing', product })
    try {
      const result = await probe(product.url)
      if (result.status === 402 && result.challenge)
        setFlow({ state: 'challenge', product, challenge: result.challenge })
      else if (result.status === 200)
        setFlow({ state: 'paid', product, outcome: { status: 200, body: result.body } })
      else setFlow({ state: 'failed', product, message: `Unexpected HTTP ${result.status}` })
    } catch (error) {
      setFlow({ state: 'failed', product, message: String(error) })
    }
  }, [])

  const connect = useCallback(async () => {
    setWalletError(undefined)
    try {
      setWallet(await connectArbitrumWallet())
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const settle = useCallback(
    async (product: Product, challenge: DecodedChallenge, options: { hash?: string }) => {
      setFlow({
        state: 'paying',
        product,
        challenge,
        note: options.hash
          ? 'Presenting your deposit — the server verifies it and drives the swap to the merchant…'
          : 'Confirm in your wallet, then the server drives the cross-chain swap…',
      })
      try {
        const outcome = await pay(product.url, {
          hash: options.hash,
          walletClient: options.hash ? undefined : wallet?.client,
        })
        if (outcome.status === 200) setFlow({ state: 'paid', product, outcome })
        else setFlow({ state: 'failed', product, problem: outcome.problem })
      } catch (error) {
        setFlow({
          state: 'failed',
          product,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
    [wallet],
  )

  const active = 'product' in flow ? flow.product : undefined
  const walletLabel = useMemo(
    () => (wallet ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : undefined),
    [wallet],
  )

  return (
    <main>
      <header>
        <div>
          <h1>
            <span className="accent">nearintents</span> · HTTP 402 across chains
          </h1>
          <p className="muted">
            Pay on any supported chain — the merchant receives an exact amount on theirs, settled by
            NEAR Intents. This demo runs the real <code>nearintents-mpp-sdk</code> client in your
            browser.
          </p>
        </div>
        <button type="button" onClick={connect} className="ghost">
          {walletLabel ?? 'Connect wallet'}
        </button>
      </header>
      {walletError && <p className="error">{walletError}</p>}

      <section className="cards">
        {PRODUCTS.map((product) => (
          <article
            key={product.key}
            className={active?.key === product.key ? 'card active' : 'card'}
          >
            <h2>{product.name}</h2>
            <p className="muted">{product.blurb}</p>
            <p>
              <strong>{product.price}</strong>
              <br />
              <span className="muted">{product.origin}</span>
            </p>
            <button type="button" className="primary" onClick={() => startFlow(product)}>
              Unlock
            </button>
          </article>
        ))}
      </section>

      {flow.state === 'probing' && <div className="panel pulse">Requesting challenge…</div>}
      {flow.state === 'challenge' && (
        <ChallengePanel
          product={flow.product}
          challenge={flow.challenge}
          wallet={wallet}
          onConnect={connect}
          onPayWallet={() => settle(flow.product, flow.challenge, {})}
          onPayHash={(hash) => settle(flow.product, flow.challenge, { hash })}
          onRefresh={() => startFlow(flow.product)}
        />
      )}
      {flow.state === 'paying' && <div className="panel pulse">{flow.note}</div>}
      {flow.state === 'paid' && <ReceiptPanel outcome={flow.outcome} product={flow.product} />}
      {flow.state === 'failed' && (
        <div className="panel">
          <h3>Payment did not complete</h3>
          <p className="error">
            {flow.problem?.title ?? 'Error'}
            {flow.problem?.type ? ` (${flow.problem.type.split('/').pop()})` : ''}
            {flow.problem?.detail ? ` — ${flow.problem.detail}` : ''}
            {flow.message ? ` ${flow.message}` : ''}
          </p>
          <button type="button" className="primary" onClick={() => startFlow(flow.product)}>
            Get a fresh challenge
          </button>
        </div>
      )}

      <footer className="muted">
        Deposits are custodied by the NEAR Intents settlement system for the duration of the swap;
        every non-success outcome refunds the merchant-configured refund address. Client caps: 2
        USDC / 20k sats per purchase.
      </footer>
    </main>
  )
}
