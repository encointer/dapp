<script lang="ts">
  import type { Faucet, Treasury } from '../lib/recipients.svelte'
  import { formatBalance, truncateAddress } from '../lib/format'
  import { subscanAccountUrl } from '../lib/donate.svelte'

  type FaucetProps = { kind: 'faucet'; data: Faucet; selected: boolean; disabled?: boolean; onToggle: () => void }
  type TreasuryProps = { kind: 'treasury'; data: Treasury; selected: boolean; disabled?: boolean; onToggle: () => void }
  let props: FaucetProps | TreasuryProps = $props()
  const isDisabled = $derived(
    !!props.disabled || (props.kind === 'treasury' && props.data.donationsDisabled),
  )
  const destChainName = $derived(props.kind === 'faucet' ? 'Encointer' : 'Asset Hub Kusama')
  const destAccount = $derived(props.kind === 'faucet' ? props.data.account : props.data.kahAccount)
  const subscanLink = $derived(props.kind === 'treasury' ? subscanAccountUrl('kah', props.data.kahAccount) : null)

  let copied = $state(false)
  let copyTimeout: ReturnType<typeof setTimeout> | null = null

  function toggle() {
    if (!isDisabled) props.onToggle()
  }
  function onKey(e: KeyboardEvent) {
    if (isDisabled) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      props.onToggle()
    }
  }
  async function copyAddr(e: MouseEvent) {
    e.stopPropagation()
    if (!destAccount) return
    try {
      await navigator.clipboard.writeText(destAccount)
      copied = true
      if (copyTimeout) clearTimeout(copyTimeout)
      copyTimeout = setTimeout(() => { copied = false }, 1500)
    } catch (err) {
      console.warn('[recipient-card] clipboard write failed', err)
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="recipient-card"
  class:selected={props.selected}
  class:disabled={isDisabled}
  role="button"
  tabindex={isDisabled ? -1 : 0}
  aria-pressed={props.selected}
  aria-disabled={isDisabled}
  onclick={toggle}
  onkeydown={onKey}
>
  <span class="check" aria-hidden="true">{props.selected ? '✓' : ''}</span>

  {#if props.kind === 'faucet'}
    <div class="info">
      <div class="row">
        <span class="title">{props.data.name}</span>
      </div>
      <div class="line">
        Currently available in the pot:
        <span class="mono">{formatBalance(props.data.freeBalance, 12)} KSM</span>
      </div>
      <div class="line">
        ~{props.data.attestedPersons} unique persons attested eligible to drip
        <span class="mono">{formatBalance(props.data.dripAmount, 12)} KSM</span>
        {#if props.data.dripUsdc === undefined}
          <span class="spinner spinner-sm"></span>
        {:else if props.data.dripUsdc !== null}
          <span class="dim-text">(≈ {props.data.dripUsdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} USD)</span>
        {/if}
        every 10 days
      </div>
      <div class="line dim-text">
        {#if props.data.whitelist == null}
          open to all communities
        {:else if props.data.whitelist.length === 0}
          no eligible communities
        {:else}
          eligible communities: {props.data.whitelist.join(', ')}
        {/if}
      </div>
      <div class="line meta">
        <span class="dim-text">{destChainName}:</span>
        <span class="addr mono">{truncateAddress(destAccount || '—')}</span>
        <button
          type="button"
          class="copy-btn"
          title={copied ? 'Copied!' : 'Copy full address'}
          aria-label="Copy full address"
          onclick={copyAddr}
        >{copied ? '✓' : '⧉'}</button>
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
      </div>
      <div class="line dim-text">
        cid {props.data.cid}{#if props.data.location} — {props.data.location}{/if}
      </div>
      <div class="line">
        Currently available in the pot:
        <span class="mono">{formatBalance(props.data.usdcBalance, 6)} USDC</span>
      </div>
      <div class="line">
        {#if props.data.regularlyActivePersonsLoading}
          <span class="spinner spinner-sm"></span> regularly active unique persons
        {:else if props.data.regularlyActivePersons !== null}
          {props.data.regularlyActivePersons} regularly active unique persons
        {:else}
          regularly active unique persons: <span class="dim-text">—</span>
        {/if}
      </div>
      <div class="line">
        Turnover (last 3 full months):
        {#if props.data.turnoverLoading}
          <span class="spinner spinner-sm"></span>
        {:else if props.data.turnoverLast3Months !== null}
          <span class="mono">{props.data.turnoverLast3Months.toLocaleString(undefined, { maximumFractionDigits: 0 })} {props.data.symbol || 'CC'}</span>
          {#if props.data.turnoverLast3MonthsUsdc !== null}
            <span class="dim-text">≈ {props.data.turnoverLast3MonthsUsdc.toLocaleString(undefined, { maximumFractionDigits: 0 })} USDC</span>
          {/if}
        {:else}
          —
        {/if}
      </div>
      <div class="line meta">
        <span class="dim-text">{destChainName}:</span>
        <span class="addr mono">{truncateAddress(destAccount || '—')}</span>
        <button
          type="button"
          class="copy-btn"
          title={copied ? 'Copied!' : 'Copy full address'}
          aria-label="Copy full address"
          onclick={copyAddr}
        >{copied ? '✓' : '⧉'}</button>
        {#if subscanLink}
          <a
            href={subscanLink}
            target="_blank"
            rel="noopener"
            class="subscan-link"
            onclick={(e) => e.stopPropagation()}
          >Subscan ↗</a>
        {/if}
      </div>
    </div>
  {/if}
</div>

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
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }

  .recipient-card:hover {
    background: var(--color-surface-hover);
  }

  .recipient-card:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
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

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
    padding-top: 0.3rem;
    margin-top: 0.15rem;
    border-top: 1px dashed var(--color-border);
    font-size: 0.75rem;
  }

  .addr {
    color: var(--color-text-dim);
  }

  .copy-btn {
    padding: 0 0.35rem;
    font-size: 0.85rem;
    line-height: 1;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    color: var(--color-text-dim);
    cursor: pointer;
  }
  .copy-btn:hover {
    color: var(--color-accent);
    border-color: var(--color-accent);
  }

  .subscan-link {
    color: var(--color-accent);
    text-decoration: none;
    font-weight: 500;
  }
  .subscan-link:hover {
    text-decoration: underline;
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
    gap: 0.25rem;
  }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
  }

  .line {
    font-size: 0.85rem;
    line-height: 1.35;
  }

  .title {
    font-weight: 600;
    font-size: 0.95rem;
  }

  .mono {
    font-family: var(--font-mono);
  }
</style>
