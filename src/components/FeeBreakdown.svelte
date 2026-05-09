<script lang="ts">
  import type { HopFee, TransferParams } from '../lib/types'
  import { getChain, getDecimals } from '../lib/chains'
  import { formatBalance } from '../lib/format'
  import { getSs58AddressInfo } from 'polkadot-api'

  interface Props {
    fees: HopFee[]
    params: TransferParams
    senderAddress: string | null
  }
  let { fees, params, senderAddress }: Props = $props()

  const decimals = $derived(getDecimals(params.destination, params.token))

  // Hide the totalling row entirely when there are no XCM fees to subtract
  // (same-chain transfers — recipient gets exactly `amount`).
  const hasAnyXcmFees = $derived(fees.some(f => f.origin.fee > 0n || f.destination.fee > 0n))

  function pubKeyHex(addr: string | null): string | null {
    if (!addr) return null
    const info = getSs58AddressInfo(addr)
    if (!info.isValid) return null
    return Array.from(info.publicKey).map(b => b.toString(16).padStart(2, '0')).join('')
  }
  const isSelfTransfer = $derived.by(() => {
    const a = pubKeyHex(senderAddress)
    const b = pubKeyHex(params.recipient)
    return !!a && !!b && a === b
  })
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
        <span class="fee-value">
          ~{formatBalance(fee.origin.fee, fee.origin.decimals)} {fee.origin.symbol}
          {#if fee.origin.quoted}
            <span class="quoted">(~{formatBalance(fee.origin.quoted.fee, fee.origin.quoted.decimals)} {fee.origin.quoted.symbol})</span>
          {/if}
        </span>
      </div>
    {/if}
    {#if fee.destination.fee > 0n}
      <div class="fee-row fee-sub">
        <span class="fee-label">Destination</span>
        <span class="fee-value">
          ~{formatBalance(fee.destination.fee, fee.destination.decimals)} {fee.destination.symbol}
          {#if fee.destination.quoted}
            <span class="quoted">(~{formatBalance(fee.destination.quoted.fee, fee.destination.quoted.decimals)} {fee.destination.quoted.symbol})</span>
          {/if}
        </span>
      </div>
    {/if}
  {/each}
  {#if hasAnyXcmFees}
    <div class="fee-row receive">
      <span>{isSelfTransfer ? 'You receive' : 'Recipient receives'}</span>
      <span>~{formatBalance(params.amount, decimals)} {params.token}</span>
    </div>
  {/if}
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

  .quoted {
    color: var(--color-text-dim);
    font-size: 0.8rem;
  }

  .receive {
    border-top: 1px solid var(--color-border);
    margin-top: 0.3rem;
    padding-top: 0.4rem;
    color: var(--color-success);
    font-weight: 500;
  }
</style>
