<script lang="ts">
  import StatusBadge from './StatusBadge.svelte'
  import WalletModal from './WalletModal.svelte'
  import SettingsPanel from './SettingsPanel.svelte'
  import { getWalletState, disconnect } from '../lib/wallet.svelte'
  import { truncateAddress } from '../lib/format'

  let showWallet = $state(false)
  let showSettings = $state(false)
  let currentHash = $state(window.location.hash)

  $effect(() => {
    const onHashChange = () => { currentHash = window.location.hash }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  })

  const wallet = $derived(getWalletState())
</script>

<header>
  <div class="header-left">
    <img src="/logo.png" alt="Encointer" class="logo" />
    <nav class="tabs">
      <!-- svelte-ignore a11y_invalid_attribute -->
      <a href="#" class="tab" class:active={currentHash !== '#donate'}>Transfer</a>
      <a href="#donate" class="tab" class:active={currentHash === '#donate'}>Donate</a>
    </nav>
    <StatusBadge />
  </div>

  <div class="header-right">
    <button class="btn btn-ghost settings-btn" onclick={() => showSettings = !showSettings}>
      &#9881;
    </button>

    {#if wallet.connected && wallet.address}
      <button class="btn btn-ghost wallet-btn" onclick={() => showWallet = true}>
        {wallet.name ?? truncateAddress(wallet.address)}
      </button>
      <button class="btn btn-ghost disconnect-btn" onclick={() => disconnect()}>
        &times;
      </button>
    {:else}
      <button class="btn btn-primary" onclick={() => showWallet = true}>
        Connect
      </button>
    {/if}
  </div>

  {#if showSettings}
    <SettingsPanel onClose={() => showSettings = false} />
  {/if}

  {#if showWallet}
    <WalletModal onClose={() => showWallet = false} />
  {/if}
</header>

<style>
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--color-border);
    position: relative;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .logo {
    height: 28px;
    width: auto;
  }

  .tabs {
    display: flex;
    gap: 0.25rem;
  }

  .tab {
    padding: 0.3rem 0.6rem;
    font-weight: 600;
    font-size: 0.95rem;
    color: var(--color-text-dim);
    text-decoration: none;
    border-bottom: 2px solid transparent;
  }

  .tab.active {
    color: var(--color-text);
    border-bottom-color: var(--color-accent);
  }

  .settings-btn {
    font-size: 1.2rem;
    padding: 0.4rem;
  }

  .wallet-btn {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .disconnect-btn {
    font-size: 1.2rem;
    padding: 0.3rem 0.5rem;
    color: var(--color-text-dim);
  }
</style>
