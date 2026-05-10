import { Builder, getExistentialDeposit } from '@paraspell/sdk'
import { Binary, getSs58AddressInfo, type PolkadotSigner } from 'polkadot-api'
import type { TransferParams, TransferState, HopFee, HopProgress, Route, FeeDetail, ChainId } from './types'
import { resolveRoute } from './routing'
import { CHAINS, toParaSpell, getCurrency } from './chains'
import { quoteUsdcForExactNative } from './forex'
import { getApiOverrides, getClient } from './provider.svelte'
import {
  decideFeeStrategy, dryRunFull, maybeWrapWithFeeSwap, sourceFeeAsset, fetchNativeBalance,
  withSignedExtOverride, assertSafeFeeAsset,
  type SrcApi, type UnsignedTx, type DryRunSummary, type PapiTxOptions,
} from './donate.svelte'

let transferState = $state<TransferState>({ step: 'idle' })

function builder() {
  const overrides = getApiOverrides()
  if (!overrides) throw new Error('Not connected to chains')
  return Builder({ apiOverrides: overrides })
}

async function enrichWithQuote(detail: FeeDetail): Promise<FeeDetail> {
  if (detail.fee <= 0n) return detail
  // Quote the native fee in USDC via the asset hub's AssetConversion pool.
  // KSM fees → KAH pool, DOT fees → PAH pool.
  let chain: 'pah' | 'kah' | null = null
  if (detail.symbol === 'KSM') chain = 'kah'
  else if (detail.symbol === 'DOT') chain = 'pah'
  if (!chain) return detail
  const quoted = await quoteUsdcForExactNative(chain, detail.fee)
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

// Asset-id literals for the local same-chain transfer dispatchables. These
// mirror what `donate.svelte.ts::buildSameChainCall` uses; covers all
// (token, chain) combinations the dapp supports for same-chain.
const KSM_PAH_FOREIGN_LOC = {
  parents: 2,
  interior: { type: 'X1', value: { type: 'GlobalConsensus', value: { type: 'Kusama', value: undefined } } },
}
const DOT_KAH_FOREIGN_LOC = {
  parents: 2,
  interior: { type: 'X1', value: { type: 'GlobalConsensus', value: { type: 'Polkadot', value: undefined } } },
}
const USDC_KAH_FOREIGN_LOC = {
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

interface ExtendedSrcApi extends SrcApi {
  tx: SrcApi['tx'] & {
    Assets?: { transfer_keep_alive: (args: unknown) => UnsignedTx }
    Balances?: SrcApi['tx']['Balances'] & {
      transfer_allow_death?: (args: unknown) => UnsignedTx
    }
  }
}

const USDC_PAH_LOC = {
  parents: 0,
  interior: { type: 'X2', value: [
    { type: 'PalletInstance', value: 50 },
    { type: 'GeneralIndex', value: 1337n },
  ] },
}

function isNativeToken(token: import('./types').TokenSymbol, chain: import('./types').ChainId): boolean {
  return (token === 'KSM' && chain !== 'pah') || (token === 'DOT' && chain === 'pah')
}

function buildSameChainTransferCall(
  srcApi: ExtendedSrcApi,
  chain: import('./types').ChainId,
  token: import('./types').TokenSymbol,
  recipient: string,
  amount: bigint,
  allowDeath = false,
): UnsignedTx {
  const dest = { type: 'Id', value: recipient }

  if (isNativeToken(token, chain)) {
    if (!srcApi.tx.Balances) throw new Error(`Balances pallet missing on ${chain}`)
    if (allowDeath) {
      if (!srcApi.tx.Balances.transfer_allow_death) {
        throw new Error(`Balances.transfer_allow_death missing on ${chain}`)
      }
      return srcApi.tx.Balances.transfer_allow_death({ dest, value: amount })
    }
    return srcApi.tx.Balances.transfer_keep_alive({ dest, value: amount })
  }
  if (token === 'KSM' && chain === 'pah') {
    if (!srcApi.tx.ForeignAssets) throw new Error(`ForeignAssets pallet missing on ${chain}`)
    return srcApi.tx.ForeignAssets.transfer_keep_alive({ id: KSM_PAH_FOREIGN_LOC, target: dest, amount })
  }
  if (token === 'DOT' && chain === 'kah') {
    if (!srcApi.tx.ForeignAssets) throw new Error(`ForeignAssets pallet missing on ${chain}`)
    return srcApi.tx.ForeignAssets.transfer_keep_alive({ id: DOT_KAH_FOREIGN_LOC, target: dest, amount })
  }
  if (token === 'USDC' && chain === 'kah') {
    if (!srcApi.tx.ForeignAssets) throw new Error(`ForeignAssets pallet missing on ${chain}`)
    return srcApi.tx.ForeignAssets.transfer_keep_alive({ id: USDC_KAH_FOREIGN_LOC, target: dest, amount })
  }
  if (token === 'USDC' && chain === 'pah') {
    if (!srcApi.tx.Assets) throw new Error(`Assets pallet missing on ${chain}`)
    return srcApi.tx.Assets.transfer_keep_alive({ id: 1337, target: dest, amount })
  }
  throw new Error(`Unsupported same-chain transfer: ${token} on ${chain}`)
}

/** USDC location on a source chain, suitable as `txOpts.asset` for
 *  pallet-asset-conversion-tx-payment. Only PAH/KAH have such pools. */
function usdcAssetForFee(chain: import('./types').ChainId): unknown | undefined {
  if (chain === 'pah') return USDC_PAH_LOC
  if (chain === 'kah') return USDC_KAH_FOREIGN_LOC
  return undefined
}

/** PAH from KAH's perspective: cross-consensus into Polkadot, parachain 1000. */
const PAH_FROM_KAH_LOC = {
  parents: 2,
  interior: {
    type: 'X2',
    value: [
      { type: 'GlobalConsensus', value: { type: 'Polkadot', value: undefined } },
      { type: 'Parachain', value: 1000 },
    ],
  },
}

/**
 * Manually build the KAH→PAH USDC bridged transfer call.
 *
 * paraspell 12.7.1 mis-routes this case (`getBridgeReserve` does a case-
 * sensitive comparison between `getRelayChainOf(dest).toLowerCase()` and the
 * `GlobalConsensus` junction's PascalCase variant), so it picks `LocalReserve`
 * and the message is rejected at PAH with `UntrustedReserveLocation`. We
 * therefore build `transfer_assets_using_type_and_then` directly with the
 * correct `DestinationReserve` semantics: KAH burns the bridged-USDC mirror
 * locally and the message that arrives at PAH withdraws the canonical USDC
 * from PAH's sovereign holding for the recipient.
 */
function buildKahPahUsdcCall(
  srcApi: ExtendedSrcApi,
  recipient: string,
  amount: bigint,
): UnsignedTx {
  const info = getSs58AddressInfo(recipient)
  if (!info.isValid) throw new Error(`Invalid recipient address: ${recipient}`)
  const recipientBytes = Binary.fromBytes(info.publicKey)

  // Locations relative to KAH (origin frame):
  const usdcOnKah = USDC_KAH_FOREIGN_LOC

  // Locations relative to PAH (where customXcmOnDest executes):
  const usdcOnPah = USDC_PAH_LOC

  // PAPI typed-enum form (`{ type, value }`). Two paraspell-mirroring
  // quirks: (1) `Junctions::X1` flattens to a single Junction (not an
  // array of one) — PAPI's untyped tx builder requires this. (2)
  // `AccountId32` is `{ id }` with NO `network` field. paraspell's
  // `createAccountPayload` omits it; including `network: undefined`
  // appears to mis-encode the Option byte and corrupts what the wallet
  // tries to decode for display, crashing it.
  const beneficiary = {
    parents: 0,
    interior: {
      type: 'X1',
      value: { type: 'AccountId32', value: { id: recipientBytes } },
    },
  }

  const customXcm = {
    type: 'V5',
    value: [
      {
        type: 'BuyExecution',
        value: {
          fees: { id: usdcOnPah, fun: { type: 'Fungible', value: amount } },
          weight_limit: { type: 'Unlimited' },
        },
      },
      {
        type: 'DepositAsset',
        value: {
          assets: { type: 'Wild', value: { type: 'AllCounted', value: 1 } },
          beneficiary,
        },
      },
    ],
  }

  const args = {
    dest: { type: 'V5', value: PAH_FROM_KAH_LOC },
    assets: {
      type: 'V5',
      value: [{ id: usdcOnKah, fun: { type: 'Fungible', value: amount } }],
    },
    assets_transfer_type: { type: 'DestinationReserve' },
    remote_fees_id: { type: 'V5', value: usdcOnKah },
    fees_transfer_type: { type: 'DestinationReserve' },
    custom_xcm_on_dest: customXcm,
    weight_limit: { type: 'Unlimited' },
  }
  const replacer = (_k: string, v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString() + 'n'
    if (v instanceof Uint8Array) return '0x' + Array.from(v).map(b => b.toString(16).padStart(2, '0')).join('')
    return v
  }
  console.log('[transfer] kah→pah USDC manual call args:', JSON.stringify(args, replacer, 2))
  const tx = srcApi.tx.PolkadotXcm.transfer_assets_using_type_and_then(args)
  // Log the SCALE-encoded call hex so the user can decode it manually
  // (e.g. paste into polkadot.js apps "Decode" tab).
  ;(async () => {
    try {
      const txEnc = tx as unknown as { getEncodedData?: () => Promise<{ asHex: () => string }> }
      const bin = await txEnc.getEncodedData?.()
      if (bin && typeof bin.asHex === 'function') {
        console.log('[transfer] kah→pah USDC encoded call hex:', bin.asHex())
      } else {
        console.log('[transfer] kah→pah USDC: getEncodedData returned unexpected:', bin)
      }
    } catch (err) {
      console.warn('[transfer] failed to dump encoded hex:', err)
    }
  })()
  return tx
}


/** Existential deposit of the chain's native token, queried via paraspell. */
function nativeED(chain: ChainId, token: import('./types').TokenSymbol): bigint {
  try {
    const v = getExistentialDeposit(CHAINS[chain].paraSpellName, getCurrency(chain, token))
    return v ?? 0n
  } catch { return 0n }
}

async function buildHopTx(
  hop: { from: import('./types').ChainId; to: import('./types').ChainId },
  token: import('./types').TokenSymbol,
  amount: bigint,
  senderAddress: string,
  recipient: string,
): Promise<BuiltHop> {
  const srcClient = getClient(hop.from)
  if (!srcClient) throw new Error(`No client for ${hop.from}`)
  const srcApi = srcClient.getUnsafeApi() as unknown as ExtendedSrcApi

  if (hop.from === hop.to) {
    // Same-chain: direct transfer dispatchable, no XCM. For native-token
    // transfers we may need to use `transfer_allow_death` and pay the
    // dispatch fee in USDC when the amount leaves no headroom for the fee
    // (e.g. user clicked MAX). The account survives going to 0 native via
    // a sufficient asset like USDC on PAH/KAH.
    const native = isNativeToken(token, hop.from)
    const keepAliveTx = buildSameChainTransferCall(srcApi, hop.from, token, recipient, amount, false)
    if (native) {
      const usdcFeeAsset = usdcAssetForFee(hop.from)
      if (usdcFeeAsset) {
        let nativeFee = 0n
        try { nativeFee = await keepAliveTx.getEstimatedFees(senderAddress) } catch { /* fall through */ }
        const balance = (await fetchNativeBalance(hop.from, senderAddress)) ?? 0n
        const ed = nativeED(hop.from, token)
        // keep_alive succeeds iff `balance - amount - fee >= ED`. When the
        // user is at the cap (e.g. MAX = balance-ED), there's no headroom
        // for the fee, so switch to allow_death + USDC fee. The account
        // still survives via USDC sufficiency.
        if (balance > 0n && balance < amount + nativeFee + ed) {
          const tx = buildSameChainTransferCall(srcApi, hop.from, token, recipient, amount, true)
          return { tx, txOpts: { asset: usdcFeeAsset } }
        }
      }
    }
    const strategy = await decideFeeStrategy(hop.from, token, keepAliveTx, senderAddress)
    return { tx: keepAliveTx, txOpts: strategy.txOpts }
  }

  // Cross-chain. paraspell 12.7.1 mis-routes KAH→PAH USDC (LocalReserve
  // instead of DestinationReserve due to a case-sensitivity bug in
  // `getBridgeReserve`), so we build that one call manually.
  let baseTx: UnsignedTx
  if (hop.from === 'kah' && hop.to === 'pah' && token === 'USDC') {
    baseTx = buildKahPahUsdcCall(srcApi, recipient, amount)
  } else {
    const overrides = getApiOverrides()
    if (!overrides) throw new Error('Not connected to chains')
    const currency = { ...getCurrency(hop.from, token), amount: amount.toString() }
    const psTx = await Builder({ apiOverrides: overrides })
      .from(toParaSpell(hop.from))
      .to(toParaSpell(hop.to))
      .currency(currency)
      .address(recipient)
      .senderAddress(senderAddress)
      .build()
    baseTx = psTx as unknown as UnsignedTx
  }
  const tx = await maybeWrapWithFeeSwap(srcApi, hop.from, token, baseTx, senderAddress)
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
      // Build the actual tx once and reuse for fee-estimate + dry-run.
      const built = await buildHopTx(hop, params.token, params.amount, senderAddress, params.recipient)

      if (hop.from === hop.to) {
        // Same-chain: no XCM fees — display the dispatch fee (in source-chain
        // native), pulled from `getEstimatedFees`.
        let dispatchFee = 0n
        try { dispatchFee = await built.tx.getEstimatedFees(senderAddress, built.txOpts) } catch { /* fall back to 0 */ }
        const meta = sourceFeeAsset(hop.from)
        fees.push({
          hop,
          origin: { fee: dispatchFee, symbol: meta.symbol, decimals: meta.decimals },
          destination: { fee: 0n, symbol: '', decimals: 12 },
        })
      } else if (hop.from === 'kah' && hop.to === 'pah' && params.token === 'USDC') {
        // Manually-built call — paraspell's `getXcmFee` would build the
        // (mis-routed) LocalReserve variant, so we can't ask it. Show the
        // dispatch fee from `getEstimatedFees` and rely on the dry-run for
        // accurate balance impact.
        let dispatchFee = 0n
        try { dispatchFee = await built.tx.getEstimatedFees(senderAddress, built.txOpts) } catch { /* fall back to 0 */ }
        const meta = sourceFeeAsset(hop.from)
        const origin = await enrichWithQuote({ fee: dispatchFee, symbol: meta.symbol, decimals: meta.decimals })
        fees.push({
          hop, origin,
          destination: { fee: 0n, symbol: '', decimals: 12 },
        })
      } else {
        // Paraspell's getXcmFee gives a per-asset breakdown for display.
        const currency = { ...getCurrency(hop.from, params.token), amount: params.amount.toString() }
        const feeResult = await builder()
          .from(toParaSpell(hop.from))
          .to(toParaSpell(hop.to))
          .currency(currency)
          .address(params.recipient)
          .senderAddress(senderAddress)
          .getXcmFee()
        const [origin, destination] = await Promise.all([
          enrichWithQuote(extractFee(feeResult.origin)),
          enrichWithQuote(extractFee(feeResult.destination)),
        ])
        fees.push({ hop, origin, destination })
      }

      // Dry-run the actual tx (with fee-swap pre-pended if needed) so we can
      // catch bridge / fee / pool issues before the user signs anything.
      const dr = await dryRunFull(
        hop.from, built.tx.decodedCall, senderAddress,
        [{ id: params.recipient, address: params.recipient, label: 'Recipient' }],
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
      const built = await buildHopTx(hop, params.token, params.amount, address, params.recipient)
      assertSafeFeeAsset(built.txOpts)
      const res = await built.tx.signAndSubmit(signer, withSignedExtOverride(built.txOpts))
      const txHash = extractTxHash(res)

      hopProgresses[i] = { ...hopProgresses[i], status: 'success', txHash: txHash ?? undefined }
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

  transferState = { step: 'success', hops: [...hopProgresses] }
  return true
}

function extractTxHash(res: unknown): string | null {
  if (typeof res === 'string' && res.startsWith('0x')) return res
  if (typeof res === 'object' && res !== null) {
    const r = res as { txHash?: unknown }
    if (typeof r.txHash === 'string') return r.txHash
  }
  return null
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
