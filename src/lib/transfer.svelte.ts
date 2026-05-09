import { Builder } from '@paraspell/sdk'
import type { PolkadotSigner } from 'polkadot-api'
import type { TransferParams, TransferState, HopFee, HopProgress, Route, FeeDetail } from './types'
import { resolveRoute } from './routing'
import { toParaSpell, getCurrency } from './chains'
import { getApiOverrides, getClient } from './provider.svelte'
import {
  decideFeeStrategy, dryRunFull, maybeWrapWithFeeSwap,
  type SrcApi, type UnsignedTx, type DryRunSummary, type PapiTxOptions,
} from './donate.svelte'

// KSM location on KAH (from relay parent)
const KSM_LOCATION = { parents: 1, interior: 'Here' }
// USDC location on KAH (local pallet-assets, bridged from PAH)
const USDC_KAH_LOCATION = {
  parents: 2,
  interior: {
    X4: [
      { GlobalConsensus: { Polkadot: null } },
      { Parachain: 1000 },
      { PalletInstance: 50 },
      { GeneralIndex: 1337 },
    ],
  },
}

let transferState = $state<TransferState>({ step: 'idle' })

function builder() {
  const overrides = getApiOverrides()
  if (!overrides) throw new Error('Not connected to chains')
  return Builder({ apiOverrides: overrides })
}

async function quoteKsmToUsdc(ksmAmount: bigint): Promise<bigint | null> {
  if (ksmAmount <= 0n) return null
  const client = getClient('kah')
  if (!client) return null
  try {
    const api = client.getUnsafeApi() as unknown as {
      apis: { AssetConversionApi: { quote_price_exact_tokens_for_tokens: (a: unknown, b: unknown, amt: bigint, includeFee: boolean) => Promise<bigint | null | undefined> } }
    }
    const result = await api.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(
      KSM_LOCATION, USDC_KAH_LOCATION, ksmAmount, true,
    )
    return result != null ? BigInt(result) : null
  } catch {
    return null
  }
}

async function enrichWithQuote(detail: FeeDetail): Promise<FeeDetail> {
  if (detail.fee <= 0n || detail.symbol !== 'KSM') return detail
  const quoted = await quoteKsmToUsdc(detail.fee)
  if (quoted == null) return detail
  return { ...detail, quoted: { fee: quoted, symbol: 'USDC', decimals: 6 } }
}

function extractFee(detail: { fee?: bigint; asset: { symbol?: string; decimals?: number } }): FeeDetail {
  return {
    fee: detail.fee ?? 0n,
    symbol: detail.asset.symbol ?? '?',
    decimals: detail.asset.decimals ?? 12,
  }
}

interface BuiltHop {
  /** Wrapped PAPI tx (paraspell-built tx, optionally batched with a USDC→native fee swap). */
  tx: UnsignedTx
  /** Per-hop fee strategy decided from native vs asset-conversion. */
  txOpts: PapiTxOptions | undefined
}

async function buildHopTx(
  hop: { from: import('./types').ChainId; to: import('./types').ChainId },
  token: import('./types').TokenSymbol,
  amount: bigint,
  senderAddress: string,
): Promise<BuiltHop> {
  const overrides = getApiOverrides()
  if (!overrides) throw new Error('Not connected to chains')
  const currency = { ...getCurrency(hop.from, token), amount: amount.toString() }
  const psTx = await Builder({ apiOverrides: overrides })
    .from(toParaSpell(hop.from))
    .to(toParaSpell(hop.to))
    .currency(currency)
    .address(senderAddress)
    .senderAddress(senderAddress)
    .build()

  const srcClient = getClient(hop.from)
  if (!srcClient) throw new Error(`No client for ${hop.from}`)
  const srcApi = srcClient.getUnsafeApi() as unknown as SrcApi
  const tx = await maybeWrapWithFeeSwap(srcApi, hop.from, token, psTx as unknown as UnsignedTx, senderAddress)
  const strategy = await decideFeeStrategy(hop.from, token, tx, senderAddress)
  return { tx, txOpts: strategy.txOpts }
}

