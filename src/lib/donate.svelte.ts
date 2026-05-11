import { Builder, getExistentialDeposit } from '@paraspell/sdk'
import { AccountId, getSs58AddressInfo } from 'polkadot-api'
import type { PolkadotSigner } from 'polkadot-api'
import type { ChainId, TokenSymbol } from './types'
import { CHAINS, toParaSpell, getCurrency } from './chains'
import { getApiOverrides, getClient } from './provider.svelte'
import type { Faucet, Treasury } from './recipients.svelte'
import { quoteUsdcForExactNative } from './forex'

const ksmSs58 = AccountId(2)

export interface SubmittedTx {
  txHash: string
  chain: ChainId
}

export type DonateState =
  | { step: 'idle' }
  | { step: 'estimating' }
  | {
      step: 'ready'
      /** Primary fee value in the unit actually charged to the user. */
      fee: bigint
      feeSymbol: string
      feeDecimals: number
      /** Native equivalent shown alongside, only when fee is paid in the asset
       *  via AssetConversion swap. */
      feeNative?: bigint
      feeNativeSymbol?: string
      feeNativeDecimals?: number
      mode: 'batch' | 'sequential'
      txOpts?: PapiTxOptions
      /** Pre-flight dry-run summary (source + per-destination). */
      dryRun?: DryRunSummary
    }
  | { step: 'executing'; mode: 'batch' | 'sequential'; current: number; total: number; phase: 'awaiting-signature' | 'awaiting-inclusion' }
  | { step: 'success'; submitted: SubmittedTx[] }
  | { step: 'error'; message: string }

const SUBSCAN_HOSTS: Partial<Record<ChainId, string>> = {
  kah: 'https://assethub-kusama.subscan.io',
  pah: 'https://assethub-polkadot.subscan.io',
}

export function subscanUrl(chain: ChainId, txHash: string): string | null {
  const host = SUBSCAN_HOSTS[chain]
  if (!host) return null
  return `${host}/extrinsic/${txHash}`
}

export function subscanAccountUrl(chain: ChainId, address: string): string | null {
  const host = SUBSCAN_HOSTS[chain]
  if (!host) return null
  return `${host}/account/${address}`
}

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
  /** Optional per-recipient weights (positive numbers). When provided and not
   *  all-equal/all-zero, the donation is split proportionally; otherwise even. */
  weights?: number[]
}

let state = $state<DonateState>({ step: 'idle' })

function destChainFor(token: TokenSymbol): ChainId {
  return token === 'KSM' ? 'encointer' : 'kah'
}

export const ALLOWED_SOURCES: Record<TokenSymbol, ChainId[]> = {
  KSM: ['encointer', 'kah'],
  USDC: ['kah', 'pah'],
  // DOT is balance-display only (no in-app routing for donations either).
  DOT: [],
}

export function destinationChain(token: TokenSymbol): ChainId {
  return destChainFor(token)
}

export function splitAmount(total: bigint, n: number, weights?: number[]): bigint[] {
  if (n <= 0) return []
  // Weighted path: only kicks in when weights are supplied AND vary.
  if (weights && weights.length === n) {
    const finite = weights.map(w => Number.isFinite(w) && w > 0 ? w : 0)
    const sum = finite.reduce((s, w) => s + w, 0)
    const allEqual = finite.every(w => w === finite[0])
    if (sum > 0 && !allEqual) {
      // Scale to integer to avoid float precision in BigInt math.
      const SCALE = 1_000_000_000
      const scaled = finite.map(w => BigInt(Math.round((w / sum) * SCALE)))
      const scaledSum = scaled.reduce((s, x) => s + x, 0n)
      const shares = scaled.map(s => (total * s) / scaledSum)
      const residual = total - shares.reduce((s, x) => s + x, 0n)
      shares[0] += residual
      return shares
    }
  }
  // Even split (default): residual goes to first.
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

export interface SrcApi {
  tx: {
    Balances?: { transfer_keep_alive: (args: unknown) => UnsignedTx }
    ForeignAssets?: { transfer_keep_alive: (args: unknown) => UnsignedTx }
    Assets?: { transfer_keep_alive: (args: unknown) => UnsignedTx }
    Utility: { batch_all: (args: { calls: unknown[] }) => UnsignedTx }
    PolkadotXcm: { transfer_assets_using_type_and_then: (args: unknown) => UnsignedTx }
    AssetConversion?: { swap_tokens_for_exact_tokens: (args: unknown) => UnsignedTx }
  }
  apis?: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
}

export interface PapiTxOptions {
  asset?: unknown
  customSignedExtensions?: Record<string, { value?: Uint8Array | unknown; additionalSigned?: Uint8Array | unknown }>
}

/**
 * Force `CheckMetadataHash` to `Mode::Disabled` so PAPI doesn't include a
 * metadataHash in the SignerPayload. Mirrors polkadot.js apps's behavior.
 * Kept defensively even though the actual crash culprit was elsewhere
 * (`ChargeAssetTxPayment.assetId` with a cross-consensus Location, see
 * `assertSafeFeeAsset`). The chain accepts both Disabled and Enabled modes,
 * so this is a no-op on the runtime side.
 */
export const SIGNED_EXT_OVERRIDE: NonNullable<PapiTxOptions['customSignedExtensions']> = {
  CheckMetadataHash: {
    value: new Uint8Array([0]),       // Mode::Disabled
    additionalSigned: new Uint8Array([0]),  // Option::None for the metadata hash
  },
}

/** Wrap a `PolkadotSigner` so `onSigned` fires the moment the wallet returns
 *  the signed bytes — i.e. between "waiting for signature in extension" and
 *  "waiting for block inclusion". PAPI's `signAndSubmit` collapses both into
 *  a single Promise so the UI otherwise has no way to distinguish them. */
export function watchSigner(signer: PolkadotSigner, onSigned: () => void): PolkadotSigner {
  return new Proxy(signer, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver) as unknown
      if (prop !== 'signTx') return orig
      return (...args: unknown[]) => {
        const result = (orig as (...a: unknown[]) => unknown).apply(target, args)
        if (result instanceof Promise) {
          return result.then((value) => {
            try { onSigned() } catch { /* swallow — phase is best-effort */ }
            return value
          })
        }
        try { onSigned() } catch { /* swallow */ }
        return result
      }
    },
  })
}

export function withSignedExtOverride(opts?: PapiTxOptions): PapiTxOptions {
  return {
    ...(opts ?? {}),
    customSignedExtensions: { ...SIGNED_EXT_OVERRIDE, ...(opts?.customSignedExtensions ?? {}) },
  }
}

/**
 * The polkadot-js-extension and SubWallet bundle a polkadot.js types library
 * whose `TAssetConversion` decoder cannot handle V5 cross-consensus Locations
 * (e.g. `parents:2, X4[GlobalConsensus(Polkadot), Parachain(1000),
 * PalletInstance(50), GeneralIndex(1337)]`) when used as the `assetId` of the
 * `ChargeAssetTxPayment` signed extension. Decoding fails with
 * "Unable to create Enum via index 9, in Here, X1..X8" and the React error
 * boundary leaves the extension UI corrupted until browser restart.
 *
 * Detect the unsafe shape (`parents >= 2 && interior contains GlobalConsensus`)
 * and throw a clear error instead of letting the wallet crash. PAH-local USDC
 * (`parents:0, X2[PalletInstance, GeneralIndex]`) is fine.
 */
