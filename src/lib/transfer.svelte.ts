import { Builder } from '@paraspell/sdk'
import type { PolkadotSigner } from 'polkadot-api'
import type { TransferParams, TransferState, HopFee, HopProgress, Route, FeeDetail } from './types'
import { resolveRoute } from './routing'
import { toParaSpell, getCurrency } from './chains'
import { getApiOverrides, getClient } from './provider.svelte'

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
    const api = client.getUnsafeApi()
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

    for (const hop of route.hops) {
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
    }

    transferState = { step: 'ready', fees }
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
      const currency = { ...getCurrency(hop.from, params.token), amount: params.amount.toString() }
      await builder()
        .from(toParaSpell(hop.from))
        .to(toParaSpell(hop.to))
        .currency(currency)
        .address(address)
        .senderAddress(signer)
        .signAndSubmit()

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
