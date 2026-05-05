import { Builder } from '@paraspell/sdk'
import type { PolkadotSigner } from 'polkadot-api'
import type { ChainId, TokenSymbol } from './types'
import { toParaSpell, getCurrency } from './chains'
import { getApiOverrides, getClient } from './provider.svelte'
import type { Faucet, Treasury } from './recipients.svelte'

export type DonateState =
  | { step: 'idle' }
  | { step: 'estimating' }
  | { step: 'ready'; fee: bigint; feeSymbol: string; feeDecimals: number; mode: 'batch' | 'sequential' }
  | { step: 'executing'; mode: 'batch' | 'sequential'; current: number; total: number }
  | { step: 'success' }
  | { step: 'error'; message: string }

export interface DonateRecipient {
  /** Stable identifier (account address) — used for selection */
  id: string
  /** Recipient SS58 address on the destination chain */
  address: string
  /** Display label */
  label: string
}

export interface DonateParams {
  token: TokenSymbol
  source: ChainId
  recipients: DonateRecipient[]
  totalAmount: bigint
}

let state = $state<DonateState>({ step: 'idle' })

function destChainFor(token: TokenSymbol): ChainId {
  return token === 'KSM' ? 'encointer' : 'kah'
}

export const ALLOWED_SOURCES: Record<TokenSymbol, ChainId[]> = {
  KSM: ['encointer', 'kah'],
  USDC: ['kah', 'pah'],
}

export function destinationChain(token: TokenSymbol): ChainId {
  return destChainFor(token)
}

export function splitAmount(total: bigint, n: number): bigint[] {
  if (n <= 0) return []
  const base = total / BigInt(n)
  const remainder = total % BigInt(n)
  return Array.from({ length: n }, (_, i) => (i === 0 ? base + remainder : base))
}

export function recipientFromFaucet(f: Faucet): DonateRecipient {
  return { id: f.account, address: f.account, label: f.name || f.account }
}

export function recipientFromTreasury(t: Treasury): DonateRecipient {
  return { id: t.kahAccount, address: t.kahAccount, label: t.name }
}

interface SrcApi {
  tx: {
    Balances?: { transfer_keep_alive: (args: unknown) => UnsignedTx }
    ForeignAssets?: { transfer_keep_alive: (args: unknown) => UnsignedTx }
    Assets?: { transfer_keep_alive: (args: unknown) => UnsignedTx }
    Utility: { batch_all: (args: { calls: unknown[] }) => UnsignedTx }
  }
}

interface UnsignedTx {
  decodedCall: unknown
  getEstimatedFees: (sender: string) => Promise<bigint>
  signAndSubmit: (signer: PolkadotSigner) => Promise<unknown>
}

const USDC_LOCATION = {
  parents: 2,
  interior: {
    type: 'X4',
    value: [
      { type: 'GlobalConsensus', value: { type: 'Polkadot', value: undefined } },
      { type: 'Parachain', value: 1000 },
      { type: 'PalletInstance', value: 50 },
      { type: 'GeneralIndex', value: 1337n },
    ],
  },
}

function buildSameChainCall(
  srcApi: SrcApi,
  source: ChainId,
  token: TokenSymbol,
  beneficiary: string,
  amount: bigint,
): UnsignedTx {
  if (token === 'KSM' && source === 'encointer') {
    if (!srcApi.tx.Balances) throw new Error('Balances pallet missing on encointer')
    return srcApi.tx.Balances.transfer_keep_alive({
      dest: { type: 'Id', value: beneficiary },
      value: amount,
    })
  }
  if (token === 'USDC' && source === 'kah') {
    if (!srcApi.tx.ForeignAssets) throw new Error('ForeignAssets pallet missing on KAH')
    return srcApi.tx.ForeignAssets.transfer_keep_alive({
      id: USDC_LOCATION,
      target: { type: 'Id', value: beneficiary },
      amount,
    })
  }
  throw new Error(`Unsupported same-chain donation: ${token} on ${source}`)
}

async function buildCrossChainCall(
  source: ChainId,
  dest: ChainId,
  token: TokenSymbol,
  beneficiary: string,
  amount: bigint,
  senderAddress: string,
): Promise<UnsignedTx> {
  const overrides = getApiOverrides()
  if (!overrides) throw new Error('Not connected to chains')
  const currency = { ...getCurrency(source, token), amount: amount.toString() }
  const tx = await Builder({ apiOverrides: overrides })
    .from(toParaSpell(source))
    .to(toParaSpell(dest))
    .currency(currency)
    .address(beneficiary)
    .senderAddress(senderAddress)
    .build()
  return tx as unknown as UnsignedTx
}

