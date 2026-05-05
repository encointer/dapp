<script lang="ts">
  import type { ChainId, TokenSymbol } from '../lib/types'
  import { CHAINS, getDecimals } from '../lib/chains'
  import { getWalletState } from '../lib/wallet.svelte'
  import { getBalanceFor } from '../lib/balances.svelte'
  import { formatBalance, parseAmount, truncateAddress } from '../lib/format'
  import {
    loadRecipients,
    getFaucets,
    getTreasuries,
    isLoadingRecipients,
    isRecipientsLoaded,
    getRecipientsError,
    isSelected,
    toggleSelected,
    clearSelection,
    selectionCount,
    selectAll,
  } from '../lib/recipients.svelte'
  import {
    estimateDonate,
    executeDonate,
    resetDonate,
    getDonateState,
    splitAmount,
    recipientFromFaucet,
    recipientFromTreasury,
    destinationChain,
    subscanUrl,
    ALLOWED_SOURCES,
    type DonateRecipient,
  } from '../lib/donate.svelte'
  import RecipientCard from '../components/RecipientCard.svelte'
  import AmountInput from '../components/AmountInput.svelte'
  import { parseDonateUrlParams } from '../lib/donateUrl'

  // URL param prefill (asset/source/amount/recipients). Recipient ids resolve
  // once the recipients data is loaded. Each value is consumed once: setting
  // it to undefined prevents re-applying after the user adjusts.
  const initialUrl = parseDonateUrlParams()

  let token = $state<TokenSymbol>(initialUrl.token ?? 'KSM')
  let source = $state<ChainId | null>(
    initialUrl.source && (initialUrl.token ? ALLOWED_SOURCES[initialUrl.token].includes(initialUrl.source) : true)
      ? initialUrl.source
      : null,
  )
  let amountStr = $state(initialUrl.amount ?? '')
  let urlRecipientsPending = $state<string[] | null>(initialUrl.recipients ?? null)

  const wallet = $derived(getWalletState())
  const txState = $derived(getDonateState())
  const recipientsLoading = $derived(isLoadingRecipients())
  const recipientsErr = $derived(getRecipientsError())
  const faucets = $derived(getFaucets())
  const treasuries = $derived(getTreasuries())

  // Load recipients once when wallet connects (uses chain clients only — wallet not strictly required)
  $effect(() => {
    if (!isRecipientsLoaded() && !isLoadingRecipients()) {
      loadRecipients()
    }
  })

  // Track which token's recipients have been auto-defaulted (select-all).
  // Once defaulted for a token, we don't override user adjustments.
  let defaultedFor = $state<TokenSymbol | null>(null)

  // Reset selection on token CHANGE. The first run is a mount, not a change —
  // skipping it preserves URL-prefilled `source` (which would otherwise be
  // wiped by `source = null` below before the user even sees the page).
  let tokenChangeFirstRun = true
  $effect(() => {
    void token
    if (tokenChangeFirstRun) { tokenChangeFirstRun = false; return }
    clearSelection()
    source = null
    defaultedFor = null
  })

  // Pre-select source. Rules:
  // 1. User choice (any non-null source) is never overridden.
  // 2. Wait for at least one balance entry before auto-picking (don't lock in a
  //    choice based on placeholder zeros).
  // 3. Prefer the destination chain (no cross-chain tx) when it has a nonzero
  //    transferable. Only fall back to a remote chain if dest has none.
  // 4. If every allowed chain has zero, prefer dest when it's allowed.
  $effect(() => {
    if (source) return
    const allowed = ALLOWED_SOURCES[token]
    const bals = new Map<ChainId, bigint>()
    let anyHasData = false
    for (const c of allowed) {
      const b = getBalanceFor(c, token)
      if (b) {
        anyHasData = true
        bals.set(c, b.transferable)
      }
    }
    if (!anyHasData) return // balances haven't arrived; let user click if they want

    const destChain = destinationChain(token)
    if (allowed.includes(destChain) && (bals.get(destChain) ?? 0n) > 0n) {
      source = destChain
      return
    }
    let best: ChainId | null = null
    let bestAmt = 0n
    for (const c of allowed) {
      const v = bals.get(c) ?? 0n
      if (v > bestAmt) { best = c; bestAmt = v }
    }
    source = best ?? (allowed.includes(destChain) ? destChain : allowed[0])
  })

  const allowedSources = $derived(ALLOWED_SOURCES[token])
  const dest = $derived(destinationChain(token))
  // Guard against transient source/token mismatch when switching tokens
  const validSource = $derived(source && allowedSources.includes(source) ? source : null)
  const decimals = $derived(validSource ? getDecimals(validSource, token) : (token === 'KSM' ? 12 : 6))

  const recipients = $derived<DonateRecipient[]>(
    token === 'KSM'
      ? faucets.map(recipientFromFaucet)
      : treasuries.filter(t => !!t.kahAccount).map(recipientFromTreasury),
  )

  const disabledIds = $derived(
    new Set(treasuries.filter(t => t.donationsDisabled && t.kahAccount).map(t => t.kahAccount)),
  )

  const selectedRecipients = $derived(
    recipients.filter(r => isSelected(r.id) && !disabledIds.has(r.id)),
  )

  // Apply URL-driven recipient pre-selection once recipients are loaded.
  // Matches URL identifiers against:
  //   - USDC token: cid (treasury) → recipient id is the kahAccount
  //   - KSM token: faucet account SS58 OR faucet name (case-insensitive)
  // Consumes the pending list (set to null) so subsequent token changes go
  // through the normal default-all flow.
  $effect(() => {
    if (urlRecipientsPending == null) return
    if (recipients.length === 0) return
    const wanted = new Set(urlRecipientsPending.map(s => s.toLowerCase()))
    const matchedIds: string[] = []
    if (token === 'USDC') {
      for (const t of treasuries) {
        if (!t.kahAccount || disabledIds.has(t.kahAccount)) continue
        if (wanted.has(t.cid.toLowerCase())) matchedIds.push(t.kahAccount)
      }
    } else {
      for (const f of faucets) {
        if (wanted.has(f.account.toLowerCase()) || wanted.has((f.name ?? '').toLowerCase())) {
          matchedIds.push(f.account)
        }
      }
    }
    if (matchedIds.length > 0) {
      selectAll(matchedIds)
      defaultedFor = token
    }
    urlRecipientsPending = null
  })

  // Default-select all enabled recipients once they appear for the current token.
  // Stays sticky after the user adjusts (we only re-default on token change).
  $effect(() => {
    if (defaultedFor === token) return
    if (recipients.length === 0) return
    selectAll(recipients.filter(r => !disabledIds.has(r.id)).map(r => r.id))
    defaultedFor = token
  })

  const totalAmount = $derived(parseAmount(amountStr, decimals))

  const perRecipient = $derived.by(() => {
    if (!totalAmount || selectionCount() === 0) return null
    const splits = splitAmount(totalAmount, selectionCount())
    return splits[splits.length - 1] // base share (last == base, first has remainder)
  })

  const canContinue = $derived(
    !!wallet.connected &&
    !!wallet.address &&
    !!validSource &&
    selectionCount() > 0 &&
    !!totalAmount &&
    txState.step === 'idle'
  )

  async function handleContinue() {
    if (!validSource || !wallet.address || !totalAmount) return
    await estimateDonate(
      { token, source: validSource, recipients: selectedRecipients, totalAmount },
      wallet.address,
    )
  }

  async function handleConfirm() {
    if (!validSource || !wallet.address || !wallet.signer || !totalAmount) return
    const ok = await executeDonate(
      { token, source: validSource, recipients: selectedRecipients, totalAmount },
      wallet.signer,
      wallet.address,
    )
    if (ok) clearSelection()
  }

  function handleBack() {
    resetDonate()
  }

  function handleReset() {
    resetDonate()
    clearSelection()
    amountStr = ''
  }
