<script lang="ts">
  import { getSyncStatuses } from '../lib/provider.svelte'
  import { CHAIN_IDS } from '../lib/chains'
  import type { SyncStatus } from '../lib/types'

  const statuses = $derived(getSyncStatuses())

  const overallStatus = $derived.by((): SyncStatus => {
    const values = CHAIN_IDS.map(id => statuses[id])
    if (values.every(s => s === 'synced')) return 'synced'
    if (values.some(s => s === 'syncing')) return 'syncing'
    return 'disconnected'
  })

  const label = $derived(
    overallStatus === 'synced' ? 'Connected' :
    overallStatus === 'syncing' ? 'Syncing...' :
    'Disconnected'
  )
</script>

<span class="badge" class:synced={overallStatus === 'synced'} class:syncing={overallStatus === 'syncing'} class:disconnected={overallStatus === 'disconnected'}>
  <span class="dot"></span>
  {label}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.75rem;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    background: var(--color-surface);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }

  .synced .dot { background: var(--color-success); }
  .syncing .dot { background: var(--color-warning); animation: pulse 1.5s infinite; }
  .disconnected .dot { background: var(--color-error); }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
