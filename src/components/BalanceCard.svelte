<script lang="ts">
  import type { ChainId, TokenSymbol } from '../lib/types'
  import { getChain, getDecimals } from '../lib/chains'
  import { formatBalance } from '../lib/format'
  import { getBalanceFor } from '../lib/balances.svelte'

  interface Props {
    chainId: ChainId
    token: TokenSymbol
    selected?: boolean
    onclick?: () => void
  }
  let { chainId, token, selected = false, onclick }: Props = $props()

  const chain = $derived(getChain(chainId))
  const entry = $derived(getBalanceFor(chainId, token))
  const decimals = $derived(getDecimals(chainId, token))
  const display = $derived(entry ? formatBalance(entry.transferable, decimals) : '—')
</script>

<button class="balance-row" class:selected onclick={onclick}>
  <span class="chain-name">{chain.name}</span>
  <span class="balance-value">{display} {token}</span>
</button>

<style>
  .balance-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius);
    border: 1px solid transparent;
    transition: background 0.15s, border-color 0.15s;
  }

  .balance-row:hover {
    background: var(--color-surface-hover);
  }

  .balance-row.selected {
    border-color: var(--color-accent);
    background: var(--color-surface-hover);
  }

  .chain-name {
    font-size: 0.9rem;
  }

  .balance-value {
    font-family: var(--font-mono);
    font-size: 0.9rem;
  }
</style>
