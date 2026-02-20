<script lang="ts">
  import type { ChainId, TokenSymbol } from '../lib/types'
  import { getBalanceFor } from '../lib/balances.svelte'
  import { getDecimals } from '../lib/chains'
  import { formatBalance } from '../lib/format'

  interface Props {
    value: string
    source: ChainId
    token: TokenSymbol
    oninput: (value: string) => void
  }
  let { value, source, token, oninput }: Props = $props()

  const entry = $derived(getBalanceFor(source, token))
  const decimals = $derived(getDecimals(source, token))

  function handleMax() {
    if (entry && entry.transferable > 0n) {
      oninput(formatBalance(entry.transferable, decimals, decimals))
    }
  }
</script>

<div class="amount-wrapper">
  <input
    type="text"
    inputmode="decimal"
    placeholder="0.00"
    {value}
    oninput={(e) => oninput((e.target as HTMLInputElement).value)}
  />
  <button class="max-btn" onclick={handleMax} type="button">MAX</button>
</div>

<style>
  .amount-wrapper {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  input {
    flex: 1;
    min-width: 0;
  }

  .max-btn {
    padding: 0.4rem 0.6rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-accent);
    border: 1px solid var(--color-accent);
    border-radius: var(--radius);
    transition: background 0.15s;
  }

  .max-btn:hover {
    background: var(--color-accent);
    color: #fff;
  }
</style>
