<script lang="ts">
  import type { ChainId, TokenSymbol, TransferParams } from '../lib/types'
  import { CHAINS, CHAIN_IDS, chainHasToken, getDecimals } from '../lib/chains'
  import { getWalletState } from '../lib/wallet.svelte'
  import { getBalances, getBalanceFor, isLoading as balancesLoading } from '../lib/balances.svelte'
  import { getDestinations, detectSource } from '../lib/routing'
  import { formatBalance, parseAmount } from '../lib/format'
  import { getSs58AddressInfo } from 'polkadot-api'
  import TokenSelector from '../components/TokenSelector.svelte'
  import DestinationSelector from '../components/DestinationSelector.svelte'
  import AmountInput from '../components/AmountInput.svelte'

  interface Props {
    onTransfer: (params: TransferParams) => void
  }
  let { onTransfer }: Props = $props()

  let selectedToken = $state<TokenSymbol>('KSM')
  let source = $state<ChainId | null>(null)
  let destination = $state<ChainId | null>(null)
  let amountStr = $state('')
  /** Recipient address. Only used (and shown) when destination === source. */
  let recipientStr = $state('')

  const wallet = $derived(getWalletState())
  const balances = $derived(getBalances())
  const loading = $derived(balancesLoading())

  // Auto-detect source from highest balance
  $effect(() => {
    if (!source) {
      const detected = detectSource(selectedToken, balances)
      if (detected) source = detected
    }
  })

  // Default the destination to the first cross-chain option (preserves the
  // long-standing UX); same-chain (== source) is also selectable but never
  // auto-picked.
  $effect(() => {
    if (source) {
      const dests = getDestinations(selectedToken, source)
      const firstCrossChain = dests.find(d => d !== source) ?? dests[0]
      if (destination && !dests.includes(destination)) {
        destination = firstCrossChain ?? null
      } else if (!destination) {
        destination = firstCrossChain ?? null
      }
    }
  })

  const effectiveSource = $derived(source ?? 'encointer')
  const sameChain = $derived(!!source && destination === source)

  const recipientValidity = $derived.by(() => {
    if (!recipientStr) return { ok: false, reason: 'empty' as const }
    const info = getSs58AddressInfo(recipientStr.trim())
    return info.isValid
      ? { ok: true as const }
      : { ok: false, reason: 'invalid' as const }
  })

  const canSubmit = $derived.by(() => {
    if (!wallet.connected || !wallet.address) return false
    if (!source || !destination) return false
    const decimals = getDecimals(effectiveSource, selectedToken)
    const amount = parseAmount(amountStr, decimals)
    if (amount === null || amount <= 0n) return false
    if (sameChain && !recipientValidity.ok) return false
    return true
  })

  function handleSubmit() {
    if (!source || !destination) return
    const decimals = getDecimals(effectiveSource, selectedToken)
    const amount = parseAmount(amountStr, decimals)
    if (!amount) return
    const recipient = sameChain ? recipientStr.trim() : (wallet.address ?? '')
    onTransfer({ token: selectedToken, source, destination, amount, recipient })
  }

  function handleTokenChange(token: TokenSymbol) {
    selectedToken = token
    source = null
    destination = null
  }

  function handleSourceSelect(chainId: ChainId) {
    source = chainId
  }

  // Tokens displayed as grid columns; chains as rows.
  const gridTokens: TokenSymbol[] = ['KSM', 'DOT', 'USDC']
  const gridChains = CHAIN_IDS
</script>

