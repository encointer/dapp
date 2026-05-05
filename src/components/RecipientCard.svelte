<script lang="ts">
  import type { Faucet, Treasury } from '../lib/recipients.svelte'
  import { formatBalance, truncateAddress } from '../lib/format'

  type FaucetProps = { kind: 'faucet'; data: Faucet; selected: boolean; disabled?: boolean; onToggle: () => void }
  type TreasuryProps = { kind: 'treasury'; data: Treasury; selected: boolean; disabled?: boolean; onToggle: () => void }
  let props: FaucetProps | TreasuryProps = $props()
  const isDisabled = $derived(
    !!props.disabled || (props.kind === 'treasury' && props.data.donationsDisabled),
  )
</script>

<button
  class="recipient-card"
  class:selected={props.selected}
  class:disabled={isDisabled}
  disabled={isDisabled}
  onclick={() => { if (!isDisabled) props.onToggle() }}
  type="button"
>
  <span class="check" aria-hidden="true">{props.selected ? '✓' : ''}</span>

  {#if props.kind === 'faucet'}
    <div class="info">
      <div class="row">
        <span class="title">{props.data.name}</span>
        <span class="balance">{formatBalance(props.data.freeBalance, 12)} KSM</span>
      </div>
      <div class="row sub">
        <span>drip {formatBalance(props.data.dripAmount, 12)} KSM</span>
        <span class="addr">{truncateAddress(props.data.account)}</span>
      </div>
      <div class="row sub">
        <span class="eligibility">
          {#if props.data.whitelist == null}
            open to all communities
          {:else if props.data.whitelist.length === 0}
            no eligible communities
          {:else}
            eligible: {props.data.whitelist.join(', ')}
          {/if}
        </span>
        <span title="Approximate count of unique persons attested every 10 days across the whitelisted communities (max recent ReputationCount per cid, summed)">
          ~{props.data.attestedPersons} unique persons attested every 10 days
        </span>
      </div>
    </div>
  {:else}
    <div class="info">
      <div class="row">
        <span class="title">
          {props.data.name}
          {#if isDisabled}
            <span class="disabled-badge">donations disabled</span>
          {/if}
        </span>
        <span class="balance">{formatBalance(props.data.usdcBalance, 6)} USDC</span>
      </div>
      <div class="row sub">
        <span>
          cid {props.data.cid}
          {#if props.data.location}— {props.data.location}{/if}
        </span>
        <span>{formatBalance(props.data.ksmBalance, 12)} KSM</span>
      </div>
      <div class="row sub">
        <span class="addr">KAH: {truncateAddress(props.data.kahAccount || '—')}</span>
        <span title="Approximate count of unique persons attested every 10 days in this community (max recent ReputationCount over the reputation lifetime)">
          ~{props.data.attestedPersons} unique persons attested every 10 days
        </span>
      </div>
      <div class="row sub">
        <span>turnover (last 3 full months)</span>
        <span class="turnover">
          {#if props.data.turnoverLoading}
            <span class="spinner spinner-sm"></span>
          {:else if props.data.turnoverLast3Months !== null}
            {props.data.turnoverLast3Months.toLocaleString(undefined, { maximumFractionDigits: 0 })} {props.data.symbol || 'CC'}
            {#if props.data.turnoverLast3MonthsUsdc !== null}
              <span class="dim-text">≈ {props.data.turnoverLast3MonthsUsdc.toLocaleString(undefined, { maximumFractionDigits: 0 })} USDC</span>
            {/if}
          {:else}
            —
          {/if}
        </span>
      </div>
    </div>
  {/if}
</button>

<style>
  .recipient-card {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    width: 100%;
    padding: 0.6rem 0.75rem;
    border-radius: var(--radius);
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    text-align: left;
    transition: background 0.15s, border-color 0.15s;
  }

  .recipient-card:hover {
    background: var(--color-surface-hover);
  }

  .recipient-card.selected {
    border-color: var(--color-accent);
    background: var(--color-surface-hover);
  }

  .recipient-card.disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .recipient-card.disabled:hover {
    background: var(--color-surface);
  }

  .disabled-badge {
    margin-left: 0.4rem;
    padding: 0.05rem 0.4rem;
    font-size: 0.7rem;
    font-weight: 500;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-text-dim);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .check {
    width: 1.2rem;
    flex-shrink: 0;
    color: var(--color-accent);
    font-weight: 700;
    line-height: 1.4;
  }

  .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
  }

  .title {
    font-weight: 600;
    font-size: 0.95rem;
  }

  .balance {
    font-family: var(--font-mono);
    font-size: 0.9rem;
  }

  .sub {
    font-size: 0.78rem;
    color: var(--color-text-dim);
  }

  .addr {
    font-family: var(--font-mono);
  }

  .eligibility {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .turnover {
    font-family: var(--font-mono);
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
</style>
