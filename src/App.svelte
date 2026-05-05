<script lang="ts">
  import Header from './components/Header.svelte'
  import HomeView from './views/HomeView.svelte'
  import TransferView from './views/TransferView.svelte'
  import DonateView from './views/DonateView.svelte'
  import type { TransferParams } from './lib/types'
  import { connect } from './lib/provider.svelte'
  import { autoReconnect, getWalletState } from './lib/wallet.svelte'
  import { startAutoRefresh, stopAutoRefresh } from './lib/balances.svelte'
  import { getProviderMode } from './lib/settings.svelte'

  type View = 'home' | 'transfer' | 'donate'

  function viewFromHash(hash: string): View {
    if (hash === '#donate') return 'donate'
    if (hash === '#transfer') return 'transfer'
    return 'home'
  }

  let view = $state<View>(viewFromHash(window.location.hash))
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
    const next = viewFromHash(window.location.hash)
    view = next
    if (next !== 'transfer') transferParams = null
  }

  $effect(() => {
    // If landed on #transfer with no params (e.g. page reload), redirect home
    if (view === 'transfer' && !transferParams) {
      view = 'home'
      window.location.hash = ''
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  })
</script>

<Header />

<main>
  {#if view === 'transfer' && transferParams}
    <TransferView params={transferParams} onBack={onNavigateHome} />
  {:else if view === 'donate'}
    <DonateView />
  {:else}
    <HomeView onTransfer={onNavigateTransfer} />
  {/if}
</main>

<footer>
  Built with
  <a href="https://papi.how/" target="_blank" rel="noopener">PAPI</a>
  and
  <a href="https://paraspell.xyz/" target="_blank" rel="noopener">ParaSpell</a>.
</footer>

<style>
  main {
    flex: 1;
    width: 100%;
    max-width: 520px;
    margin: 0 auto;
    padding: 1rem;
  }

  footer {
    width: 100%;
    max-width: 520px;
    margin: 0 auto;
    padding: 0.75rem 1rem 1.25rem;
    text-align: center;
    font-size: 0.75rem;
    color: var(--color-text-dim);
  }
  footer a {
    color: var(--color-text-dim);
    text-decoration: none;
    border-bottom: 1px dotted var(--color-text-dim);
  }
  footer a:hover {
    color: var(--color-accent);
    border-bottom-color: var(--color-accent);
  }
</style>
