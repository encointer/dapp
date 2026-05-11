<script lang="ts">
  import type { TransferParams, HopFee } from '../lib/types'
  import { CHAINS, getDecimals } from '../lib/chains'
  import { formatBalance, truncateAddress } from '../lib/format'
  import { getWalletState } from '../lib/wallet.svelte'
  import { getSs58AddressInfo } from 'polkadot-api'
  import {
    estimateFees,
    executeTransfer,
    resetTransfer,
    getTransferState,
    routeForParams,
  } from '../lib/transfer.svelte'
  import { fetchAllBalances } from '../lib/balances.svelte'
  import RouteDisplay from '../components/RouteDisplay.svelte'
  import FeeBreakdown from '../components/FeeBreakdown.svelte'
  import TransferProgress from '../components/TransferProgress.svelte'
  import { subscanUrl } from '../lib/donate.svelte'

  interface Props {
    params: TransferParams
    onBack: () => void
  }
  let { params, onBack }: Props = $props()

  const wallet = $derived(getWalletState())
  const txState = $derived(getTransferState())
  const route = $derived(routeForParams(params))
  const decimals = $derived(getDecimals(params.source, params.token))
  const displayAmount = $derived(formatBalance(params.amount, decimals))

  // Does this route cross the KAH<>PAH bridge?
  const isBridgeTransfer = $derived.by(() => {
    if (!route) return false
    return route.hops.some(h =>
      (h.from === 'kah' && h.to === 'pah') || (h.from === 'pah' && h.to === 'kah'),
    )
  })

  function pubKeyHex(addr: string | null): string | null {
    if (!addr) return null
    const info = getSs58AddressInfo(addr)
    return info.isValid
      ? Array.from(info.publicKey).map(b => b.toString(16).padStart(2, '0')).join('')
      : null
  }
  const isSelfTransfer = $derived.by(() => {
    const a = pubKeyHex(wallet.address)
    const b = pubKeyHex(params.recipient)
    return !!a && !!b && a === b
  })
  const isSameChain = $derived(params.source === params.destination)

  let fees = $state(null as HopFee[] | null)

  // Estimate fees on mount
  $effect(() => {
    if (wallet.address && txState.step === 'idle') {
      estimateFees(params, wallet.address).then(f => { fees = f })
    }
  })

  async function handleConfirm() {
    if (!wallet.signer || !wallet.address || !fees) return
    const success = await executeTransfer(params, wallet.signer, wallet.address, fees)
    if (success && wallet.address) {
      fetchAllBalances(wallet.address)
    }
  }

  function handleBack() {
    resetTransfer()
    onBack()
  }

  function handleRetry() {
    resetTransfer()
    if (wallet.address) {
      estimateFees(params, wallet.address).then(f => { fees = f })
    }
  }
</script>

