<script lang="ts">
  import type { HopFee, TransferParams } from '../lib/types'
  import { getChain, getDecimals } from '../lib/chains'
  import { formatBalance } from '../lib/format'
  import { totalFees, receiveAmount } from '../lib/transfer.svelte'

  interface Props {
    fees: HopFee[]
    params: TransferParams
  }
  let { fees, params }: Props = $props()

  const decimals = $derived(getDecimals(params.source, params.token))
  const total = $derived(totalFees(fees))
  const receive = $derived(receiveAmount(params.amount, fees))
</script>

<div class="fees card">
  <h4>Fees</h4>
  {#each fees as fee, i}
    <div class="fee-row">
      <span class="fee-label">
        Hop {i + 1}: {getChain(fee.hop.from).name} &rarr; {getChain(fee.hop.to).name}
      </span>
      <span class="fee-value">
        ~{formatBalance(fee.originFee + fee.destinationFee, decimals)} {params.token}
      </span>
    </div>
  {/each}
  <div class="fee-row total">
    <span>Total fees</span>
    <span>~{formatBalance(total, decimals)} {params.token}</span>
  </div>
  <div class="fee-row receive">
    <span>You receive</span>
    <span>~{formatBalance(receive, decimals)} {params.token}</span>
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

  .fee-label {
    color: var(--color-text-dim);
  }

  .fee-value {
    font-family: var(--font-mono);
  }

  .total {
    border-top: 1px solid var(--color-border);
    margin-top: 0.3rem;
    padding-top: 0.4rem;
    font-weight: 500;
  }

  .receive {
    color: var(--color-success);
    font-weight: 500;
  }
</style>
