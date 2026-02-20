<script lang="ts">
  import StatusBadge from './StatusBadge.svelte'
  import WalletModal from './WalletModal.svelte'
  import SettingsPanel from './SettingsPanel.svelte'
  import { getWalletState, disconnect } from '../lib/wallet.svelte'
  import { truncateAddress } from '../lib/format'

  let showWallet = $state(false)
  let showSettings = $state(false)

  const wallet = $derived(getWalletState())
</script>

<header>
  <div class="header-left">
    <img src="/logo.png" alt="Encointer" class="logo" />
    <span class="title">Transfer</span>
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

  .title {
    font-weight: 600;
    font-size: 1.1rem;
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