async function buildPerRecipientCalls(
  params: DonateParams,
  senderAddress: string,
): Promise<UnsignedTx[]> {
  const { token, source, recipients, totalAmount } = params
  const dest = destChainFor(token)
  const amounts = splitAmount(totalAmount, recipients.length)

  const srcClient = getClient(source)
  if (!srcClient) throw new Error(`No client for ${source}`)
  const srcApi = srcClient.getUnsafeApi() as unknown as SrcApi

  const calls: UnsignedTx[] = []
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i]
    const amt = amounts[i]
    if (source === dest) {
      calls.push(buildSameChainCall(srcApi, source, token, r.address, amt))
    } else {
      calls.push(await buildCrossChainCall(source, dest, token, r.address, amt, senderAddress))
    }
  }
  return calls
}

async function buildBatch(source: ChainId, calls: UnsignedTx[]): Promise<UnsignedTx | null> {
  if (calls.length <= 1) return calls[0] ?? null
  const srcClient = getClient(source)
  if (!srcClient) return null
  const srcApi = srcClient.getUnsafeApi() as unknown as SrcApi
  try {
    const decoded = calls.map(c => c.decodedCall)
    return srcApi.tx.Utility.batch_all({ calls: decoded })
  } catch (err) {
    console.warn('[donate] batch_all build failed; will fall back to sequential', err)
    return null
  }
}

export async function estimateDonate(
  params: DonateParams,
  senderAddress: string,
): Promise<void> {
  state = { step: 'estimating' }
  try {
    const calls = await buildPerRecipientCalls(params, senderAddress)
    if (calls.length === 0) {
      state = { step: 'error', message: 'No recipients selected' }
      return
    }
    const batch = await buildBatch(params.source, calls)
    if (batch) {
      try {
        const fee = await batch.getEstimatedFees(senderAddress)
        const feeMeta = sourceFeeAsset(params.source)
        state = { step: 'ready', fee, feeSymbol: feeMeta.symbol, feeDecimals: feeMeta.decimals, mode: 'batch' }
        return
      } catch (err) {
        console.warn('[donate] batch fee estimate failed; trying sequential', err)
      }
    }
    let totalFee = 0n
    for (const call of calls) {
      try { totalFee += await call.getEstimatedFees(senderAddress) } catch { /* skip */ }
    }
    const feeMeta = sourceFeeAsset(params.source)
    state = { step: 'ready', fee: totalFee, feeSymbol: feeMeta.symbol, feeDecimals: feeMeta.decimals, mode: 'sequential' }
  } catch (err) {
    state = { step: 'error', message: err instanceof Error ? err.message : 'Estimation failed' }
  }
}

function sourceFeeAsset(source: ChainId): { symbol: string; decimals: number } {
  // Native fee token of the source chain
  if (source === 'pah') return { symbol: 'DOT', decimals: 10 }
  return { symbol: 'KSM', decimals: 12 }
}

function isUserCancel(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return msg.includes('cancel') || msg.includes('reject') || msg.includes('user denied')
}

export async function executeDonate(
  params: DonateParams,
  signer: PolkadotSigner,
  senderAddress: string,
): Promise<boolean> {
  try {
    const calls = await buildPerRecipientCalls(params, senderAddress)
    if (calls.length === 0) {
      state = { step: 'error', message: 'No recipients selected' }
      return false
    }

    if (calls.length > 1) {
      const batch = await buildBatch(params.source, calls)
      if (batch) {
        state = { step: 'executing', mode: 'batch', current: 0, total: 1 }
        try {
          await batch.signAndSubmit(signer)
          state = { step: 'success' }
          return true
        } catch (err) {
          if (isUserCancel(err)) {
            state = { step: 'error', message: 'Cancelled' }
            return false
          }
          console.warn('[donate] batch submit failed; falling back to sequential', err)
        }
      }
    }

    for (let i = 0; i < calls.length; i++) {
      state = { step: 'executing', mode: 'sequential', current: i, total: calls.length }
      try {
        await calls[i].signAndSubmit(signer)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Submission failed'
        state = { step: 'error', message: `Recipient ${i + 1}/${calls.length}: ${msg}` }
        return false
      }
    }
    state = { step: 'success' }
    return true
  } catch (err) {
    state = { step: 'error', message: err instanceof Error ? err.message : 'Execution failed' }
    return false
  }
}

export function resetDonate() {
  state = { step: 'idle' }
}

export function getDonateState(): DonateState {
  return state
}