<div class="transfer">
  <button class="btn btn-ghost back-btn" onclick={handleBack}>&larr; Back</button>

  <h2>
    {#if isSameChain}
      {isSelfTransfer ? 'Move' : 'Send'} {displayAmount} {params.token}
    {:else}
      Transfer {displayAmount} {params.token}
    {/if}
  </h2>

  {#if route && !isSameChain}
    <RouteDisplay {route} />
  {/if}

  <div class="card transfer-meta">
    <div><span class="dim-text">From:</span> {CHAINS[params.source].name}</div>
    {#if !isSameChain}
      <div><span class="dim-text">To:</span> {CHAINS[params.destination].name}</div>
    {/if}
    <div>
      <span class="dim-text">Recipient:</span>
      {#if isSelfTransfer}
        <span>your account</span>
        <span class="dim-text">({truncateAddress(params.recipient)})</span>
      {:else}
        <span class="addr">{truncateAddress(params.recipient)}</span>
        <span class="dim-text">on {CHAINS[params.destination].name}</span>
      {/if}
    </div>
  </div>

  {#if txState.step === 'estimating'}
    <div class="card status-card">
      <span class="spinner"></span>
      <p class="dim-text">Estimating fees...</p>
    </div>
  {/if}

  {#if txState.step === 'ready' && fees}
    <!--
      The simplified `FeeBreakdown` (from paraspell's `getXcmFee` /
      `getEstimatedFees`) covers only origin + destination XCM execution and
      doesn't see the prepended USDC→native swap or the dispatch fee. When
      every hop has a dry-run net-effect block, that block is the
      authoritative number and the simple card just confuses with mismatched
      figures — hide it. Keep it as a fallback when the dry-run is missing
      or didn't produce a balance impact.
    -->
    {@const haveDryRunBalance = txState.hopDryRuns?.every(d => d.balance) === true}
    {#if !haveDryRunBalance}
      <FeeBreakdown {fees} {params} senderAddress={wallet.address} />
    {/if}

    {#if txState.hopDryRuns}
      {#each txState.hopDryRuns as dr, i}
        {@const hop = route?.hops[i]}
        <div class="hop-summary card">
          <div class="hop-title">
            {hop ? `${CHAINS[hop.from].name} → ${CHAINS[hop.to].name}` : `Hop ${i + 1}`}
          </div>
          <ul class="dry-run-summary">
            <li class:ok={dr.sourceOk}>
              {dr.sourceOk ? '✓' : '✗'} source: {dr.sourceOk ? 'dispatch would succeed' : (dr.sourceMessage ?? 'failed')}
            </li>
            {#each dr.destinations as d}
              <li class:ok={d.ok}>
                {d.ok ? '✓' : '✗'} destination ({CHAINS[d.destChain].name}): {d.ok ? 'XCM would execute Complete' : (d.errorMessage ?? 'failed')}
              </li>
            {/each}
          </ul>
          {#if dr.balance}
            {@const bal = dr.balance}
            {@const feeDetail = fees?.[i]?.origin}
            {@const paidInAsset = feeDetail?.paidIn === 'asset'}
            <!--
              `dry_run_call` doesn't run signed extensions, so the
              dispatch fee withdrawal (whether in USDC via
              asset-conversion-tx-payment or in native via
              ChargeTransactionPayment) is never in `sourceUsdcDelta` /
              `sourceNativeDelta`. Add it to the correct side based on the
              fee-asset choice the dapp actually made for this hop. For
              cross-chain hops paraspell's `origin.fee` rolls bridge
              delivery + XCM execution + dispatch into one figure, so we
              only top up the dispatch fee on same-chain hops (where the
              dry-run sees nothing native at all). -->
            {@const isSameChain = hop && hop.from === hop.to}
            {@const dispatchFeeUsdc =
              paidInAsset && feeDetail?.quoted?.symbol === 'USDC'
                ? (feeDetail.quoted.fee ?? 0n) : 0n}
            {@const dispatchFeeNative =
              !paidInAsset && isSameChain ? (feeDetail?.fee ?? 0n) : 0n}
            {@const usdcOutDryRun = bal.sourceUsdcDelta < 0n ? -bal.sourceUsdcDelta : 0n}
            {@const usdcOut = usdcOutDryRun + dispatchFeeUsdc}
            <!--
              Split the USDC outflow so the breakdown isn't misleading for
              cross-chain transfers with a prepended USDC→native swap:
                transferOut    — the amount the user picked,
                bridgeFunding  — extra USDC eaten by the swap that funds
                                 bridge-delivery / XCM-execution in native,
                dispatchFeeUsdc — dispatch fee via asset-conversion-tx-payment.
            -->
            {@const transferOut = params.token === 'USDC' ? params.amount : 0n}
            {@const bridgeFunding = params.token === 'USDC' && usdcOutDryRun > transferOut ? usdcOutDryRun - transferOut : 0n}
            {@const nativeDecimals = hop?.from === 'pah' ? 10 : 12}
            {@const nativeSymbol = hop?.from === 'pah' ? 'DOT' : 'KSM'}
            {@const adjustedNativeDelta = bal.sourceNativeDelta - dispatchFeeNative}
            {@const nativeAbs = adjustedNativeDelta < 0n ? -adjustedNativeDelta : adjustedNativeDelta}
            {@const nativeSign = adjustedNativeDelta < 0n ? '−' : '+'}
            {@const showNativeLine = adjustedNativeDelta !== 0n || (bal.sourceNativeFinal !== null && bal.sourceNativeFinal !== 0n)}
            <!-- Annotate the native delta when its meaning isn't the obvious
                 "balance change" reading:
                   negative + non-native-token → paid out as fees
                   positive + non-native-token → leftover from the
                                                 USDC→native swap topup. -->
            {@const nativeQualifier =
              params.token === nativeSymbol ? '' :
              adjustedNativeDelta < 0n ? ' (fees)' :
              adjustedNativeDelta > 0n ? ' (fee swap remainder)' : ''}
            <!-- Build the breakdown string so we never end up with empty
                 parens or a trailing " + ". -->
            {@const parts = [
              transferOut > 0n ? `${formatBalance(transferOut, 6)} transfer` : null,
              bridgeFunding > 0n ? `${formatBalance(bridgeFunding, 6)} swapped to ${nativeSymbol} for bridge` : null,
              dispatchFeeUsdc > 0n ? `${formatBalance(dispatchFeeUsdc, 6)} dispatch fee` : null,
            ].filter((p): p is string => p != null)}
            <ul class="net-effect">
              {#if usdcOut > 0n}
                <li>
                  <span class="dim-text">USDC charged from your account:</span>
                  <span class="mono">{formatBalance(usdcOut, 6)} USDC</span>
                  {#if parts.length >= 2}
                    <span class="dim-text">({parts.join(' + ')})</span>
                  {/if}
                </li>
              {/if}
              {#if showNativeLine}
                <li>
                  <span class="dim-text">{nativeSymbol} change{nativeQualifier}:</span>
                  <span class="mono">{nativeSign}{formatBalance(nativeAbs, nativeDecimals)} {nativeSymbol}</span>
                </li>
              {/if}
              {#if bal.recipientReceipts.length > 0 && bal.recipientReceipts[0].received > 0n}
                {@const tokenDecimals = getDecimals(hop?.to ?? params.destination, params.token)}
                <li>
                  <span class="dim-text">{isSelfTransfer ? 'You receive:' : 'Recipient receives:'}</span>
                  <span class="mono">{formatBalance(bal.recipientReceipts[0].received, tokenDecimals)} {params.token}</span>
                </li>
              {/if}
            </ul>
          {/if}
        </div>
      {/each}
    {/if}

    <button class="btn btn-primary confirm-btn" onclick={handleConfirm}>
      Confirm Transfer
    </button>
  {/if}

  {#if txState.step === 'executing'}
    <div class="card">
      <TransferProgress hops={txState.hops} />
    </div>
  {/if}

  {#if txState.step === 'success'}
    <div class="card success-card">
      <p class="success-text">Submitted on source chain!</p>
      <ul class="tx-links">
        {#each txState.hops as h}
          {@const link = h.txHash ? subscanUrl(h.hop.from, h.txHash) : null}
          {#if link}
            <li>
              <a href={link} target="_blank" rel="noopener" class="subscan-link">
                {CHAINS[h.hop.from].name}: view on Subscan ↗
              </a>
            </li>
          {/if}
        {/each}
      </ul>
      {#if isBridgeTransfer}
        <p class="bridge-note">Funds are being bridged and will arrive at the destination in ~6 minutes.</p>
      {/if}
      <button class="btn btn-primary" onclick={handleBack}>Back to Home</button>
    </div>
  {/if}

  {#if txState.step === 'error'}
    <div class="card error-card">
      <p class="error-text">{txState.message}</p>
      <div class="error-actions">
        <button class="btn btn-ghost" onclick={handleBack}>Back</button>
        <button class="btn btn-primary" onclick={handleRetry}>Retry</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .transfer {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .back-btn {
    align-self: flex-start;
    font-size: 0.9rem;
  }

  h2 {
    font-size: 1.2rem;
    font-weight: 600;
  }

  .transfer-meta {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.9rem;
  }
  .transfer-meta .addr {
    font-family: var(--font-mono);
  }

  .status-card {
    text-align: center;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .confirm-btn {
    width: 100%;
  }

  .success-card {
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    align-items: center;
    padding: 1.5rem;
  }

  .success-text {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--color-success);
  }

  .bridge-note {
    font-size: 0.9rem;
    color: var(--color-warning);
  }

  .tx-links {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.85rem;
  }
  .subscan-link {
    color: var(--color-accent);
    text-decoration: underline;
  }
  .subscan-link:hover {
    color: var(--color-accent-strong, var(--color-accent));
  }

  .error-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .error-actions {
    display: flex;
    gap: 0.5rem;
  }

  .error-actions .btn {
    flex: 1;
  }

  .hop-summary {
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .hop-title {
    font-weight: 600;
    font-size: 0.9rem;
  }
  .dry-run-summary, .net-effect {
    list-style: none;
    padding: 0.4rem 0.6rem;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-surface-hover);
    font-size: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .dry-run-summary li {
    color: var(--color-danger, #b13030);
  }
  .dry-run-summary li.ok {
    color: var(--color-success, #058257);
  }
  .net-effect li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: baseline;
  }
  .mono { font-family: var(--font-mono); }
</style>
