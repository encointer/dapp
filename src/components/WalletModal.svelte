<script lang="ts">
  import {
    discoverExtensions,
    connectExtension,
    selectAccount,
    getWalletState,
  } from '../lib/wallet.svelte'
  import { truncateAddress } from '../lib/format'

  interface Props {
    onClose: () => void
  }
  let { onClose }: Props = $props()

  let dialogEl: HTMLDialogElement

  const extensions = $derived(discoverExtensions())
  const wallet = $derived(getWalletState())

  $effect(() => {
    dialogEl?.showModal()
  })

  function handleClose() {
    dialogEl?.close()
    onClose()
  }

  async function handleConnect(name: string) {
    await connectExtension(name)
  }

  function handleSelectAccount(addr: string) {
    selectAccount(addr)
    handleClose()
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialogEl} onclose={handleClose} onkeydown={(e) => e.key === 'Escape' && handleClose()}>
  <div class="modal-header">
    <h3>{wallet.connected ? 'Select Account' : 'Connect Wallet'}</h3>
    <button class="close-btn" onclick={handleClose}>&times;</button>
  </div>

  {#if wallet.error}
    <p class="error-text">{wallet.error}</p>
  {/if}

  {#if wallet.connecting}
    <p class="dim-text">Connecting...</p>
  {:else if wallet.connected && wallet.accounts.length > 0}
    <ul class="account-list">
      {#each wallet.accounts as account}
        <li>
          <button
            class="account-btn"
            class:selected={account.address === wallet.address}
            onclick={() => handleSelectAccount(account.address)}
          >
            <span class="account-name">{account.name ?? 'Account'}</span>
            <span class="account-addr">{truncateAddress(account.address)}</span>
          </button>
        </li>
      {/each}
    </ul>
  {:else if extensions.length > 0}
    <ul class="extension-list">
      {#each extensions as ext}
        <li>
          <button class="btn btn-ghost extension-btn" onclick={() => handleConnect(ext)}>
            {ext}
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="dim-text">
      No wallet extension found. Install
      <a href="https://www.talisman.xyz/" target="_blank" rel="noopener">Talisman</a>,
      <a href="https://www.subwallet.app/" target="_blank" rel="noopener">SubWallet</a>, or
      <a href="https://polkadot.js.org/extension/" target="_blank" rel="noopener">Polkadot-JS</a>.
    </p>
  {/if}
</dialog>

<style>
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  h3 {
    font-size: 1.1rem;
    font-weight: 600;
  }

  .close-btn {
    font-size: 1.5rem;
    line-height: 1;
    color: var(--color-text-dim);
  }

  .extension-list, .account-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .extension-btn {
    width: 100%;
    text-align: left;
    text-transform: capitalize;
  }

  .account-btn {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 0.75rem;
    border-radius: var(--radius);
    border: 1px solid var(--color-border);
    transition: background 0.15s;
  }

  .account-btn:hover {
    background: var(--color-surface-hover);
  }

  .account-btn.selected {
    border-color: var(--color-accent);
  }

  .account-name {
    font-weight: 500;
  }

  .account-addr {
    color: var(--color-text-dim);
    font-family: var(--font-mono);
    font-size: 0.85rem;
  }

  a {
    color: var(--color-accent);
  }
</style>
