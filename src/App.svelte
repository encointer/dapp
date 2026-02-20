<script lang="ts">
  import Header from './components/Header.svelte'
  import HomeView from './views/HomeView.svelte'
  import TransferView from './views/TransferView.svelte'
  import type { TransferParams } from './lib/types'
  import { connect } from './lib/provider.svelte'
  import { autoReconnect, getWalletState } from './lib/wallet.svelte'
  import { startAutoRefresh, stopAutoRefresh } from './lib/balances.svelte'
  import { getProviderMode } from './lib/settings.svelte'

  let view = $state<'home' | 'transfer'>('home')
  let transferParams = $state<TransferParams | null>(null)

  // Initialize provider + wallet on mount
  $effect(() => {
    connect(getProviderMode()).then(() => autoReconnect())
  })

  // Auto-refresh balances when wallet is connected
  $effect(() => {
    const wallet = getWalletState()
    if (wallet.address) {
      startAutoRefresh(wallet.address)
      return () => stopAutoRefresh()
    } else {
      stopAutoRefresh()
    }
  })

  function onNavigateTransfer(params: TransferParams) {
    transferParams = params
    view = 'transfer'
    window.location.hash = '#transfer'
  }

  function onNavigateHome() {
    transferParams = null
    view = 'home'
    window.location.hash = ''
  }

  function handleHashChange() {
    if (window.location.hash !== '#transfer') {
      view = 'home'
      transferParams = null
    }
  }

  $effect(() => {
    // Initialize from hash
    if (window.location.hash === '#transfer') {
      // If no params, go home
      if (!transferParams) {
        view = 'home'
        window.location.hash = ''
      }
    }

    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  })
</script>

<Header />

<main>
  {#if view === 'transfer' && transferParams}
    <TransferView params={transferParams} onBack={onNavigateHome} />
  {:else}
    <HomeView onTransfer={onNavigateTransfer} />
  {/if}
</main>

<style>
  main {
    flex: 1;
    width: 100%;
    max-width: 520px;
    margin: 0 auto;
    padding: 1rem;
  }
</style>