export function isCrossConsensusLocation(loc: unknown): boolean {
  if (!loc || typeof loc !== 'object') return false
  const l = loc as { parents?: number; interior?: unknown }
  if ((l.parents ?? 0) < 2) return false
  const interior = l.interior as { type?: string; value?: unknown } | { X1?: unknown; X2?: unknown; X3?: unknown; X4?: unknown } | undefined
  if (!interior) return false
  // PAPI typed enum: { type: 'X4', value: [...] }
  const arr = (interior as { type?: string; value?: unknown }).type
    ? (interior as { value?: unknown }).value
    // pjs-style: { X4: [...] }
    : Object.values(interior).find(v => Array.isArray(v))
  const junctions = Array.isArray(arr) ? arr : null
  if (!junctions) return false
  return junctions.some(j => {
    if (!j || typeof j !== 'object') return false
    const jo = j as { type?: string } & Record<string, unknown>
    if (jo.type === 'GlobalConsensus') return true
    if ('GlobalConsensus' in jo) return true
    return false
  })
}

/** When true, `assertSafeFeeAsset` throws on cross-consensus assetIds — but
 *  only for wallets known to crash on them (see `KNOWN_FEE_ASSET_CRASH_WALLETS`).
 *  Stays enabled in production; the e2e tests (programmatic signer) disable
 *  it entirely. */
let safeFeeAssetEnforcement = true

/** Browser extensions that can't handle a V5 cross-consensus Location as
 *  `ChargeAssetTxPayment.assetId`. Failure modes differ:
 *  - **polkadot-js**, **subwallet-js**: bundled `@polkadot/types-known`
 *    mis-decodes the inner V5 Junction and crashes the signing popup. See
 *    https://github.com/polkadot-js/extension/issues/1618 and the matching
 *    SubWallet issue.
 *  - **talisman**, **nova-wallet**: the extension's fee-estimation
 *    pre-flight calls `TransactionPaymentApi.query_info` with the
 *    cross-consensus assetId and the asset hub runtime panics inside it
 *    (`wasm unreachable`), so the signing popup never opens.
 *
 *  Other wallets (Enkrypt, …) remain *unknown* — we don't preemptively block
 *  them, so users can confirm and we can add them here if reports arrive. */
export const KNOWN_FEE_ASSET_CRASH_WALLETS = new Set<string>([
  'polkadot-js',
  'subwallet-js',
  'talisman',
  'nova-wallet',
])

/** Active wallet's injected-extension identifier (e.g. `polkadot-js`).
 *  `null` when no wallet connected or in a test/programmatic context. */
let activeWalletId: string | null = null

export function setActiveWalletId(id: string | null): void {
  activeWalletId = id
}

export function setSafeFeeAssetEnforcement(enabled: boolean): void {
  safeFeeAssetEnforcement = enabled
}

export function assertSafeFeeAsset(opts?: PapiTxOptions): void {
  if (!safeFeeAssetEnforcement) return
  if (!opts?.asset) return
  if (!activeWalletId || !KNOWN_FEE_ASSET_CRASH_WALLETS.has(activeWalletId)) return
  if (isCrossConsensusLocation(opts.asset)) {
    throw new Error(
      `Cannot pay fees with a bridged asset (cross-consensus Location) in ${activeWalletId}: ` +
      'this wallet rejects or crashes on this shape in ' +
      '`ChargeAssetTxPayment.assetId`. ' +
      'Top up the source chain\'s native token (e.g. KSM on Asset Hub Kusama) ' +
      'so the dispatch fee can be paid in the native asset, or try a ' +
      'different wallet that\'s not yet on the known-affected list.',
    )
  }
}

export interface UnsignedTx {
  decodedCall: unknown
  getEstimatedFees: (sender: string, opts?: PapiTxOptions) => Promise<bigint>
  signAndSubmit: (signer: PolkadotSigner, opts?: PapiTxOptions) => Promise<{ txHash: string } | unknown>
}

/**
 * Tx fee asset for `signAndSubmit` / `getEstimatedFees`. On the asset hubs the
 * `pallet-asset-conversion-tx-payment` signed extension swaps the chosen asset
 * via the AssetConversion pool to pay the native fee — so a user holding only
 * USDC on PAH/KAH (no DOT/KSM) can still submit. The pool is registered for
 * USDC↔native on both asset hubs, so USDC works as the fee asset *regardless*
 * of what's being transferred — the `token` parameter is unused.
 */
