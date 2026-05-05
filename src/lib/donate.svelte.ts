import { Builder } from '@paraspell/sdk'
import { AccountId, Binary } from 'polkadot-api'
import type { PolkadotSigner } from 'polkadot-api'
import type { ChainId, TokenSymbol } from './types'
import { toParaSpell, getCurrency } from './chains'
import { getApiOverrides, getClient } from './provider.svelte'
import type { Faucet, Treasury } from './recipients.svelte'

const ksmSs58 = AccountId(2)

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
    PolkadotXcm: { transfer_assets_using_type_and_then: (args: unknown) => UnsignedTx }
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

/** USDC's location on KAH (foreign-asset id from KAH's perspective) — same shape as USDC_LOCATION */
const USDC_KAH_DEST_LOCATION = USDC_LOCATION

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

  // For bridged routes (currently USDC PAH→KAH), consolidate N recipients into a
  // single XCM message with multi-DepositAsset on the destination side. Avoids
  // paying the bridging fee N times.
  if (source !== dest && recipients.length > 1) {
    console.log(`[donate] attempting single-XCM consolidation for ${token} ${source}→${dest} (${recipients.length} recipients)`)
    const consolidated = await tryBuildConsolidatedXcm(
      source, dest, token,
      recipients.map((r, i) => ({ address: r.address, amount: amounts[i] })),
      totalAmount,
      senderAddress,
    )
    if (consolidated) {
      console.log('[donate] consolidation produced single tx ✓')
      return [consolidated]
    }
    console.log('[donate] consolidation returned null; using per-recipient batch')
  }

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

/**
 * Attempts to build a single XCM that delivers funds to all recipients in one
 * cross-chain message via `polkadotXcm.transfer_assets_using_type_and_then`.
 *
 * Strategy: let paraspell build a tx for a single recipient with the *total*
 * amount (so it picks the right TransferType, dest location, BuyExecution, fee
 * handling). If the resulting call is `transfer_assets_using_type_and_then`,
 * patch its `custom_xcm_on_dest` to replace the single DepositAsset with N
 * DepositAssets — first N-1 with `Definite{ id, Fungible(amount) }`, last with
 * `Wild(AllCounted: 1)` to sweep the bridge-fee remainder.
 *
 * Returns `null` if the route isn't a `transfer_assets_using_type_and_then` one
 * (e.g. KAH→Encointer KSM uses `limited_teleport_assets`); caller falls back to
 * per-recipient calls + Utility.batch_all.
 */
