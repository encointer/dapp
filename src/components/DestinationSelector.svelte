<script lang="ts">
  import type { ChainId, TokenSymbol } from '../lib/types'
  import { getDestinations } from '../lib/routing'
  import { getChain } from '../lib/chains'

  interface Props {
    token: TokenSymbol
    source: ChainId
    value: ChainId | null
    onchange: (chain: ChainId) => void
  }
  let { token, source, value, onchange }: Props = $props()

  const destinations = $derived(getDestinations(token, source))

  function handleChange(e: Event) {
    const target = e.target as HTMLSelectElement
    onchange(target.value as ChainId)
  }
</script>

<select value={value ?? ''} onchange={handleChange}>
  <option value="" disabled>Select destination</option>
  {#each destinations as dest}
    <option value={dest}>
      {getChain(dest).name}{dest === source ? ' (same-chain)' : ''}
    </option>
  {/each}
</select>

<style>
  select {
    min-width: 160px;
    cursor: pointer;
  }
</style>
