<script lang="ts">
  import type { TransferParams, HopFee } from '../lib/types'
  import { getDecimals } from '../lib/chains'
  import { formatBalance } from '../lib/format'
  import { getWalletState } from '../lib/wallet.svelte'
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

  <h2>Transfer {displayAmount} {params.token}</h2>

  {#if route}
    <RouteDisplay {route} />
  {/if}

  {#if txState.step === 'estimating'}
    <div class="card status-card">
      <span class="spinner"></span>
      <p class="dim-text">Estimating fees...</p>
    </div>
  {/if}

  {#if txState.step === 'ready' && fees}
    <FeeBreakdown {fees} {params} />

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
</style>
