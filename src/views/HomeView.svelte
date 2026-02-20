<script lang="ts">
  import type { ChainId, TokenSymbol, TransferParams } from '../lib/types'
  import { CHAINS, CHAIN_IDS, chainHasToken, getDecimals } from '../lib/chains'
  import { getWalletState } from '../lib/wallet.svelte'
  import { getBalances, isLoading as balancesLoading, fetchAllBalances } from '../lib/balances.svelte'
  import { getDestinations, detectSource } from '../lib/routing'
  import { parseAmount } from '../lib/format'
  import BalanceCard from '../components/BalanceCard.svelte'
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

  // Reset destination when token or source changes
  $effect(() => {
    if (source) {
      const dests = getDestinations(selectedToken, source)
      if (destination && !dests.includes(destination)) {
        destination = dests[0] ?? null
      } else if (!destination && dests.length > 0) {
        destination = dests[0]
      }
    }
  })

  const effectiveSource = $derived(source ?? 'encointer')

  const canSubmit = $derived.by(() => {
    if (!wallet.connected || !wallet.address) return false
    if (!source || !destination) return false
    const decimals = getDecimals(effectiveSource, selectedToken)
    const amount = parseAmount(amountStr, decimals)
    return amount !== null && amount > 0n
  })

  function handleSubmit() {
    if (!source || !destination) return
    const decimals = getDecimals(effectiveSource, selectedToken)
    const amount = parseAmount(amountStr, decimals)
    if (!amount) return
    onTransfer({ token: selectedToken, source, destination, amount })
  }

  function handleTokenChange(token: TokenSymbol) {
    selectedToken = token
    source = null
    destination = null
  }

  function handleSourceSelect(chainId: ChainId) {
    source = chainId
  }

  // Group chains by token for balance display
  const tokenGroups = $derived.by(() => {
    const groups: { token: TokenSymbol; chains: ChainId[] }[] = []
    for (const token of ['KSM', 'USDC'] as TokenSymbol[]) {
      const chains = CHAIN_IDS.filter(id => chainHasToken(id, token))
      groups.push({ token, chains })
    }
    return groups
  })
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
          <span class="dim-text">Updating...</span>
        {:else}
          <button class="btn-link" onclick={() => wallet.address && fetchAllBalances(wallet.address)}>
            Refresh
          </button>
        {/if}
      </div>

      {#each tokenGroups as group}
        <div class="token-group card">
          <h3 class="token-heading">{group.token}</h3>
          {#each group.chains as chainId}
            <BalanceCard
              {chainId}
              token={group.token}
              selected={selectedToken === group.token && source === chainId}
              onclick={() => {
                selectedToken = group.token
                handleSourceSelect(chainId)
              }}
            />
          {/each}
        </div>
      {/each}
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

  .token-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .token-heading {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--color-text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.25rem;
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

  .btn-link {
    font-size: 0.8rem;
    color: var(--color-accent);
    text-decoration: underline;
  }
</style>
