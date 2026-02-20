<script lang="ts">
  import { getProviderMode, setProviderMode } from '../lib/settings.svelte'
  import { connect } from '../lib/provider.svelte'
  import { getSyncStatuses } from '../lib/provider.svelte'
  import { CHAIN_IDS, CHAINS } from '../lib/chains'
  import type { ProviderMode } from '../lib/types'

  interface Props {
    onClose: () => void
  }
  let { onClose }: Props = $props()

  const mode = $derived(getProviderMode())
  const statuses = $derived(getSyncStatuses())

  async function handleModeChange(newMode: ProviderMode) {
    setProviderMode(newMode)
    await connect(newMode)
  }
</script>

<div class="panel card">
  <div class="panel-header">
    <h3>Settings</h3>
    <button class="close-btn" onclick={onClose}>&times;</button>
  </div>

  <div class="section">
    <span class="section-label">Provider</span>
    <div class="radio-group">
      <label class="radio-option" class:active={mode === 'smoldot'}>
        <input
          type="radio"
          name="provider"
          value="smoldot"
          checked={mode === 'smoldot'}
          onchange={() => handleModeChange('smoldot')}
        />
        <div>
          <span class="radio-label">Light Client</span>
          <span class="radio-desc">Trustless, slower sync</span>
        </div>
      </label>
      <label class="radio-option" class:active={mode === 'rpc'}>
        <input
          type="radio"
          name="provider"
          value="rpc"
          checked={mode === 'rpc'}
          onchange={() => handleModeChange('rpc')}
        />
        <div>
          <span class="radio-label">RPC</span>
          <span class="radio-desc">Fast, trusts endpoint</span>
        </div>
      </label>
    </div>
  </div>

  <div class="section">
    <span class="section-label">Chain Status</span>
    <div class="chain-status-list">
      {#each CHAIN_IDS as id}
        <div class="chain-status-row">
          <span>{CHAINS[id].name}</span>
          <span class="status-dot" class:synced={statuses[id] === 'synced'} class:syncing={statuses[id] === 'syncing'}></span>
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .panel {
    position: absolute;
    top: 100%;
    right: 0.5rem;
    z-index: 10;
    min-width: 260px;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }

  h3 { font-size: 1rem; font-weight: 600; }

  .close-btn {
    font-size: 1.3rem;
    color: var(--color-text-dim);
  }

  .section { margin-bottom: 0.75rem; }
  .section-label {
    display: block;
    font-size: 0.8rem;
    color: var(--color-text-dim);
    margin-bottom: 0.4rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .radio-group {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .radio-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    border-radius: var(--radius);
    cursor: pointer;
    transition: background 0.15s;
  }

  .radio-option:hover { background: var(--color-surface-hover); }
  .radio-option.active { background: var(--color-surface-hover); }

  .radio-option input[type="radio"] { margin: 0; }

  .radio-label { display: block; font-weight: 500; font-size: 0.9rem; }
  .radio-desc { display: block; font-size: 0.75rem; color: var(--color-text-dim); }

  .chain-status-list {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .chain-status-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.85rem;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-error);
  }

  .status-dot.synced { background: var(--color-success); }
  .status-dot.syncing { background: var(--color-warning); }
</style>