export async function estimateFees(
  params: TransferParams,
  senderAddress: string,
): Promise<HopFee[] | null> {
  const route = resolveRoute(params.token, params.source, params.destination)
  if (!route) {
    transferState = { step: 'error', message: 'No route found' }
    return null
  }

  transferState = { step: 'estimating' }

  try {
    const fees: HopFee[] = []
    const hopDryRuns: DryRunSummary[] = []

    for (const hop of route.hops) {
      // Paraspell's getXcmFee gives a per-asset breakdown for display.
      const currency = { ...getCurrency(hop.from, params.token), amount: params.amount.toString() }
      const feeResult = await builder()
        .from(toParaSpell(hop.from))
        .to(toParaSpell(hop.to))
        .currency(currency)
        .address(senderAddress)
        .senderAddress(senderAddress)
        .getXcmFee()

      const [origin, destination] = await Promise.all([
        enrichWithQuote(extractFee(feeResult.origin)),
        enrichWithQuote(extractFee(feeResult.destination)),
      ])
      fees.push({ hop, origin, destination })

      // Dry-run the actual tx (with fee-swap pre-pended if needed) so we can
      // catch bridge / fee / pool issues before the user signs anything.
      const built = await buildHopTx(hop, params.token, params.amount, senderAddress)
      const dr = await dryRunFull(
        hop.from, built.tx.decodedCall, senderAddress,
        [{ id: senderAddress, address: senderAddress, label: 'You' }],
      )
      hopDryRuns.push(dr)

      if (!dr.sourceOk) {
        transferState = { step: 'error', message: `${hop.from} → ${hop.to}: ${dr.sourceMessage ?? 'dry-run failed'}` }
        return null
      }
      const failedDest = dr.destinations.find(d => !d.ok)
      if (failedDest) {
        transferState = { step: 'error', message: `${hop.from} → ${hop.to} (${failedDest.destChain}): ${failedDest.errorMessage ?? 'failed'}` }
        return null
      }
    }

    transferState = { step: 'ready', fees, hopDryRuns }
    return fees
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Fee estimation failed'
    transferState = { step: 'error', message: msg }
    return null
  }
}

export async function executeTransfer(
  params: TransferParams,
  signer: PolkadotSigner,
  address: string,
  _fees: HopFee[],
): Promise<boolean> {
  const route = resolveRoute(params.token, params.source, params.destination)
  if (!route) {
    transferState = { step: 'error', message: 'No route found' }
    return false
  }

  const hopProgresses: HopProgress[] = route.hops.map(hop => ({
    hop,
    status: 'pending',
  }))
  transferState = { step: 'executing', hops: [...hopProgresses] }

  for (let i = 0; i < route.hops.length; i++) {
    const hop = route.hops[i]

    hopProgresses[i] = { ...hopProgresses[i], status: 'signing' }
    transferState = { step: 'executing', hops: [...hopProgresses] }

    try {
      const built = await buildHopTx(hop, params.token, params.amount, address)
      await built.tx.signAndSubmit(signer, built.txOpts)

      hopProgresses[i] = { ...hopProgresses[i], status: 'success' }
      transferState = { step: 'executing', hops: [...hopProgresses] }

      // Wait for XCM to process between hops
      if (i < route.hops.length - 1) {
        await new Promise(r => setTimeout(r, 18_000))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaction failed'
      hopProgresses[i] = { ...hopProgresses[i], status: 'error', error: msg }
      transferState = { step: 'executing', hops: [...hopProgresses] }
      return false
    }
  }

  transferState = { step: 'success' }
  return true
}

export function resetTransfer() {
  transferState = { step: 'idle' }
}

export function getTransferState(): TransferState {
  return transferState
}

export function routeForParams(params: TransferParams): Route | null {
  return resolveRoute(params.token, params.source, params.destination)
}
