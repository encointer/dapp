<script lang="ts">
  import type { HopFee, TransferParams } from '../lib/types'
  import { getChain, getDecimals } from '../lib/chains'
  import { formatBalance } from '../lib/format'

  interface Props {
    fees: HopFee[]
    params: TransferParams
  }
  let { fees, params }: Props = $props()

  const decimals = $derived(getDecimals(params.destination, params.token))
</script>

<div class="fees card">
  <h4>Fees</h4>
  {#each fees as fee, i}
    <div class="fee-row">
      <span class="fee-label">
        Hop {i + 1}: {getChain(fee.hop.from).name} &rarr; {getChain(fee.hop.to).name}
      </span>
    </div>
    {#if fee.origin.fee > 0n}
      <div class="fee-row fee-sub">
        <span class="fee-label">Origin</span>
        <span class="fee-value">~{formatBalance(fee.origin.fee, fee.origin.decimals)} {fee.origin.symbol}</span>
      </div>
    {/if}
    {#if fee.destination.fee > 0n}
      <div class="fee-row fee-sub">
        <span class="fee-label">Destination</span>
        <span class="fee-value">~{formatBalance(fee.destination.fee, fee.destination.decimals)} {fee.destination.symbol}</span>
      </div>
    {/if}
  {/each}
  <div class="fee-row receive">
    <span>You receive</span>
    <span>~{formatBalance(params.amount, decimals)} {params.token}</span>
  </div>
</div>

<style>
  h4 {
    font-size: 0.9rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
  }

  .fee-row {
    display: flex;
    justify-content: space-between;
    font-size: 0.85rem;
    padding: 0.2rem 0;
  }

  .fee-sub {
    padding-left: 1rem;
  }

  .fee-label {
    color: var(--color-text-dim);
  }

  .fee-value {
    font-family: var(--font-mono);
  }

  .receive {
    border-top: 1px solid var(--color-border);
    margin-top: 0.3rem;
    padding-top: 0.4rem;
    color: var(--color-success);
    font-weight: 500;
  }
</style>
