import { Builder } from '@paraspell/sdk'
import type { PolkadotSigner } from 'polkadot-api'
import type { TransferParams, TransferState, HopFee, HopProgress, Route, FeeDetail } from './types'
import { resolveRoute } from './routing'
import { toParaSpell, getCurrency } from './chains'
import { getApiOverrides } from './provider.svelte'

let transferState = $state<TransferState>({ step: 'idle' })

function builder() {
  const overrides = getApiOverrides()
  if (!overrides) throw new Error('Not connected to chains')
  return Builder({ apiOverrides: overrides })
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

      fees.push({
        hop,
        origin: extractFee(feeResult.origin),
        destination: extractFee(feeResult.destination),
      })
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
