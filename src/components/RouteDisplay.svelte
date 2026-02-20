<script lang="ts">
  import type { Route } from '../lib/types'
  import { getChain } from '../lib/chains'

  interface Props {
    route: Route
  }
  let { route }: Props = $props()

  // Collect unique chain names in order
  const chainNames = $derived.by(() => {
    const names: string[] = [getChain(route.hops[0].from).name]
    for (const hop of route.hops) {
      names.push(getChain(hop.to).name)
    }
    return names
  })
</script>

<div class="route">
  {#each chainNames as name, i}
    <span class="chain-node">{name}</span>
    {#if i < chainNames.length - 1}
      <span class="arrow">&rarr;</span>
    {/if}
  {/each}
</div>

<style>
  .route {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    font-size: 0.9rem;
  }

  .chain-node {
    padding: 0.3rem 0.6rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    font-weight: 500;
  }

  .arrow {
    color: var(--color-text-dim);
  }
</style>