async function tryBuildConsolidatedXcm(
  source: ChainId,
  dest: ChainId,
  token: TokenSymbol,
  recipients: Array<{ address: string; amount: bigint }>,
  totalAmount: bigint,
  senderAddress: string,
): Promise<UnsignedTx | null> {
  // Currently only USDC PAH→KAH has a bridge with non-trivial fees per message.
  // KAH→Encointer KSM is sibling-teleport (cheap) and uses a different call shape.
  if (!(token === 'USDC' && source === 'pah' && dest === 'kah')) return null

  const overrides = getApiOverrides()
  if (!overrides) return null
  const srcClient = getClient(source)
  if (!srcClient) return null
  const srcApi = srcClient.getUnsafeApi() as unknown as SrcApi

  // Build paraspell tx for the first recipient with the TOTAL amount.
  const currency = { ...getCurrency(source, token), amount: totalAmount.toString() }
  const psTx = await Builder({ apiOverrides: overrides })
    .from(toParaSpell(source))
    .to(toParaSpell(dest))
    .currency(currency)
    .address(recipients[0].address)
    .senderAddress(senderAddress)
    .build()

  // Inspect & patch the decoded call.
  type DecodedCall = { type?: string; value?: { type?: string; value?: Record<string, unknown> } } & Record<string, unknown>
  const decoded = (psTx as unknown as { decodedCall: DecodedCall }).decodedCall
  console.log('[donate] paraspell decodedCall:', JSON.stringify(decoded, (_k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v, 2))

  // Detect call shape: PAPI normalized form or polkadot.js variant-key form.
  let callArgs: Record<string, unknown> | null = null
  if (decoded?.type === 'PolkadotXcm' && decoded.value?.type === 'transfer_assets_using_type_and_then') {
    callArgs = decoded.value.value as Record<string, unknown>
  } else if (typeof decoded === 'object' && decoded !== null) {
    // polkadot.js style: { PolkadotXcm: { transfer_assets_using_type_and_then: {...} } }
    const pxcm = (decoded as Record<string, unknown>).PolkadotXcm as Record<string, unknown> | undefined
    if (pxcm?.transfer_assets_using_type_and_then) {
      callArgs = pxcm.transfer_assets_using_type_and_then as Record<string, unknown>
    }
  }
  if (!callArgs) {
    console.warn(`[donate] paraspell built unexpected call shape for ${source}->${dest}; falling back to per-recipient batch`)
    return null
  }

  const xcm = callArgs.custom_xcm_on_dest as { type?: string; value?: unknown[] } & Record<string, unknown>
  // Detect customXcmOnDest shape: { type: 'V5', value: [...] } OR { V5: [...] }
  let instructions: Array<Record<string, unknown>> | null = null
  let xcmStyle: 'papi' | 'pjs' = 'papi'
  let xcmVersionTag: string = 'V5'
  if (Array.isArray(xcm.value)) {
    instructions = xcm.value as Array<Record<string, unknown>>
    xcmStyle = 'papi'
    xcmVersionTag = (xcm.type as string) ?? 'V5'
  } else {
    for (const key of Object.keys(xcm)) {
      const v = (xcm as Record<string, unknown>)[key]
      if (Array.isArray(v)) {
        instructions = v as Array<Record<string, unknown>>
        xcmStyle = 'pjs'
        xcmVersionTag = key
        break
      }
    }
  }
  if (!instructions) {
    console.warn('[donate] could not locate XCM instructions array; falling back', xcm)
    return null
  }
  console.log(`[donate] xcm style=${xcmStyle} version=${xcmVersionTag}; sample instruction:`, instructions[0])

  // Find the DepositAsset (in either style)
  const isDeposit = (ins: Record<string, unknown>) =>
    ins.type === 'DepositAsset' || 'DepositAsset' in ins
  const depIdx = instructions.findIndex(isDeposit)
  if (depIdx < 0) {
    console.warn('[donate] no DepositAsset in custom_xcm_on_dest; falling back', instructions)
    return null
  }

  // Build per-recipient deposits in the SAME style as paraspell used.
  const mkInstr = (tag: string, value: unknown) =>
    xcmStyle === 'papi' ? { type: tag, value } : { [tag]: value }
  const mkEnum = (tag: string, value: unknown) =>
    xcmStyle === 'papi' ? { type: tag, value } : { [tag]: value }

  // Note: PAPI flattens `Junctions::X1([Junction; 1])` to a single Junction
  // (not an array of length 1). X2..X8 do use arrays.
  const beneficiaryFor = (addr: string) => ({
    parents: 0,
    interior: xcmStyle === 'papi'
      ? { type: 'X1', value: { type: 'AccountId32', value: { network: undefined, id: Binary.fromBytes(ksmSs58.enc(addr)) } } }
      : { X1: { AccountId32: { network: null, id: Binary.fromBytes(ksmSs58.enc(addr)) } } },
  })

  const newDeposits = recipients.map((r, i) => {
    const isLast = i === recipients.length - 1
    const beneficiary = beneficiaryFor(r.address)
    const assets = isLast
      ? mkEnum('Wild', mkEnum('AllCounted', 1))
      : mkEnum('Definite', [{ id: USDC_KAH_DEST_LOCATION, fun: mkEnum('Fungible', r.amount) }])
    return mkInstr('DepositAsset', { assets, beneficiary })
  })

  instructions.splice(depIdx, 1, ...newDeposits)
  console.log('[donate] patched custom_xcm_on_dest:', JSON.stringify(instructions, (_k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v, 2))

  try {
    return srcApi.tx.PolkadotXcm.transfer_assets_using_type_and_then(callArgs)
  } catch (err) {
    console.warn('[donate] failed to re-encode patched call; falling back', err)
    return null
  }
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
