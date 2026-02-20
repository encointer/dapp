<script lang="ts">
  import type { HopProgress } from '../lib/types'
  import { getChain } from '../lib/chains'

  interface Props {
    hops: HopProgress[]
  }
  let { hops }: Props = $props()

  function statusIcon(status: HopProgress['status']): string {
    switch (status) {
      case 'pending': return '\u25CB'   // ○
      case 'signing': return '\u270E'   // ✎
      case 'submitted': return '\u25CF' // ●
      case 'success': return '\u2714'   // ✔
      case 'error': return '\u2718'     // ✘
    }
  }

  function statusLabel(status: HopProgress['status']): string {
    switch (status) {
      case 'pending': return 'Waiting'
      case 'signing': return 'Sign in wallet...'
      case 'submitted': return 'Submitting...'
      case 'success': return 'Done'
      case 'error': return 'Failed'
    }
  }
</script>

<div class="progress">
  {#each hops as hp, i}
    <div class="hop-row" class:error={hp.status === 'error'} class:success={hp.status === 'success'}>
      <span class="hop-icon">{statusIcon(hp.status)}</span>
      <div class="hop-info">
        <span class="hop-label">
          Hop {i + 1}: {getChain(hp.hop.from).name} &rarr; {getChain(hp.hop.to).name}
        </span>
        <span class="hop-status">{statusLabel(hp.status)}</span>
        {#if hp.error}
          <span class="error-text">{hp.error}</span>
        {/if}
      </div>
    </div>
  {/each}
</div>

<style>
  .progress {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .hop-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .hop-icon {
    font-size: 1.1rem;
    min-width: 1.5rem;
    text-align: center;
  }

  .hop-info {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .hop-label {
    font-size: 0.9rem;
    font-weight: 500;
  }

  .hop-status {
    font-size: 0.8rem;
    color: var(--color-text-dim);
  }

  .success .hop-icon { color: var(--color-success); }
  .error .hop-icon { color: var(--color-error); }
</style>
