import { Builder } from '@paraspell/sdk'
import type { PolkadotSigner } from 'polkadot-api'
import type { TransferParams, TransferState, HopFee, HopProgress, Route } from './types'
import { resolveRoute } from './routing'
import { toParaSpell, getDecimals, getCurrency } from './chains'
import { getApiOverrides } from './provider.svelte'
import { formatBalance } from './format'

let transferState = $state<TransferState>({ step: 'idle' })

function builder() {
  const overrides = getApiOverrides()
  if (!overrides) throw new Error('Not connected to chains')
  return Builder({ apiOverrides: overrides })
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
    let remainingAmount = params.amount

    for (const hop of route.hops) {
      const decimals = getDecimals(hop.from, params.token)

      const currency = { ...getCurrency(hop.from, params.token), amount: remainingAmount.toString() }
      const feeResult = await builder()
        .from(toParaSpell(hop.from))
        .to(toParaSpell(hop.to))
        .currency(currency)
        .address(senderAddress)
        .senderAddress(senderAddress)
        .getXcmFee()

      const originFee = feeResult.origin.fee ?? 0n
      const destFee = feeResult.destination.fee ?? 0n

      fees.push({ hop, originFee, destinationFee: destFee })

      remainingAmount = remainingAmount - originFee - destFee
      if (remainingAmount <= 0n) {
        transferState = {
          step: 'error',
          message: `Fees (~${formatBalance(originFee + destFee, decimals)} ${params.token}) exceed transfer amount`,
        }
        return null
      }
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
  fees: HopFee[],
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

  let remainingAmount = params.amount

  for (let i = 0; i < route.hops.length; i++) {
    const hop = route.hops[i]

    hopProgresses[i] = { ...hopProgresses[i], status: 'signing' }
    transferState = { step: 'executing', hops: [...hopProgresses] }

    try {
      const currency = { ...getCurrency(hop.from, params.token), amount: remainingAmount.toString() }
      await builder()
        .from(toParaSpell(hop.from))
        .to(toParaSpell(hop.to))
        .currency(currency)
        .address(address)
        .senderAddress(signer)
        .signAndSubmit()

      hopProgresses[i] = { ...hopProgresses[i], status: 'success' }
      transferState = { step: 'executing', hops: [...hopProgresses] }

      // Deduct fees for next hop amount
      if (fees[i]) {
        remainingAmount = remainingAmount - fees[i].originFee - fees[i].destinationFee
      }

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

export function totalFees(fees: HopFee[]): bigint {
  return fees.reduce((sum, f) => sum + f.originFee + f.destinationFee, 0n)
}

export function receiveAmount(amount: bigint, fees: HopFee[]): bigint {
  const total = totalFees(fees)
  return amount > total ? amount - total : 0n
}

export function routeForParams(params: TransferParams): Route | null {
  return resolveRoute(params.token, params.source, params.destination)
}