function feeAssetFor(source: ChainId, _token: TokenSymbol): unknown | undefined {
  void _token
  // PAH and KAH both define `pallet_asset_conversion_tx_payment::Config::AssetId = Location`
  // (no Versioned wrapper) — pass the bare Location.
  if (source === 'pah') {
    return {
      parents: 0,
      interior: {
        type: 'X2',
        value: [
          { type: 'PalletInstance', value: 50 },
          { type: 'GeneralIndex', value: 1337n },
        ],
      },
    }
  }
  if (source === 'kah') {
    // On KAH, USDC is the foreign asset bridged from PAH.
    return {
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
  }
  return undefined
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
  const currency = { ...getCurrency(source, token), amount: amount }
  const tx = await Builder({ apiOverrides: overrides })
    .from(toParaSpell(source))
    .to(toParaSpell(dest))
    .currency(currency)
    .recipient(beneficiary)
    .sender(senderAddress)
    .build()
  return tx as unknown as UnsignedTx
}

async function buildPerRecipientCalls(
  params: DonateParams,
  senderAddress: string,
): Promise<UnsignedTx[]> {
  const { token, source, recipients, totalAmount, weights } = params
  const dest = destChainFor(token)
  const amounts = splitAmount(totalAmount, recipients.length, weights)

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
      const wrapped = await maybeWrapWithFeeSwap(srcApi, source, token, consolidated, senderAddress)
      return [wrapped]
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

  // Single-tx PAH→KAH USDC paths (e.g. one recipient, paraspell-built) also
  // need DOT for bridge delivery — wrap the lone call too.
  if (calls.length === 1 && source !== dest && token === 'USDC') {
    const wrapped = await maybeWrapWithFeeSwap(srcApi, source, token, calls[0], senderAddress)
    return [wrapped]
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
  const currency = { ...getCurrency(source, token), amount: totalAmount }
  const psTx = await Builder({ apiOverrides: overrides })
    .from(toParaSpell(source))
    .to(toParaSpell(dest))
    .currency(currency)
    .recipient(recipients[0].address)
    .sender(senderAddress)
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
  const beneficiaryFor = (addr: string) => {
    const idHex = '0x' + Array.from(ksmSs58.enc(addr)).map(b => b.toString(16).padStart(2, '0')).join('')
    return {
      parents: 0,
      interior: xcmStyle === 'papi'
        ? { type: 'X1', value: { type: 'AccountId32', value: { network: undefined, id: idHex } } }
        : { X1: { AccountId32: { network: null, id: idHex } } },
    }
  }

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
    const nativeMeta = sourceFeeAsset(params.source)

    function buildReady(strategy: FeeStrategy, totalNativeFee: bigint, mode: 'batch' | 'sequential', extraUsdc?: bigint): DonateState {
      const inAsset = strategy.txOpts?.asset !== undefined
      // For sequential mode the totalNativeFee is the sum across calls; for
      // batch it's already the strategy's nativeFee. extraUsdc lets the caller
      // pass a recomputed AMM quote for the totalNativeFee (see sequential).
      if (inAsset && extraUsdc !== undefined) {
        return {
          step: 'ready', fee: extraUsdc, feeSymbol: 'USDC', feeDecimals: 6,
          feeNative: totalNativeFee, feeNativeSymbol: nativeMeta.symbol, feeNativeDecimals: nativeMeta.decimals,
          mode, txOpts: strategy.txOpts,
        }
      }
      return {
        step: 'ready', fee: totalNativeFee, feeSymbol: nativeMeta.symbol, feeDecimals: nativeMeta.decimals,
        mode, txOpts: strategy.txOpts,
      }
    }

    const batch = await buildBatch(params.source, calls)
    if (batch) {
      try {
        const strategy = await decideFeeStrategy(params.source, params.token, batch, senderAddress)
        const dr = await dryRunFull(params.source, batch.decodedCall, senderAddress, params.recipients)
        if (!dr.sourceOk) {
          state = { step: 'error', message: dr.sourceMessage ?? 'Dry-run failed' }
          return
        }
        const failedDest = dr.destinations.find(d => !d.ok)
        if (failedDest) {
          state = { step: 'error', message: `Destination ${failedDest.destChain}: ${failedDest.errorMessage ?? 'dry-run failed'}` }
          return
        }
        const ready = buildReady(strategy, strategy.nativeFee, 'batch', strategy.usdcFee)
        if (ready.step === 'ready') ready.dryRun = dr
        state = ready
        return
      } catch (err) {
        console.warn('[donate] batch fee estimate failed; trying sequential', err)
      }
    }
    // Sequential fallback: decide strategy on the first call, sum native fees,
    // then re-quote AMM once for the total.
    const seqStrategy = await decideFeeStrategy(params.source, params.token, calls[0], senderAddress)
    // Dry-run each call (source + forwarded destinations) so we surface any pre-flight issue.
    const aggregated: DryRunSummary = { sourceOk: true, sourceMessage: null, destinations: [] }
    for (let i = 0; i < calls.length; i++) {
      const dr = await dryRunFull(params.source, calls[i].decodedCall, senderAddress, params.recipients)
      if (!dr.sourceOk) {
        state = { step: 'error', message: `Recipient ${i + 1}/${calls.length}: ${dr.sourceMessage ?? 'dry-run failed'}` }
        return
      }
      const failed = dr.destinations.find(d => !d.ok)
      if (failed) {
        state = { step: 'error', message: `Recipient ${i + 1}/${calls.length} → ${failed.destChain}: ${failed.errorMessage ?? 'dry-run failed'}` }
        return
      }
      aggregated.destinations.push(...dr.destinations)
    }
    let totalNative = 0n
    for (const call of calls) {
      try { totalNative += await call.getEstimatedFees(senderAddress, seqStrategy.txOpts) } catch { /* skip */ }
    }
    let totalUsdc: bigint | undefined
    if (seqStrategy.txOpts?.asset !== undefined && (params.source === 'pah' || params.source === 'kah')) {
      const q = await quoteUsdcForExactNative(params.source, totalNative)
      if (q !== null) totalUsdc = q
    }
    const seqReady = buildReady(seqStrategy, totalNative, 'sequential', totalUsdc)
    if (seqReady.step === 'ready') seqReady.dryRun = aggregated
    state = seqReady
  } catch (err) {
    state = { step: 'error', message: err instanceof Error ? err.message : 'Estimation failed' }
  }
}

/** Returns the source chain's native fee asset. `getEstimatedFees` always
 *  reports the partial-fee in native units regardless of `txOpts.asset`;
 *  the asset_id hint only changes what's swapped IN at submit time. */
export function sourceFeeAsset(source: ChainId): { symbol: string; decimals: number } {
  if (source === 'pah') return { symbol: 'DOT', decimals: 10 }
  return { symbol: 'KSM', decimals: 12 }
}

/** Existential deposit of the chain's native fee asset. */
function nativeED(source: ChainId): bigint {
  const nativeSymbol: TokenSymbol = source === 'pah' ? 'DOT' : 'KSM'
  try {
    const v = getExistentialDeposit(CHAINS[source].paraSpellName, getCurrency(source, nativeSymbol))
    return v ?? 0n
  } catch { return 0n }
}

// Asset-hub bridge-delivery fees are paid in NATIVE (DOT on PAH, KSM on KAH)
// from the user's account by the XcmRouter and aren't swappable from foreign
// assets by the runtime. We work around that by prepending a USDC→native
// `swap_tokens_for_exact_tokens` call to top up the user's native balance.
//
// Per the runtime constants:
//   * PAH→BridgeHubPolkadot HRMP   ≈ 0.03 DOT (`ToSiblingBaseDeliveryFee`)
//   * Polkadot↔Kusama bridge       ≈ 0.007 DOT (incl. confirmation)
//   → topup target 0.1 DOT, threshold 0.05 DOT.
//   * KAH→BridgeHubKusama HRMP     ≈ 0.03 KSM (`ToSiblingBaseDeliveryFee`)
//   * Kusama↔Polkadot bridge       ≈ similar magnitude
//   → topup target 0.05 KSM, threshold 0.025 KSM.
const SWAP_CONFIG: Partial<Record<ChainId, {
  threshold: bigint
  topup: bigint
  usdcMax: bigint
  nativeLoc: { parents: number; interior: { type: string; value: undefined } }
  usdcLoc: unknown
}>> = {
  pah: {
    threshold: 500_000_000n,   // 0.05 DOT (10 dec)
    topup: 1_000_000_000n,     // 0.1 DOT
    usdcMax: 5_000_000n,       // 5 USDC
    nativeLoc: { parents: 1, interior: { type: 'Here', value: undefined } },
    usdcLoc: {
      parents: 0,
      interior: {
        type: 'X2',
        value: [
          { type: 'PalletInstance', value: 50 },
          { type: 'GeneralIndex', value: 1337n },
        ],
      },
    },
  },
  kah: {
    threshold: 25_000_000_000n,  // 0.025 KSM (12 dec)
    topup: 50_000_000_000n,      // 0.05 KSM
    usdcMax: 5_000_000n,          // 5 USDC
    nativeLoc: { parents: 1, interior: { type: 'Here', value: undefined } },
    usdcLoc: {
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
    },
  },
}

/**
 * Build an `AssetConversion.swap_tokens_for_exact_tokens` call that swaps
 * USDC for `topup` of native (DOT on PAH, KSM on KAH), depositing into
 * `sender`. Used to top up native for bridge delivery fees when needed.
 */
function buildFeeSwapCall(srcApi: SrcApi, source: ChainId, sender: string): UnsignedTx | null {
  const cfg = SWAP_CONFIG[source]
  if (!cfg) return null
  const ac = srcApi.tx.AssetConversion
  if (!ac?.swap_tokens_for_exact_tokens) {
    console.warn(`[xcmFlow] AssetConversion.swap_tokens_for_exact_tokens unavailable on ${source}`)
    return null
  }
  // pallet-asset-conversion's signature is `send_to: T::AccountId` (raw
  // AccountId32, NOT a MultiAddress lookup). Pass the SS58 string directly.
  return ac.swap_tokens_for_exact_tokens({
    path: [cfg.usdcLoc, cfg.nativeLoc],
    amount_out: cfg.topup,
    amount_in_max: cfg.usdcMax,
    send_to: sender,
    keep_alive: true,
  })
}

/**
 * Wrap the donation/transfer tx with an optional preceding USDC→native swap
 * so that the bridge delivery fee can be paid from native (DOT on PAH, KSM on
 * KAH). Skips the swap if the user already has enough native, OR if the
 * source isn't an asset hub, OR if the donation token isn't USDC.
 *
 * The wrapping uses `Utility.batch_all` so the swap and the donation are an
 * atomic unit under one signature.
 */
export async function maybeWrapWithFeeSwap(
  srcApi: SrcApi,
  source: ChainId,
  token: TokenSymbol,
  donation: UnsignedTx,
  sender: string,
): Promise<UnsignedTx> {
  if (token !== 'USDC') return donation
  const cfg = SWAP_CONFIG[source]
  if (!cfg) return donation
  const native = await fetchNativeBalance(source, sender)
  const meta = sourceFeeAsset(source)
  const fmt = (v: bigint) => `${(Number(v) / 10 ** meta.decimals).toFixed(6)} ${meta.symbol}`
  if (native !== null && native >= cfg.threshold) {
    console.log(`[xcmFlow] ${source} native balance ${fmt(native)} ≥ threshold ${fmt(cfg.threshold)}; skipping fee-swap`)
    return donation
  }
  console.log(`[xcmFlow] ${source} native balance ${native !== null ? fmt(native) : 'unknown'} < threshold ${fmt(cfg.threshold)}; prepending USDC→${meta.symbol} swap (target ${fmt(cfg.topup)})`)
  const swap = buildFeeSwapCall(srcApi, source, sender)
  if (!swap) return donation
  return srcApi.tx.Utility.batch_all({
    calls: [swap.decodedCall, donation.decodedCall],
  })
}

interface ForwardedXcm {
  destination: unknown
  xcms: unknown[]
}

interface DryRunResult {
  ok: boolean
  /** Human-readable summary on failure; null on success. */
  errorMessage: string | null
  /** Raw effects for logging. */
  raw: unknown
  /** XCMs the source chain would forward to other chains. */
  forwarded: ForwardedXcm[]
  /** Events emitted during dry-run (for balance extraction). */
  events: unknown[]
}

interface DestinationDryRunResult {
  destChain: ChainId
  ok: boolean
  errorMessage: string | null
  events: unknown[]
}

export interface RecipientReceipt {
  address: string
  label: string
  received: bigint
}

export interface BalanceImpact {
  /** USDC delta on the sender's source account (negative = outflow). Includes
   *  donation amount, swap input, and any fees taken in USDC. */
  sourceUsdcDelta: bigint
  /** Native (DOT/KSM) delta on the sender's source account. */
  sourceNativeDelta: bigint
  /** Sender's native balance after the tx — `null` if the current balance
   *  query failed. */
  sourceNativeFinal: bigint | null
  /** Per-recipient USDC actually received on the destination (after transit). */
  recipientReceipts: RecipientReceipt[]
}

export interface DryRunSummary {
  sourceOk: boolean
  sourceMessage: string | null
  destinations: DestinationDryRunResult[]
  balance?: BalanceImpact
}

/**
 * Run pallet-xcm's DryRunApi.dry_run_call against the source chain to find out
 * what would happen — including dispatch errors, emitted events, the locally
 * generated XCM, and any forwarded XCMs (relay→bridge→KAH for PAH→KAH USDC).
 * Logs everything verbosely. Used as a pre-confirmation check.
 */
async function dryRunTx(
  source: ChainId,
  decodedCall: unknown,
  senderAddress: string,
): Promise<DryRunResult> {
  const tag = `[dry-run] ${source}`
  const client = getClient(source)
  if (!client) {
    console.warn(`${tag} skipped: no client`)
    return { ok: true, errorMessage: null, raw: null, forwarded: [], events: [] }
  }
  const api = client.getUnsafeApi() as unknown as SrcApi
  const dryRunApi = api.apis?.DryRunApi
  if (!dryRunApi || typeof dryRunApi.dry_run_call !== 'function') {
    console.warn(`${tag} skipped: chain has no DryRunApi`)
    return { ok: true, errorMessage: null, raw: null, forwarded: [], events: [] }
  }
  const origin = { type: 'system', value: { type: 'Signed', value: senderAddress } }
  const xcmVersion = 5
  console.log(`${tag} call:`, JSON.stringify(decodedCall, (_k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v, 2))
  console.log(`${tag} origin:`, origin, 'xcm_version:', xcmVersion)
  let raw: unknown
  try {
    raw = await dryRunApi.dry_run_call(origin, decodedCall, xcmVersion)
  } catch (err) {
    console.warn(`${tag} runtime call threw:`, err)
    return { ok: true, errorMessage: null, raw: err, forwarded: [], events: [] }
  }
  console.log(`${tag} raw result:`, JSON.stringify(raw, (_k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v, 2))

  const r = raw as { success?: boolean; value?: unknown }
  if (r?.success === false) {
    const errStr = stringifyShallow(r.value)
    console.error(`${tag} ✗ DryRunApi rejected:`, errStr)
    return { ok: false, errorMessage: `DryRunApi error: ${errStr}`, raw, forwarded: [], events: [] }
  }
  const eff = (r?.value ?? r) as {
    execution_result?: { success?: boolean; value?: unknown }
    emitted_events?: unknown[]
    local_xcm?: unknown
    forwarded_xcms?: Array<[unknown, unknown[]] | { 0: unknown; 1: unknown[] }>
  }

  if (eff.local_xcm) console.log(`${tag} local_xcm:`, JSON.stringify(eff.local_xcm, (_k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v, 2))

  const forwarded: ForwardedXcm[] = []
  if (eff.forwarded_xcms?.length) {
    console.log(`${tag} forwarded_xcms (${eff.forwarded_xcms.length}):`)
    for (const fwd of eff.forwarded_xcms) {
      console.log('  →', JSON.stringify(fwd, (_k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v, 2))
      // Tuples come through as arrays [dest, xcms[]] in PAPI's untyped form.
      const arr = fwd as unknown as [unknown, unknown[]]
      if (Array.isArray(arr) && arr.length === 2) {
        forwarded.push({ destination: arr[0], xcms: Array.isArray(arr[1]) ? arr[1] : [] })
      }
    }
  }
  if (eff.emitted_events?.length) {
    console.log(`${tag} emitted_events (${eff.emitted_events.length}):`)
    for (const ev of eff.emitted_events) console.log('  •', stringifyShallow(ev))
  }

  const exec = eff.execution_result
  if (exec && exec.success === false) {
    const reason = stringifyShallow(exec.value)
    console.error(`${tag} ✗ dispatch would fail:`, reason)
    return { ok: false, errorMessage: `Dispatch error: ${reason}`, raw, forwarded: [], events: eff.emitted_events ?? [] }
  }
  console.log(`${tag} ✓ dispatch would succeed`)
  return { ok: true, errorMessage: null, raw, forwarded, events: eff.emitted_events ?? [] }
}

/**
 * Identify a known dapp ChainId from a forwarded-XCM `destination` location.
 * Returns null when the immediate destination is something we don't have a
 * PAPI client for (e.g. BridgeHubPolkadot for cross-consensus bridging).
 */
function chainFromDestLocation(source: ChainId, dest: unknown): ChainId | null {
  if (!dest || typeof dest !== 'object') return null
  // VersionedLocation: { type: 'V5', value: { parents, interior } }
  const v = (dest as { value?: unknown }).value ?? dest
  const loc = v as { parents?: number; interior?: { type?: string; value?: unknown } }
  if (loc.parents !== 1) return null
  const interior = loc.interior
  if (interior?.type !== 'X1') return null
  const inner = interior.value as { type?: string; value?: unknown } | Array<{ type?: string; value?: unknown }>
  const j = Array.isArray(inner) ? inner[0] : inner
  if (j?.type !== 'Parachain' || typeof j.value !== 'number') return null
  const para = j.value
  // Sibling parachain — map by para id within the source's consensus.
  if (source === 'kah' && para === 1001) return 'encointer'
  if (source === 'encointer' && para === 1000) return 'kah'
  // PAH/KAH self loops or BridgeHub etc. aren't dapp chains.
  return null
}

/**
 * Re-anchor the source chain's location to be expressed from the destination's
 * perspective, for use as `origin_location` in `dry_run_xcm`.
 */
function originLocationFromTo(from: ChainId, to: ChainId): unknown | null {
  const PARACHAIN_ID: Record<ChainId, number> = { encointer: 1001, kah: 1000, pah: 1000 }
  // Sibling parachains within the same consensus.
  if ((from === 'kah' && to === 'encointer') || (from === 'encointer' && to === 'kah')) {
    return {
      type: 'V5',
      value: {
        parents: 1,
        interior: { type: 'X1', value: [{ type: 'Parachain', value: PARACHAIN_ID[from] }] },
      },
    }
  }
  // Cross-consensus: bridged Polkadot ↔ Kusama (PAH ↔ KAH).
  if (from === 'pah' && to === 'kah') {
    return {
      type: 'V5',
      value: {
        parents: 2,
        interior: {
          type: 'X2',
          value: [
            { type: 'GlobalConsensus', value: { type: 'Polkadot', value: undefined } },
            { type: 'Parachain', value: 1000 },
          ],
        },
      },
    }
  }
  if (from === 'kah' && to === 'pah') {
    return {
      type: 'V5',
      value: {
        parents: 2,
        interior: {
          type: 'X2',
          value: [
            { type: 'GlobalConsensus', value: { type: 'Kusama', value: undefined } },
            { type: 'Parachain', value: 1000 },
          ],
        },
      },
    }
  }
  return null
}

/**
 * Find the `PolkadotXcm.transfer_assets_using_type_and_then` args inside a
 * (possibly batch-wrapped) decodedCall. Returns null if the call isn't a
 * bridged-transfer dispatch.
 */
function extractTransferAssetsArgs(call: unknown): Record<string, unknown> | null {
  if (!call || typeof call !== 'object') return null
  const c = call as { type?: string; value?: unknown }
  if (c.type === 'PolkadotXcm') {
    const inner = c.value as { type?: string; value?: unknown } | undefined
    if (inner?.type === 'transfer_assets_using_type_and_then') {
      return inner.value as Record<string, unknown>
    }
  }
  if (c.type === 'Utility') {
    const inner = c.value as { type?: string; value?: unknown } | undefined
    if (inner?.type === 'batch_all') {
      const calls = (inner.value as { calls?: unknown[] } | undefined)?.calls ?? []
      for (const sub of calls) {
        const found = extractTransferAssetsArgs(sub)
        if (found) return found
      }
    }
  }
  return null
}

/**
 * Build the XCM that the destination chain would execute when the source's
 * `transfer_assets_using_type_and_then` lands. Bridge transit is assumed
 * transparent. The first instruction depends on `assets_transfer_type`:
 *
 *   - `LocalReserve` (origin holds reserve, e.g. PAH→KAH USDC)
 *     → destination receives `ReserveAssetDeposited` (mints mirror).
 *   - `DestinationReserve` (destination holds reserve, e.g. KAH→PAH USDC)
 *     → destination receives `WithdrawAsset` (releases canonical from sov).
 *
 * Returns the V5-wrapped XCM ready for `DryRunApi.dry_run_xcm`.
 */
function buildArrivalXcmFromTransferArgs(args: Record<string, unknown>): unknown {
  const assetsVer = args.assets as { value?: Array<{ id: unknown; fun: unknown }> } | undefined
  const sourceAssetEntry = assetsVer?.value?.[0]
  const customXcmVer = args.custom_xcm_on_dest as { value?: unknown[] } | undefined
  const customInstructions = customXcmVer?.value ?? []

  // The asset id from the DESTINATION's perspective is what `BuyExecution.fees.id`
  // already references inside customXcmOnDest. Reuse it; for the deposited
  // amount we use the source-side `assets[0].amount` (transparent bridge).
  let destAssetId: unknown = null
  for (const ins of customInstructions) {
    const x = ins as { type?: string; value?: { fees?: { id?: unknown } } }
    if (x.type === 'BuyExecution' && x.value?.fees?.id) {
      destAssetId = x.value.fees.id
      break
    }
  }
  if (!destAssetId || !sourceAssetEntry) return null

  const totalAmount = (sourceAssetEntry.fun as { value?: bigint })?.value ?? 0n

  // Detect transfer type. PAPI emits enum form `{ type: 'X', value: ... }`;
  // paraspell may also use bare strings. Fall back to LocalReserve.
  const xferType = args.assets_transfer_type as { type?: string } | string | undefined
  const xferTag = typeof xferType === 'string' ? xferType : xferType?.type
  const arrivalInstr = xferTag === 'DestinationReserve' ? 'WithdrawAsset' : 'ReserveAssetDeposited'

  return {
    type: 'V5',
    value: [
      {
        type: arrivalInstr,
        value: [{ id: destAssetId, fun: { type: 'Fungible', value: totalAmount } }],
      },
      { type: 'ClearOrigin', value: undefined },
      ...customInstructions,
    ],
  }
}

async function dryRunXcmOn(
  destChain: ChainId,
  xcm: unknown,
  originLoc: unknown,
  sourceTag: string,
): Promise<DestinationDryRunResult | null> {
  const tag = `[dry-run] ${destChain} (${sourceTag})`
  const client = getClient(destChain)
  if (!client) return { destChain, ok: false, errorMessage: 'destination chain client unavailable', events: [] }
  const api = client.getUnsafeApi() as unknown as SrcApi
  const dryRunApi = api.apis?.DryRunApi
  if (!dryRunApi || typeof dryRunApi.dry_run_xcm !== 'function') {
    console.warn(`${tag} skipped: chain has no DryRunApi.dry_run_xcm`)
    return null
  }
  console.log(`${tag} origin:`, originLoc)
  console.log(`${tag} xcm:`, JSON.stringify(xcm, (_k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v, 2))
  try {
    const raw = await dryRunApi.dry_run_xcm(originLoc, xcm)
    console.log(`${tag} raw result:`, JSON.stringify(raw, (_k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v, 2))
    const r = raw as { success?: boolean; value?: unknown }
    if (r?.success === false) {
      const msg = `DryRunApi error: ${stringifyShallow(r.value)}`
      console.error(`${tag} ✗ ${msg}`)
      return { destChain, ok: false, errorMessage: msg, events: [] }
    }
    const eff = (r?.value ?? r) as { execution_result?: unknown; emitted_events?: unknown[] }
    const outcome = eff?.execution_result as { type?: string; value?: unknown } | undefined
    if (outcome?.type && outcome.type !== 'Complete') {
      const msg = `XCM ${outcome.type}: ${stringifyShallow(outcome.value)}`
      console.error(`${tag} ✗ ${msg}`)
      return { destChain, ok: false, errorMessage: msg, events: eff.emitted_events ?? [] }
    }
    console.log(`${tag} ✓ XCM would execute Complete`)
    return { destChain, ok: true, errorMessage: null, events: eff.emitted_events ?? [] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`${tag} runtime call threw:`, err)
    // PAPI v2 throws "Incompatible runtime entry" when the chain's metadata
    // doesn't match the descriptors PAPI expects for `DryRunApi.dry_run_xcm`.
    // Some forks (notably Encointer on chopsticks) hit this even though the
    // chain itself supports the call in production. Treat as "dry-run
    // unavailable" rather than as an actual failure — it shouldn't block the
    // user's flow.
    if (/Incompatible runtime entry RuntimeCall\(DryRunApi_dry_run_xcm\)/.test(msg)) {
      console.warn(`${tag} skipped: chain rejects DryRunApi.dry_run_xcm via PAPI compat`)
      return null
    }
    return { destChain, ok: false, errorMessage: msg, events: [] }
  }
}

/** Identify the donation's true destination chain from `transfer_assets_using_type_and_then`'s `dest`. */
function chainFromTransferDest(source: ChainId, dest: unknown): ChainId | null {
  if (!dest || typeof dest !== 'object') return null
  const v = (dest as { value?: unknown }).value ?? dest
  const loc = v as { parents?: number; interior?: { type?: string; value?: unknown } }

  // Cross-consensus: parents:2, X2[GlobalConsensus(...), Parachain(N)]
  if (loc.parents === 2 && loc.interior?.type === 'X2') {
    const arr = loc.interior.value as Array<{ type?: string; value?: { type?: string } | number }> | undefined
    if (arr?.length === 2) {
      const gc = arr[0]
      const para = arr[1]
      const consensus = (gc?.value as { type?: string } | undefined)?.type
      if (gc?.type === 'GlobalConsensus' && para?.type === 'Parachain' && para.value === 1000) {
        if (source === 'pah' && consensus === 'Kusama') return 'kah'
        if (source === 'kah' && consensus === 'Polkadot') return 'pah'
      }
    }
  }
  // Sibling within consensus.
  if (loc.parents === 1 && loc.interior?.type === 'X1') {
    const inner = loc.interior.value as { type?: string; value?: number } | Array<{ type?: string; value?: number }>
    const j = Array.isArray(inner) ? inner[0] : inner
    if (j?.type === 'Parachain') {
      const para = j.value
      if (source === 'kah' && para === 1001) return 'encointer'
      if (source === 'encointer' && para === 1000) return 'kah'
    }
  }
  return null
}

async function dryRunOnSiblingForward(
  source: ChainId,
  fwd: ForwardedXcm,
): Promise<DestinationDryRunResult | null> {
  const destChain = chainFromDestLocation(source, fwd.destination)
  if (!destChain) {
    console.log('[dry-run] skipping forwarded XCM destination (no client):', fwd.destination)
    return null
  }
  const originLoc = originLocationFromTo(source, destChain)
  if (!originLoc) return null
  // Run each forwarded XCM under the same origin; report the worst outcome.
  let last: DestinationDryRunResult | null = null
  for (const xcm of fwd.xcms) {
    last = await dryRunXcmOn(destChain, xcm, originLoc, `forwarded from ${source}`)
    if (last && !last.ok) return last
  }
  return last
}

// ───────────────────── balance-impact extraction ─────────────────────

function evField<T = unknown>(v: unknown, ...keys: string[]): T | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  for (const k of keys) if (k in o) return o[k] as T
  return undefined
}

function findEvents(events: unknown[], pallet: string, eventName: string): unknown[] {
  const out: unknown[] = []
  for (const e of events) {
    const ev = e as { type?: string; value?: { type?: string; value?: unknown } }
    if (ev?.type === pallet && ev.value?.type === eventName) out.push(ev.value.value)
  }
  return out
}

function ss58Eq(a: string | undefined, b: string): boolean {
  if (!a) return false
  if (a === b) return true
  const ai = getSs58AddressInfo(a)
  const bi = getSs58AddressInfo(b)
  if (!ai.isValid || !bi.isValid) return false
  if (ai.publicKey.length !== bi.publicKey.length) return false
  for (let i = 0; i < ai.publicKey.length; i++) if (ai.publicKey[i] !== bi.publicKey[i]) return false
  return true
}

function asBigInt(v: unknown): bigint | null {
  if (v == null) return null
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') return BigInt(v)
  if (typeof v === 'string') return BigInt(v.replace(/,/g, ''))
  return null
}

function isUsdcAssetId(source: ChainId, assetId: unknown): boolean {
  if (source === 'pah') {
    // PAH local pallet-assets uses u32 id 1337.
    return typeof assetId === 'number' && assetId === 1337
  }
  // KAH foreign asset uses Location id { parents: 2, X4[GC, Para(1000), PI(50), GI(1337)] }.
  const loc = assetId as { parents?: number; interior?: { type?: string; value?: unknown } } | null
  if (!loc) return false
  if (loc.parents !== 2 || loc.interior?.type !== 'X4') return false
  const arr = loc.interior.value as Array<{ type?: string; value?: unknown }> | undefined
  if (!arr || arr.length !== 4) return false
  const gi = arr[3] as { type?: string; value?: unknown } | undefined
  return gi?.type === 'GeneralIndex' && asBigInt(gi.value) === 1337n
}

function summariseEventTypes(tag: string, events: unknown[]) {
  if (!events.length) return
  const counts = new Map<string, number>()
  for (const e of events) {
    const ev = e as { type?: string; value?: { type?: string } }
    const key = `${ev?.type ?? '?'}.${ev?.value?.type ?? '?'}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  console.log(`[dry-run] ${tag} event types:`, [...counts.entries()].map(([k, n]) => `${k}×${n}`).join(', '))
}

function extractSourceUsdcDelta(source: ChainId, sender: string, events: unknown[]): bigint {
  const palletKey = source === 'pah' ? 'Assets' : 'ForeignAssets'
  let delta = 0n
  // Outflows from sender — pallet-assets emits `Withdrawn { asset_id, who, amount }`
  // for asset-conversion swaps and similar. Older variants used `Burned`.
  for (const ev of findEvents(events, palletKey, 'Withdrawn').concat(findEvents(events, palletKey, 'Burned'))) {
    const who = evField<string>(ev, 'who', 'owner')
    const id = evField(ev, 'asset_id')
    const amt = asBigInt(evField(ev, 'amount', 'balance'))
    if (amt != null && isUsdcAssetId(source, id) && ss58Eq(who, sender)) delta -= amt
  }
  // Inflows to sender (rare on source side, but defensive).
  for (const ev of findEvents(events, palletKey, 'Deposited').concat(findEvents(events, palletKey, 'Issued'))) {
    const who = evField<string>(ev, 'who', 'owner')
    const id = evField(ev, 'asset_id')
    const amt = asBigInt(evField(ev, 'amount', 'balance'))
    if (amt != null && isUsdcAssetId(source, id) && ss58Eq(who, sender)) delta += amt
  }
  // Transfers — pallet-assets emits `Transferred { asset_id, from, to, amount }`
  // when reserve-transferring to the bridge sovereign account.
  for (const ev of findEvents(events, palletKey, 'Transferred')) {
    const from = evField<string>(ev, 'from')
    const to = evField<string>(ev, 'to')
    const id = evField(ev, 'asset_id')
    const amt = asBigInt(evField(ev, 'amount', 'balance'))
    if (amt == null || !isUsdcAssetId(source, id)) continue
    if (ss58Eq(from, sender)) delta -= amt
    if (ss58Eq(to, sender)) delta += amt
  }
  return delta
}

function extractSourceNativeDelta(sender: string, events: unknown[]): bigint {
  let delta = 0n
  for (const ev of findEvents(events, 'Balances', 'Withdraw')) {
    const who = evField<string>(ev, 'who')
    const amt = asBigInt(evField(ev, 'amount'))
    if (amt != null && ss58Eq(who, sender)) delta -= amt
  }
  for (const ev of findEvents(events, 'Balances', 'Deposit')) {
    const who = evField<string>(ev, 'who')
    const amt = asBigInt(evField(ev, 'amount'))
    if (amt != null && ss58Eq(who, sender)) delta += amt
  }
  // pallet_balances::transfer_keep_alive emits a single `Transfer` event
  // (no separate Withdraw + Deposit), so we need to count that too.
  for (const ev of findEvents(events, 'Balances', 'Transfer')) {
    const from = evField<string>(ev, 'from')
    const to = evField<string>(ev, 'to')
    const amt = asBigInt(evField(ev, 'amount'))
    if (amt == null) continue
    if (ss58Eq(from, sender)) delta -= amt
    if (ss58Eq(to, sender)) delta += amt
  }
  return delta
}

function extractRecipientReceipts(
  destChain: ChainId,
  recipients: DonateRecipient[],
  events: unknown[],
): RecipientReceipt[] {
  const sums = new Map<string, bigint>(recipients.map(r => [r.address, 0n]))
  // Token-asset events (Deposited / Issued / Transferred) for both pallets —
  // covers same-chain transfers via Assets/ForeignAssets and XCM-mediated
  // mints into recipient accounts.
  for (const palletKey of ['ForeignAssets', 'Assets'] as const) {
    for (const ev of findEvents(events, palletKey, 'Deposited').concat(findEvents(events, palletKey, 'Issued'))) {
      const who = evField<string>(ev, 'who', 'owner')
      const amt = asBigInt(evField(ev, 'amount', 'balance'))
      if (!who || amt == null) continue
      for (const r of recipients) {
        if (ss58Eq(who, r.address)) sums.set(r.address, (sums.get(r.address) ?? 0n) + amt)
      }
    }
    for (const ev of findEvents(events, palletKey, 'Transferred')) {
      const to = evField<string>(ev, 'to')
      const amt = asBigInt(evField(ev, 'amount', 'balance'))
      if (!to || amt == null) continue
      for (const r of recipients) {
        if (ss58Eq(to, r.address)) sums.set(r.address, (sums.get(r.address) ?? 0n) + amt)
      }
    }
  }
  // Native-token transfers via pallet_balances (Balances.Transfer { from, to, amount }).
  for (const ev of findEvents(events, 'Balances', 'Transfer')) {
    const to = evField<string>(ev, 'to')
    const amt = asBigInt(evField(ev, 'amount'))
    if (!to || amt == null) continue
    for (const r of recipients) {
      if (ss58Eq(to, r.address)) sums.set(r.address, (sums.get(r.address) ?? 0n) + amt)
    }
  }
  // destChain is unused here — we filter by recipient address; pallets are
  // tried in turn so the same helper covers PAH local Assets, KAH/PAH foreign
  // assets, and native (DOT/KSM) Balances transfers.
  void destChain
  return recipients.map(r => ({ address: r.address, label: r.label, received: sums.get(r.address) ?? 0n }))
}

/**
 * Source-side dry-run + per-destination dry-runs.
 *
 * For bridged transfers (`transfer_assets_using_type_and_then`), we treat the
 * bridge as transparent: the destination chain receives the assets as
 * `ReserveAssetDeposited` followed by our `customXcmOnDest`. We construct that
 * synthetic XCM and dry-run it on the *true* destination (KAH) instead of the
 * intermediate BridgeHub.
 *
 * For sibling teleports (`limited_teleport_assets`), we use the source's
 * `forwarded_xcms` directly against the sibling destination.
 */
export async function dryRunFull(
  source: ChainId,
  decodedCall: unknown,
  senderAddress: string,
  recipients: DonateRecipient[],
): Promise<DryRunSummary> {
  const src = await dryRunTx(source, decodedCall, senderAddress)
  const summary: DryRunSummary = {
    sourceOk: src.ok,
    sourceMessage: src.errorMessage,
    destinations: [],
  }
  if (!src.ok) return summary

  let destChainCovered: ChainId | null = null
  let destEvents: unknown[] = []

  // 1. Bridged-transfer path: synthetic destination XCM, dry-run on the true dest.
  const transferArgs = extractTransferAssetsArgs(decodedCall)
  if (transferArgs) {
    const destChain = chainFromTransferDest(source, transferArgs.dest)
    if (destChain && destChain !== source) {
      const arrivalXcm = buildArrivalXcmFromTransferArgs(transferArgs)
      const originLoc = originLocationFromTo(source, destChain)
      if (arrivalXcm && originLoc) {
        const r = await dryRunXcmOn(destChain, arrivalXcm, originLoc, `synthetic from ${source}`)
        if (r) {
          summary.destinations.push(r)
          destChainCovered = destChain
          destEvents = r.events
        }
      }
    }
  }

  // 2. Sibling teleports & other forwards: use forwarded_xcms directly.
  for (const fwd of src.forwarded) {
    const dc = chainFromDestLocation(source, fwd.destination)
    if (dc && dc === destChainCovered) continue
    const r = await dryRunOnSiblingForward(source, fwd)
    if (r) {
      summary.destinations.push(r)
      if (r.ok && !destChainCovered) {
        destChainCovered = r.destChain
        destEvents = r.events
      }
    }
  }

  // 3. Compute balance impact from collected events.
  if (src.ok) {
    summariseEventTypes(`source ${source}`, src.events)
    if (destChainCovered) summariseEventTypes(`dest ${destChainCovered}`, destEvents)
    // Detailed dump for the first few asset/balance/foreign-asset events.
    const interesting = [...src.events, ...destEvents].filter(e => {
      const ev = e as { type?: string }
      return ev?.type === 'Assets' || ev?.type === 'ForeignAssets' || ev?.type === 'Balances' || ev?.type === 'AssetConversion'
    })
    for (const ev of interesting.slice(0, 30)) {
      console.log('[dry-run] event sample:', JSON.stringify(ev, (_k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v))
    }
    const sourceUsdcDelta = extractSourceUsdcDelta(source, senderAddress, src.events)
    const sourceNativeDelta = extractSourceNativeDelta(senderAddress, src.events)
    const currentNative = await fetchNativeBalance(source, senderAddress)
    const sourceNativeFinal = currentNative !== null ? currentNative + sourceNativeDelta : null
    const recipientReceipts = destChainCovered
      ? extractRecipientReceipts(destChainCovered, recipients, destEvents)
      // No remote destination — same-chain transfer. Read receipts from the
      // source-side events (Balances.Transfer / Assets.Transferred etc.).
      : extractRecipientReceipts(source, recipients, src.events)
    summary.balance = { sourceUsdcDelta, sourceNativeDelta, sourceNativeFinal, recipientReceipts }
    console.log('[dry-run] balance impact:', {
      sourceUsdcDelta: sourceUsdcDelta.toString(),
      sourceNativeDelta: sourceNativeDelta.toString(),
      sourceNativeFinal: sourceNativeFinal?.toString() ?? null,
      recipientReceipts: recipientReceipts.map(r => ({ label: r.label, received: r.received.toString() })),
    })
  }
  return summary
}

function stringifyShallow(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? x.toString() + 'n' : x)
  } catch {
    return String(v)
  }
}

/** Read source-chain native (free) balance for `address`. */
export async function fetchNativeBalance(source: ChainId, address: string): Promise<bigint | null> {
  const client = getClient(source)
  if (!client) return null
  try {
    const api = client.getUnsafeApi() as unknown as {
      query: { System: { Account: { getValue: (a: string) => Promise<{ data: { free: bigint } }> } } }
    }
    const acc = await api.query.System.Account.getValue(address)
    return acc.data.free
  } catch (err) {
    console.warn(`[donate] native balance query failed for ${source}`, err)
    return null
  }
}

/**
 * Pick fee asset:
 *  1. Estimate the fee in NATIVE (no asset option).
 *  2. If the user holds at least that much native, use the native path.
 *  3. Otherwise — and only when an asset path exists for this combo — switch
 *     to asset-conversion (USDC on the asset hubs) and re-estimate.
 *  4. If both fail, the last successful estimate's strategy is used.
 */
export interface FeeStrategy {
  txOpts: PapiTxOptions | undefined
  /** Fee in NATIVE units (what the runtime returns from getEstimatedFees). */
  nativeFee: bigint
  /** USDC base units the user actually pays (AMM-quoted). Only set when
   *  txOpts.asset is in use. */
  usdcFee?: bigint
}

export async function decideFeeStrategy(
  source: ChainId,
  token: TokenSymbol,
  primaryTx: UnsignedTx,
  senderAddress: string,
): Promise<FeeStrategy> {
  const tag = `[fee] ${source}/${token}`
  let txOpts: PapiTxOptions | undefined = undefined
  let fee: bigint | null = null

  const nativeMeta = sourceFeeAsset(source)
  const fmtNative = (v: bigint) => `${(Number(v) / 10 ** nativeMeta.decimals).toFixed(6)} ${nativeMeta.symbol}`

  // Step 1: native estimate.
  try {
    fee = await primaryTx.getEstimatedFees(senderAddress)
    console.log(`${tag} native fee estimate = ${fee} planck (${fmtNative(fee)})`)
  } catch (err) {
    console.warn(`${tag} native fee estimate failed; will try asset-conversion path`, err)
  }

  // Step 2: enough native to cover fee AND remain ≥ ED?
  // ChargeAssetTxPayment uses ExistenceRequirement::KeepAlive, which fails
  // if `native - fee < ED`. PAH/KAH accounts can hold native below ED via
  // asset-sufficiency (e.g. USDC), so checking only `native >= fee` lets
  // dry-run-success but submit-Invalid::Payment slip through.
  const native = await fetchNativeBalance(source, senderAddress)
  const ed = nativeED(source)
  console.log(`${tag} sender native balance = ${native ?? 'unknown'} planck${native != null ? ` (${fmtNative(native)})` : ''}; ED = ${ed} planck (${fmtNative(ed)})`)
  if (fee !== null && native !== null && native >= fee + ed) {
    console.log(`${tag} → native path chosen (balance covers fee + ED, surplus = ${fmtNative(native - fee - ed)})`)
    return { txOpts, nativeFee: fee }
  }
  console.log(`${tag} native insufficient for KeepAlive${fee !== null && native !== null ? ` (need ${fmtNative(fee + ed)}, have ${fmtNative(native)})` : ''}; trying asset path`)

  // Step 3: asset path (USDC on PAH/KAH for token=USDC).
  const asset = feeAssetFor(source, token)
  if (asset && (source === 'pah' || source === 'kah')) {
    try {
      const assetOpts: PapiTxOptions = { asset }
      // The runtime reports the partial fee in NATIVE units regardless of
      // asset_id; the swap happens at submit time.
      const assetFeeNative = await primaryTx.getEstimatedFees(senderAddress, assetOpts)
      console.log(`${tag} asset-conversion path: native fee = ${assetFeeNative} planck (${fmtNative(assetFeeNative)})`)
      // Quote the AMM: how much USDC for exactly this much native?
      const usdcFee = await quoteUsdcForExactNative(source, assetFeeNative)
      if (usdcFee !== null) {
        console.log(`${tag} → asset-conversion path chosen, user pays ${(Number(usdcFee) / 1e6).toFixed(6)} USDC for ${fmtNative(assetFeeNative)} of native (effective AMM result)`)
      } else {
        console.warn(`${tag} AMM quote unavailable; UI will show native fee only`)
      }
      return { txOpts: assetOpts, nativeFee: assetFeeNative, usdcFee: usdcFee ?? undefined }
    } catch (err) {
      console.warn(`${tag} asset-conversion fee estimate failed; falling back to native`, err)
    }
  } else {
    console.log(`${tag} no asset-conversion path available for this combo`)
  }

  // Step 4: stick with native estimate (or 0 if even that failed).
  console.log(`${tag} → falling back to native path (last resort)`)
  return { txOpts, nativeFee: fee ?? 0n }
}

function isUserCancel(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return msg.includes('cancel') || msg.includes('reject') || msg.includes('user denied')
}

function extractTxHash(res: unknown): string | null {
  if (typeof res === 'string' && res.startsWith('0x')) return res
  if (typeof res === 'object' && res !== null) {
    const r = res as { txHash?: unknown }
    if (typeof r.txHash === 'string') return r.txHash
  }
  return null
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

    const submitted: SubmittedTx[] = []
    // Reuse the strategy chosen during estimateDonate. If estimateDonate wasn't
    // run (direct execute), redecide on the spot using the first call.
    let txOpts: PapiTxOptions | undefined
    if (state.step === 'ready' && state.txOpts !== undefined) {
      txOpts = state.txOpts
    } else {
      const decision = await decideFeeStrategy(params.source, params.token, calls[0], senderAddress)
      txOpts = decision.txOpts
    }

    // Helper: flip the executing-state phase when the wallet returns the
    // signed bytes (between "Sign in wallet" and "Awaiting block inclusion").
    const onSigned = (mode: 'batch' | 'sequential', current: number, total: number) => () => {
      if (state.step === 'executing') {
        state = { step: 'executing', mode, current, total, phase: 'awaiting-inclusion' }
      }
    }

    if (calls.length > 1) {
      const batch = await buildBatch(params.source, calls)
      if (batch) {
        state = { step: 'executing', mode: 'batch', current: 0, total: 1, phase: 'awaiting-signature' }
        try {
          const res = await batch.signAndSubmit(
            watchSigner(signer, onSigned('batch', 0, 1)),
            (assertSafeFeeAsset(txOpts), withSignedExtOverride(txOpts)),
          )
          const txHash = extractTxHash(res)
          if (txHash) submitted.push({ txHash, chain: params.source })
          state = { step: 'success', submitted }
          return true
        } catch (err) {
          if (isUserCancel(err)) {
            state = { step: 'error', message: 'Cancelled' }
            return false
          }
          console.warn('[donate] batch submit failed; falling back to sequential', err)
        }
      }
    } else {
      // Single call (e.g. consolidated XCM, or single recipient).
      state = { step: 'executing', mode: 'batch', current: 0, total: 1, phase: 'awaiting-signature' }
      try {
        const res = await calls[0].signAndSubmit(
          watchSigner(signer, onSigned('batch', 0, 1)),
          (assertSafeFeeAsset(txOpts), withSignedExtOverride(txOpts)),
        )
        const txHash = extractTxHash(res)
        if (txHash) submitted.push({ txHash, chain: params.source })
        state = { step: 'success', submitted }
        return true
      } catch (err) {
        if (isUserCancel(err)) {
          state = { step: 'error', message: 'Cancelled' }
          return false
        }
        const msg = err instanceof Error ? err.message : 'Submission failed'
        state = { step: 'error', message: msg }
        return false
      }
    }

    for (let i = 0; i < calls.length; i++) {
      state = { step: 'executing', mode: 'sequential', current: i, total: calls.length, phase: 'awaiting-signature' }
      try {
        const res = await calls[i].signAndSubmit(
          watchSigner(signer, onSigned('sequential', i, calls.length)),
          (assertSafeFeeAsset(txOpts), withSignedExtOverride(txOpts)),
        )
        const txHash = extractTxHash(res)
        if (txHash) submitted.push({ txHash, chain: params.source })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Submission failed'
        state = { step: 'error', message: `Recipient ${i + 1}/${calls.length}: ${msg}` }
        return false
      }
    }
    state = { step: 'success', submitted }
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