<div class="home">
  {#if !wallet.connected}
    <div class="card connect-prompt">
      <p>Connect your wallet to view balances and make transfers.</p>
    </div>
  {:else}
    <section class="balances-section">
      <div class="section-header">
        <h2>Your Balances</h2>
        {#if loading}
          <span class="loading-indicator"><span class="spinner spinner-sm"></span> Loading...</span>
        {/if}
      </div>

      <div class="balances-grid card">
        <div class="grid-cell corner"></div>
        {#each gridTokens as token}
          <div class="grid-cell token-header">{token}</div>
        {/each}
        {#each gridChains as chainId}
          <div class="grid-cell chain-header">{CHAINS[chainId].name}</div>
          {#each gridTokens as token}
            {#if chainHasToken(chainId, token)}
              {@const entry = getBalanceFor(chainId, token)}
              {@const dec = getDecimals(chainId, token)}
              <button
                class="grid-cell balance-cell"
                class:selected={selectedToken === token && source === chainId}
                onclick={() => { selectedToken = token; handleSourceSelect(chainId) }}
                type="button"
              >
                {entry ? formatBalance(entry.transferable, dec) : '—'}
              </button>
            {:else}
              <div class="grid-cell empty dim-text">—</div>
            {/if}
          {/each}
        {/each}
      </div>
    </section>

    <section class="send-section card">
      <h2>Send</h2>

      <div class="form-row">
        <!-- svelte-ignore a11y_label_has_associated_control -->
        <label>Token</label>
        <TokenSelector value={selectedToken} onchange={handleTokenChange} />
      </div>

      {#if source}
        <div class="form-row">
          <span class="form-label">From</span>
          <span class="source-name">{CHAINS[source].name}</span>
        </div>
      {/if}

      <div class="form-row">
        <!-- svelte-ignore a11y_label_has_associated_control -->
        <label>To</label>
        <DestinationSelector
          token={selectedToken}
          source={effectiveSource}
          value={destination}
          onchange={(d) => destination = d}
        />
      </div>

      {#if sameChain}
        <div class="form-row">
          <!-- svelte-ignore a11y_label_has_associated_control -->
          <label>Recipient</label>
          <input
            type="text"
            class="recipient-input"
            placeholder="SS58 address on {source ? CHAINS[source].name : ''}"
            value={recipientStr}
            oninput={(e) => recipientStr = (e.target as HTMLInputElement).value}
          />
        </div>
        {#if recipientStr && !recipientValidity.ok}
          <div class="form-row sub">
            <span class="form-label"></span>
            <span class="address-error">⚠ Invalid SS58 address (checksum mismatch)</span>
          </div>
        {/if}
      {/if}

      <div class="form-row">
        <!-- svelte-ignore a11y_label_has_associated_control -->
        <label>Amount</label>
        <AmountInput
          value={amountStr}
          source={effectiveSource}
          token={selectedToken}
          oninput={(v) => amountStr = v}
        />
      </div>

      <button class="btn btn-primary submit-btn" disabled={!canSubmit} onclick={handleSubmit}>
        Continue &rarr;
      </button>
    </section>
  {/if}
</div>

<style>
  .home {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .connect-prompt {
    text-align: center;
    padding: 2rem;
    color: var(--color-text-dim);
  }

  .balances-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  h2 {
    font-size: 1.1rem;
    font-weight: 600;
  }

  .balances-grid {
    display: grid;
    grid-template-columns: minmax(8rem, auto) repeat(3, 1fr);
    gap: 0.25rem;
    padding: 0.5rem 0.6rem;
  }
  .grid-cell {
    padding: 0.45rem 0.55rem;
    border-radius: var(--radius);
    border: 1px solid transparent;
    font-size: 0.85rem;
    font-family: var(--font-mono);
    text-align: right;
  }
  .grid-cell.corner {
    visibility: hidden;
  }
  .grid-cell.token-header {
    text-align: right;
    font-family: inherit;
    font-weight: 600;
    color: var(--color-text-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.78rem;
  }
  .grid-cell.chain-header {
    text-align: left;
    font-family: inherit;
    font-weight: 600;
    color: var(--color-text);
    font-size: 0.85rem;
  }
  .grid-cell.balance-cell {
    background: transparent;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .grid-cell.balance-cell:hover {
    background: var(--color-surface-hover);
  }
  .grid-cell.balance-cell.selected {
    border-color: var(--color-accent);
    background: var(--color-surface-hover);
  }
  .grid-cell.empty {
    text-align: right;
    cursor: default;
  }

  .send-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .form-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .form-row label, .form-row .form-label {
    min-width: 60px;
    font-size: 0.9rem;
    color: var(--color-text-dim);
  }

  .source-name {
    font-weight: 500;
  }

  .submit-btn {
    width: 100%;
    margin-top: 0.5rem;
  }

  .form-row.sub { margin-top: -0.4rem; }

  .recipient-input {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: 0.85rem;
  }

  .address-error {
    font-size: 0.78rem;
    color: var(--color-danger, #b13030);
  }

  .loading-indicator {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: var(--color-text-dim);
  }
</style>
