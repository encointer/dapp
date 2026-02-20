<script lang="ts">
  import type { TokenSymbol } from '../lib/types'
  import { TOKEN_SYMBOLS } from '../lib/chains'

  interface Props {
    value: TokenSymbol
    onchange: (token: TokenSymbol) => void
  }
  let { value, onchange }: Props = $props()

  function handleChange(e: Event) {
    const target = e.target as HTMLSelectElement
    onchange(target.value as TokenSymbol)
  }
</script>

<select {value} onchange={handleChange}>
  {#each TOKEN_SYMBOLS as sym}
    <option value={sym}>{sym}</option>
  {/each}
</select>

<style>
  select {
    min-width: 80px;
    cursor: pointer;
  }
</style>