</script>

<div class="donate">
  <section class="card intro">
    <h2>Donate to humans directly — zero intermediaries</h2>
    <p>
      Encointer's <a href="https://book.encointer.org/protocol-personhood.html" target="_blank" rel="noopener">proof-of-personhood</a>
      protocol verifies unique humans through synchronous local meetups. That makes it possible to send funds
      to people on-chain without going through any organisation, NGO, or payment processor.
    </p>
    <ul>
      <li>
        <strong>Faucets (KSM)</strong> distribute KSM directly and individually to every verified unique
        community member who attends a ceremony. No gatekeeper picks recipients —
        eligibility is permissionlessly proven on-chain.
        See <a href="https://book.encointer.org/tutorials-faucets.html" target="_blank" rel="noopener">faucets</a>.
      </li>
      <li>
        <strong>Community treasuries (USDC)</strong> hold funds for a community on a key-less account that
        nobody controls unilaterally. Spending happens only via on-chain
        <a href="https://book.encointer.org/protocol-democracy.html" target="_blank" rel="noopener">democracy</a>
        with <strong>one person, one vote</strong> per attestation — funding the reserve gives every
        verified member equal say over how it's used.
        See <a href="https://book.encointer.org/protocol-treasuries.html" target="_blank" rel="noopener">treasuries</a>.
      </li>
    </ul>
  </section>

  {#if !wallet.connected}
    <div class="card connect-prompt">
      <p>Connect your wallet to donate to encointer faucets and community treasuries.</p>
    </div>
  {:else if recipientsLoading && !isRecipientsLoaded()}
    <div class="card status-card">
      <span class="spinner"></span>
      <p class="dim-text">Loading faucets and treasuries...</p>
    </div>
  {:else if recipientsErr}
    <div class="card error-card">
      <p class="error-text">{recipientsErr}</p>
      <button class="btn btn-primary" onclick={() => loadRecipients()}>Retry</button>
    </div>
  {:else if txState.step === 'idle' || txState.step === 'estimating'}
    <section class="card">
      <h2>Donate</h2>

      <div class="form-row">
        <span class="form-label">Asset</span>
        <div class="token-tabs">
          <button class="tab" class:active={token === 'KSM'} onclick={() => token = 'KSM'} type="button">KSM → faucets</button>
          <button class="tab" class:active={token === 'USDC'} onclick={() => token = 'USDC'} type="button">USDC → treasuries</button>
        </div>
      </div>

      <div class="form-row source-row">
        <span class="form-label">From</span>
        <div class="source-cards">
          {#each allowedSources as c}
            {@const bal = getBalanceFor(c, token)}
            {@const cDecimals = getDecimals(c, token)}
            <button
              class="source-card"
              class:selected={validSource === c}
              onclick={() => source = c}
              type="button"
            >
              <span class="chain-name">{CHAINS[c].name}</span>
              <span class="chain-balance">
                {bal ? formatBalance(bal.transferable, cDecimals) : '—'} {token}
              </span>
              {#if c !== dest}
                <span class="badge">cross-chain</span>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    </section>

    <section class="card">
      <h3>Recipients ({selectionCount()} selected)</h3>
      {#if recipients.length === 0}
        <p class="dim-text">No {token === 'KSM' ? 'faucets' : 'treasuries'} found.</p>
      {:else}
        <div class="recipient-list">
          {#each recipients as r}
            {#if token === 'KSM'}
              {@const f = faucets.find(x => x.account === r.id)!}
              <RecipientCard kind="faucet" data={f} selected={isSelected(r.id)} onToggle={() => toggleSelected(r.id)} />
            {:else}
              {@const t = treasuries.find(x => x.kahAccount === r.id)!}
              <RecipientCard kind="treasury" data={t} selected={isSelected(r.id)} onToggle={() => toggleSelected(r.id)} />
            {/if}
          {/each}
        </div>
      {/if}
    </section>

    <section class="card">
      <div class="form-row">
        <!-- svelte-ignore a11y_label_has_associated_control -->
        <label>Total</label>
        {#if validSource}
          <AmountInput value={amountStr} source={validSource} {token} oninput={(v) => amountStr = v} />
        {/if}
      </div>

      {#if perRecipient !== null && selectionCount() > 1}
        <div class="form-row sub">
          <span class="form-label"></span>
          <span class="dim-text">
            ≈ {formatBalance(perRecipient, decimals)} {token} per recipient
          </span>
        </div>
      {/if}

      <button class="btn btn-primary submit-btn" disabled={!canContinue} onclick={handleContinue}>
        {#if txState.step === 'estimating'}Estimating...{:else}Continue &rarr;{/if}
      </button>
    </section>
  {:else if txState.step === 'ready'}
    <section class="card">
      <h2>Confirm Donation</h2>
      <div class="summary">
        <div><span class="dim-text">Asset:</span> {token} from {source ? CHAINS[source].name : ''}</div>
        <div><span class="dim-text">Recipients:</span> {selectionCount()}</div>
        <div><span class="dim-text">Total:</span> {totalAmount ? formatBalance(totalAmount, decimals) : '—'} {token}</div>
        <div><span class="dim-text">Mode:</span> {txState.mode === 'batch' ? 'single batched signature' : `${selectedRecipients.length} signatures`}</div>
        <div><span class="dim-text">Estimated fee:</span> {formatBalance(txState.fee, txState.feeDecimals)} {txState.feeSymbol}</div>
      </div>
      <div class="actions">
        <button class="btn btn-ghost" onclick={handleBack}>Back</button>
        <button class="btn btn-primary" onclick={handleConfirm}>Confirm</button>
      </div>
    </section>
  {:else if txState.step === 'executing'}
    <section class="card status-card">
      <span class="spinner"></span>
      <p>
        {#if txState.mode === 'batch'}
          Submitting batch...
        {:else}
          Submitting {txState.current + 1} of {txState.total}...
        {/if}
      </p>
    </section>
  {:else if txState.step === 'success'}
    <section class="card success-card">
      <p class="success-text">Donation submitted!</p>
      {#if source && source !== dest}
        <p class="dim-text">Cross-chain XCM transfers will land at the destination in ~6 minutes.</p>
      {/if}
      {#if txState.submitted.length > 0}
        <ul class="submitted-list">
          {#each txState.submitted as t}
            {@const link = subscanUrl(t.chain, t.txHash)}
            <li>
              <span class="dim-text">{CHAINS[t.chain].name}:</span>
              <span class="hash">{truncateAddress(t.txHash)}</span>
              {#if link}
                <a href={link} target="_blank" rel="noopener" class="subscan-link">view on Subscan ↗</a>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      <button class="btn btn-primary" onclick={handleReset}>Donate again</button>
    </section>
  {:else if txState.step === 'error'}
    <section class="card error-card">
      <p class="error-text">{txState.message}</p>
      <div class="actions">
        <button class="btn btn-ghost" onclick={handleReset}>Reset</button>
        <button class="btn btn-primary" onclick={handleBack}>Back</button>
      </div>
    </section>
  {/if}
</div>

<style>
  .donate {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  h2 { font-size: 1.1rem; font-weight: 600; }
  h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 0.5rem; }

  .connect-prompt {
    text-align: center;
    padding: 2rem;
    color: var(--color-text-dim);
  }

  .intro {
    font-size: 0.88rem;
    line-height: 1.45;
  }
  .intro h2 {
    margin-bottom: 0.5rem;
    font-size: 1.05rem;
  }
  .intro p, .intro ul {
    margin: 0.4rem 0;
    color: var(--color-text-dim);
  }
  .intro ul {
    padding-left: 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .intro strong {
    color: var(--color-text);
  }
  .intro a {
    color: var(--color-accent);
    text-decoration: none;
  }
  .intro a:hover {
    text-decoration: underline;
  }

  .form-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0.5rem 0;
  }
  .form-row.sub { margin-top: -0.25rem; }

  .form-row :global(label),
  .form-row .form-label {
    min-width: 60px;
    font-size: 0.9rem;
    color: var(--color-text-dim);
  }

  .token-tabs {
    display: flex;
    gap: 0.25rem;
    flex: 1;
  }
  .tab {
    flex: 1;
    padding: 0.4rem 0.5rem;
    font-size: 0.85rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-surface);
    cursor: pointer;
  }
  .tab.active {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  .badge {
    display: inline-block;
    margin-left: 0.4rem;
    padding: 0.05rem 0.4rem;
    font-size: 0.7rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-text-dim);
  }

  .source-row {
    align-items: stretch;
  }

  .source-cards {
    display: flex;
    gap: 0.4rem;
    flex: 1;
  }

  .source-card {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-surface);
    cursor: pointer;
    text-align: left;
    transition: background 0.15s, border-color 0.15s;
  }

  .source-card:hover {
    background: var(--color-surface-hover);
  }

  .source-card.selected {
    border-color: var(--color-accent);
    background: var(--color-surface-hover);
  }

  .source-card .chain-name {
    font-weight: 600;
    font-size: 0.9rem;
  }

  .source-card .chain-balance {
    font-family: var(--font-mono);
    font-size: 0.8rem;
    color: var(--color-text-dim);
  }

  .source-card .badge {
    align-self: flex-start;
    margin-left: 0;
    margin-top: 0.15rem;
  }

  .recipient-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .submit-btn { width: 100%; margin-top: 0.5rem; }

  .summary {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0.5rem 0 1rem;
    font-size: 0.9rem;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }
  .actions .btn { flex: 1; }

  .status-card {
    text-align: center;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .success-card {
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    align-items: center;
    padding: 1.5rem;
  }

  .submitted-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    width: 100%;
    font-size: 0.85rem;
  }
  .submitted-list li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: center;
    align-items: baseline;
  }
  .submitted-list .hash {
    font-family: var(--font-mono);
  }
  .subscan-link {
    color: var(--color-accent);
    text-decoration: none;
  }
  .subscan-link:hover {
    text-decoration: underline;
  }

  .success-text {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--color-success);
  }

  .error-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
</style>
