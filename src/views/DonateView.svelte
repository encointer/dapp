<script lang="ts">
  import type { ChainId, TokenSymbol } from '../lib/types'
  import { CHAINS, getDecimals } from '../lib/chains'
  import { getWalletState } from '../lib/wallet.svelte'
  import { getBalanceFor } from '../lib/balances.svelte'
  import { formatBalance, formatNumber, parseAmount, truncateAddress } from '../lib/format'
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
  import LeaderboardCard from '../components/LeaderboardCard.svelte'
  import { parseDonateUrlParams } from '../lib/donateUrl'
  import {
    getTreasuryLeaderboard,
    getFaucetLeaderboards,
    type TreasuryLeaderboard,
    type FaucetLeaderboard,
  } from '../lib/accountingApi'

  // URL param prefill (asset/source/amount/recipients). Recipient ids resolve
  // once the recipients data is loaded. Each value is consumed once: setting
  // it to undefined prevents re-applying after the user adjusts.
  const initialUrl = parseDonateUrlParams()

  let showWeightingInfo = $state(false)

  let token = $state<TokenSymbol>(initialUrl.token ?? 'USDC')
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
      : [...treasuries]
          .filter(t => !!t.kahAccount)
          // Order by regularly-active count, descending. Communities whose
          // count is still loading (null) sort to the bottom.
          .sort((a, b) => (b.regularlyActivePersons ?? -1) - (a.regularlyActivePersons ?? -1))
          .map(recipientFromTreasury),
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

  // Weighted distribution per community (USDC):
  //   weight = reputables × √(3m turnover USDC) ÷ √(treasury balance USDC)
  // — reputables = community-size baseline, √turnover = activity bonus (damped),
  //   1/√treasury = "neediness" factor (well-funded treasuries get less).
  // Treasury balance is floored at 1 USDC to keep the divisor sane for empty pots.
  // Recipients without any data fall back to weight 1.
  const TREASURY_FLOOR_USDC = 1
  const recipientWeights = $derived.by<number[]>(() => {
    return selectedRecipients.map(r => {
      if (token === 'USDC') {
        const t = treasuries.find(x => x.kahAccount === r.id)
        if (t) {
          const reputables = Math.max(0, t.regularlyActivePersons ?? 0)
          const turnoverUsd = Math.max(0, t.turnoverLast3MonthsUsdc ?? 0)
          const treasuryUsd = Math.max(TREASURY_FLOOR_USDC, Number(t.usdcBalance) / 1e6)
          const w = (reputables * Math.sqrt(turnoverUsd)) / Math.sqrt(treasuryUsd)
          return Number.isFinite(w) && w > 0 ? w : 1
        }
      }
      return 1
    })
  })

  const weightingActive = $derived(
    recipientWeights.length > 1 &&
    !recipientWeights.every(w => w === recipientWeights[0]),
  )

  const perRecipientAmounts = $derived(
    totalAmount && selectedRecipients.length > 0
      ? splitAmount(totalAmount, selectedRecipients.length, weightingActive ? recipientWeights : undefined)
      : null,
  )

  // Soft-warn when the donation looks excessive vs. recent community activity.
  // - USDC: compare to sum of selected treasuries' last-3-months turnover (in USDC).
  //         If none of them have turnover data loaded yet, skip the check.
  // - KSM:  compare to 6 months (≈ 18 ceremony cycles, 10 d each) of expected drips
  //         at current participation across selected faucets.
  const CYCLES_PER_6M = 18n
  const donationWarning = $derived.by<string | null>(() => {
    if (!totalAmount || selectionCount() === 0) return null
    if (token === 'USDC') {
      let threshold = 0
      let anyKnown = false
      for (const t of treasuries) {
        if (!isSelected(t.kahAccount)) continue
        if (t.turnoverLast3MonthsUsdc != null) {
          threshold += t.turnoverLast3MonthsUsdc
          anyKnown = true
        }
      }
      if (!anyKnown) return null
      const totalUsdc = Number(totalAmount) / 1e6
      if (totalUsdc <= threshold) return null
      return `Your donation (~${formatNumber(totalUsdc, 0)} USDC) exceeds the selected communities' total turnover over the last 3 months (~${formatNumber(threshold, 0)} USDC). It may currently be too high in relation to community activity.`
    } else {
      // KSM: per faucet, expected drips per cycle = attestedPersons × dripAmount.
      let threshold = 0n
      for (const f of faucets) {
        if (!isSelected(f.account)) continue
        threshold += BigInt(f.attestedPersons) * f.dripAmount * CYCLES_PER_6M
      }
      if (totalAmount <= threshold && threshold > 0n) return null
      const fmt = (v: bigint) => formatNumber(Number(v) / 1e12, 4)
      if (threshold === 0n) {
        return `The selected faucets currently have no recently active drippers. This donation may sit unspent in the pot for some time.`
      }
      return `Your donation (~${fmt(totalAmount)} KSM) exceeds 6 months of drips at current participation (~${fmt(threshold)} KSM). It may currently be too high in relation to community activity.`
    }
  })


  // Available balance on the chosen source for the chosen token (already net of ED).
  // Returns null while balances haven't been fetched yet for that chain.
  const availableBalance = $derived.by<bigint | null>(() => {
    if (!validSource) return null
    const b = getBalanceFor(validSource, token)
    return b ? b.transferable : null
  })

  // True only after balances for the allowed sources have streamed in AND every
  // one of them is zero. We never flip this true while balances are still loading.
  const allBalancesZero = $derived.by<boolean>(() => {
    let anyData = false
    let anyNonZero = false
    for (const c of allowedSources) {
      const b = getBalanceFor(c, token)
      if (b) {
        anyData = true
        if (b.transferable > 0n) { anyNonZero = true; break }
      }
    }
    return anyData && !anyNonZero
  })

  const insufficientBalance = $derived(
    totalAmount !== null && availableBalance !== null && totalAmount > availableBalance,
  )

  const canContinue = $derived(
    !!wallet.connected &&
    !!wallet.address &&
    !!validSource &&
    selectionCount() > 0 &&
    !!totalAmount &&
    !insufficientBalance &&
    txState.step === 'idle'
  )

  async function handleContinue() {
    if (!validSource || !wallet.address || !totalAmount) return
    await estimateDonate(
      {
        token, source: validSource, recipients: selectedRecipients, totalAmount,
        weights: weightingActive ? recipientWeights : undefined,
      },
      wallet.address,
    )
  }

  async function handleConfirm() {
    if (!validSource || !wallet.address || !wallet.signer || !totalAmount) return
    const ok = await executeDonate(
      {
        token, source: validSource, recipients: selectedRecipients, totalAmount,
        weights: weightingActive ? recipientWeights : undefined,
      },
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

  // Leaderboards: fetched lazily once recipients are loaded.
  // Treasuries keyed by cid; faucet leaderboards keyed by account.
  let treasuryBoards = $state<Record<string, TreasuryLeaderboard | null>>({})
  let faucetBoards = $state<FaucetLeaderboard[] | null>(null)
  let boardsRequestedForToken = $state<TokenSymbol | null>(null)

  $effect(() => {
    if (recipients.length === 0) return
    if (boardsRequestedForToken === token) return
    boardsRequestedForToken = token
    if (token === 'USDC') {
      for (const t of treasuries) {
        if (!t.cid || t.cid in treasuryBoards) continue
        getTreasuryLeaderboard(t.cid).then(b => {
          treasuryBoards = { ...treasuryBoards, [t.cid]: b }
        })
      }
    } else {
      if (faucetBoards === null) {
        getFaucetLeaderboards().then(b => {
          faucetBoards = b ?? []
        })
      }
    }
  })

  function faucetBoardFor(account: string): FaucetLeaderboard | null {
    if (!faucetBoards) return null
    return faucetBoards.find(b => b.recipient.account === account) ?? null
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
    <p class="intro-cta">
      <a href="https://encointer.org/our-communities/" target="_blank" rel="noopener">Get to know our communities ↗</a>
    </p>
  </section>

  {#if recipientsLoading && !isRecipientsLoaded()}
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
      <h2>Donation Rails</h2>

      <div class="form-row">
        <span class="form-label">Asset</span>
        <div class="token-tabs">
          <button class="tab" class:active={token === 'KSM'} onclick={() => token = 'KSM'} type="button">KSM → faucets</button>
          <button class="tab" class:active={token === 'USDC'} onclick={() => token = 'USDC'} type="button">USDC → treasuries</button>
        </div>
      </div>

      <div class="form-row source-row">
        <span class="form-label">from chain</span>
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
              {#if wallet.connected}
                <span class="chain-balance" class:placeholder={!bal}>
                  <span class="dim-text">your balance:</span>
                  {bal ? formatBalance(bal.transferable, cDecimals) : '—'} {token}
                </span>
              {/if}
              {#if c !== dest}
                <span class="badge">cross-chain</span>
              {/if}
            </button>
          {/each}
        </div>
      </div>

      {#if allBalancesZero}
        <div class="empty-balance-hint">
          You don't hold {token} on any supported chain.
          {#if token === 'KSM'}
            Acquire KSM on a major exchange — e.g.
            <a href="https://www.binance.com/en/trade/KSM_USDT" target="_blank" rel="noopener">Binance</a>,
            <a href="https://www.kraken.com/prices/kusama" target="_blank" rel="noopener">Kraken</a>, or
            <a href="https://www.mexc.com/exchange/KSM_USDT" target="_blank" rel="noopener">MEXC</a> —
            and withdraw to your address on <strong>Asset Hub Kusama</strong>.
          {:else}
            Withdraw USDC to your address on <strong>Asset Hub Polkadot</strong> from
            <a href="https://www.gate.io/" target="_blank" rel="noopener">Gate.io</a>,
            <a href="https://www.binance.com/" target="_blank" rel="noopener">Binance</a>,
            <a href="https://www.kucoin.com/" target="_blank" rel="noopener">KuCoin</a>, or
            <a href="https://www.mexc.com/" target="_blank" rel="noopener">MEXC</a>
            — these support USDC withdrawals on Polkadot Asset Hub.
          {/if}
        </div>
      {/if}
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

      {#if perRecipientAmounts && selectionCount() > 1}
        <div class="form-row sub recipient-breakdown">
          <span class="form-label"></span>
          <div class="breakdown-body">
            <div class="breakdown-header">
              <span>Distribution</span>
              {#if weightingActive}
                <span class="weighted-tag">weighted by activity</span>
                <button
                  type="button"
                  class="info-btn"
                  aria-label="How is the donation weighted?"
                  aria-expanded={showWeightingInfo}
                  onclick={() => showWeightingInfo = !showWeightingInfo}
                >ⓘ</button>
              {/if}
            </div>
            {#if weightingActive && showWeightingInfo}
              <div class="info-popover" role="dialog">
                <strong>Weighted by community activity & need</strong>
                <div class="formula"><code>weight = reputables × √(3m turnover USDC) ÷ √(treasury balance USDC)</code></div>
                <p>
                  <strong>Reputables</strong> — the regularly-active unique persons attested in the
                  community — set the community-size baseline.
                </p>
                <p>
                  <strong>√(turnover)</strong> rewards economic activity, with the square root damping
                  large differences (100× turnover → 10× boost).
                </p>
                <p>
                  <strong>÷√(treasury)</strong> shifts share toward under-funded treasuries: doubling
                  the existing pot roughly halves the new share.
                </p>
                <p class="dim-text">
                  Each share = total × (weight<sub>i</sub> ÷ Σ weights). Rounding residual goes to the first recipient.
                </p>
              </div>
            {/if}
            <ul class="breakdown-list">
              {#each selectedRecipients as r, i}
                <li>
                  <span class="r-name">{r.label}</span>
                  <span class="r-amount mono">{formatBalance(perRecipientAmounts[i], decimals)} {token}</span>
                </li>
              {/each}
            </ul>
          </div>
        </div>
      {/if}

      {#if !wallet.connected}
        <div class="info-banner">Connect your wallet to donate.</div>
      {/if}
      {#if insufficientBalance && availableBalance !== null}
        <div class="error-banner" role="alert">
          Insufficient balance — available {formatBalance(availableBalance, decimals)} {token} on {validSource ? CHAINS[validSource].name : ''} (excluding existential deposit).
        </div>
      {/if}
      {#if donationWarning}
        <div class="warning-banner" role="alert">⚠ {donationWarning}</div>
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
        <!--
          The simple "Estimated fee" line from `getEstimatedFees` only covers
          the dispatch fee — for cross-chain donations the real DOT/KSM cost
          (bridge delivery + XCM execution + dispatch) is several × higher.
          Show it only when the dry-run didn't produce a balance breakdown;
          otherwise the "Net effect" section below is the authoritative view.
        -->
        {#if !txState.dryRun?.balance}
          <div>
            <span class="dim-text">Estimated fee:</span> {formatBalance(txState.fee, txState.feeDecimals)} {txState.feeSymbol}
          </div>
        {/if}
        {#if txState.dryRun}
          <div class="dry-run-summary">
            <span class="dim-text">Pre-flight checks:</span>
            <ul>
              <li class:ok={txState.dryRun.sourceOk}>
                {txState.dryRun.sourceOk ? '✓' : '✗'} source ({source ? CHAINS[source].name : ''}): {txState.dryRun.sourceOk ? 'dispatch would succeed' : (txState.dryRun.sourceMessage ?? 'failed')}
              </li>
              {#each txState.dryRun.destinations as d}
                <li class:ok={d.ok}>
                  {d.ok ? '✓' : '✗'} destination ({CHAINS[d.destChain].name}): {d.ok ? 'XCM would execute Complete' : (d.errorMessage ?? 'failed')}
                </li>
              {/each}
            </ul>
          </div>
        {/if}
        {#if txState.dryRun?.balance}
          {@const bal = txState.dryRun.balance}
          {@const paidInAsset = txState.feeSymbol === 'USDC'}
          <!--
            `dry_run_call` doesn't run signed extensions, so the dispatch
            fee withdrawal isn't reflected in `sourceUsdcDelta` /
            `sourceNativeDelta`. Attribute it to the right side based on
            the fee strategy chosen by `decideFeeStrategy`.
          -->
          {@const dispatchFeeUsdc = paidInAsset ? txState.fee : 0n}
          {@const dispatchFeeNative = paidInAsset ? (txState.feeNative ?? 0n) : txState.fee}
          {@const usdcOutDryRun = bal.sourceUsdcDelta < 0n ? -bal.sourceUsdcDelta : 0n}
          {@const usdcOut = usdcOutDryRun + dispatchFeeUsdc}
          <!--
            Split the USDC outflow into three buckets so the breakdown isn't
            misleading:
              donationOut    — what the user actually meant to send,
              bridgeFunding  — USDC consumed by the prepended USDC→native
                               swap that funds bridge-delivery / XCM-
                               execution fees,
              dispatchFeeUsdc — the dispatch fee paid via
                               pallet-asset-conversion-tx-payment.
            When the user picked USDC-only on PAH/KAH, `usdcOutDryRun`
            captures (donation + swap-in), which is why naively labelling
            the whole thing as "donation" overstates the gift.
          -->
          {@const donationOut = totalAmount ?? 0n}
          {@const bridgeFunding = usdcOutDryRun > donationOut ? usdcOutDryRun - donationOut : 0n}
          {@const nativeDecimals = source === 'pah' ? 10 : 12}
          {@const nativeSymbol = source === 'pah' ? 'DOT' : 'KSM'}
          {@const adjustedNativeDelta = bal.sourceNativeDelta - dispatchFeeNative}
          {@const nativeAbs = adjustedNativeDelta < 0n ? -adjustedNativeDelta : adjustedNativeDelta}
          {@const nativeSign = adjustedNativeDelta < 0n ? '−' : '+'}
          {@const showNativeLine = adjustedNativeDelta !== 0n || (bal.sourceNativeFinal !== null && bal.sourceNativeFinal !== 0n)}
          <!-- Annotate the native delta when its meaning isn't the obvious
               "balance change" reading:
                 negative + non-native-token  → paid out as fees
                 positive + non-native-token  → leftover from the USDC→native
                                                swap topup the bridge didn't
                                                fully consume.
               Native-token transfers conflate transfer + fee in the delta;
               no qualifier is correct there. -->
          {@const nativeQualifier =
            token === nativeSymbol ? '' :
            adjustedNativeDelta < 0n ? ' (fees)' :
            adjustedNativeDelta > 0n ? ' (fee swap remainder)' : ''}
          {@const usdcParts = [
            donationOut > 0n ? `${formatBalance(donationOut, 6)} donation` : null,
            bridgeFunding > 0n ? `${formatBalance(bridgeFunding, 6)} swapped to ${nativeSymbol} for bridge` : null,
            dispatchFeeUsdc > 0n ? `${formatBalance(dispatchFeeUsdc, 6)} dispatch fee` : null,
          ].filter((p): p is string => p != null)}
          <div class="net-effect">
            <span class="dim-text">Net effect:</span>
            <ul>
              <li>
                <span class="dim-text">USDC charged from your account:</span>
                <span class="mono">{formatBalance(usdcOut, 6)} USDC</span>
                {#if usdcParts.length >= 2}
                  <span class="dim-text">({usdcParts.join(' + ')})</span>
                {/if}
              </li>
              {#if showNativeLine}
                <li>
                  <span class="dim-text">{nativeSymbol} change{nativeQualifier}:</span>
                  <span class="mono">{nativeSign}{formatBalance(nativeAbs, nativeDecimals)} {nativeSymbol}</span>
                </li>
              {/if}
              <li>
                <span class="dim-text">Recipients receive:</span>
                <ul class="recipient-receipts">
                  {#each bal.recipientReceipts as r}
                    <li>
                      <span>{r.label}</span>
                      <span class="mono">{formatBalance(r.received, 6)} USDC</span>
                    </li>
                  {/each}
                </ul>
              </li>
            </ul>
          </div>
        {/if}
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
        {#if txState.phase === 'awaiting-signature'}
          {#if txState.mode === 'batch'}
            Waiting for signature in wallet...
          {:else}
            Waiting for signature {txState.current + 1} of {txState.total} in wallet...
          {/if}
        {:else}
          {#if txState.mode === 'batch'}
            Waiting for block inclusion...
          {:else}
            Waiting for block inclusion ({txState.current + 1} of {txState.total})...
          {/if}
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

  {#if token === 'USDC'}
    {#each treasuries.filter(t => !!t.kahAccount) as t (t.cid)}
      {@const board = treasuryBoards[t.cid]}
      {#if board === undefined}
        <section class="card leaderboard-loading">
          <span class="spinner"></span>
          <span class="dim-text">Loading top supporters · {t.name}...</span>
        </section>
      {:else if board}
        <LeaderboardCard board={board} currentBalance={t.usdcBalance} title={t.name} />
      {/if}
    {/each}
  {:else}
    {#if faucetBoards === null && faucets.length > 0}
      <section class="card leaderboard-loading">
        <span class="spinner"></span>
        <span class="dim-text">Loading top supporters...</span>
      </section>
    {:else}
      {#each faucets as f (f.account)}
        {@const board = faucetBoardFor(f.account)}
        {#if board}
          <LeaderboardCard board={board} currentBalance={f.freeBalance} title={f.name ?? f.account} />
        {/if}
      {/each}
    {/if}
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
  .intro-cta {
    text-align: center;
    margin-top: 0.6rem !important;
    font-weight: 500;
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
  .source-card .chain-balance.placeholder {
    opacity: 0.55;
  }

  .source-card .badge {
    align-self: flex-start;
    margin-left: 0;
    margin-top: 0.15rem;
  }

  .empty-balance-hint {
    margin-top: 0.5rem;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-surface-hover);
    font-size: 0.8rem;
    line-height: 1.45;
    color: var(--color-text-dim);
  }
  .empty-balance-hint a {
    color: var(--color-accent);
    text-decoration: none;
  }
  .empty-balance-hint a:hover {
    text-decoration: underline;
  }
  .empty-balance-hint strong {
    color: var(--color-text);
  }

  .recipient-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .submit-btn { width: 100%; margin-top: 0.5rem; }

  .warning-banner {
    margin-top: 0.5rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--color-warning, #c98a00);
    border-radius: var(--radius);
    background: rgba(220, 160, 0, 0.10);
    color: var(--color-warning, #c98a00);
    font-size: 0.8rem;
    line-height: 1.4;
  }

  .error-banner {
    margin-top: 0.5rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--color-danger, #b13030);
    border-radius: var(--radius);
    background: rgba(220, 50, 50, 0.10);
    color: var(--color-danger, #b13030);
    font-size: 0.8rem;
    line-height: 1.4;
  }

  .info-banner {
    margin-top: 0.5rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-surface-hover);
    color: var(--color-text-dim);
    font-size: 0.8rem;
    line-height: 1.4;
    text-align: center;
  }

  .recipient-breakdown {
    align-items: stretch;
  }
  .breakdown-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .breakdown-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: var(--color-text-dim);
  }
  .weighted-tag {
    font-size: 0.7rem;
    padding: 0.05rem 0.4rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-text-dim);
  }
  .info-btn {
    width: 1.1rem;
    height: 1.1rem;
    padding: 0;
    border: 1px solid var(--color-border);
    border-radius: 50%;
    background: transparent;
    color: var(--color-text-dim);
    font-size: 0.7rem;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .info-btn:hover {
    color: var(--color-accent);
    border-color: var(--color-accent);
  }
  .info-popover {
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-surface-hover);
    font-size: 0.78rem;
    line-height: 1.45;
  }
  .info-popover strong { display: block; margin-bottom: 0.2rem; }
  .info-popover .formula {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    margin: 0.2rem 0 0.35rem;
    color: var(--color-text);
  }
  .info-popover p {
    margin: 0.25rem 0;
    color: var(--color-text-dim);
  }
  .breakdown-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-size: 0.82rem;
  }
  .breakdown-list li {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .breakdown-list .r-name {
    color: var(--color-text);
  }
  .breakdown-list .r-amount {
    color: var(--color-text-dim);
  }
  .mono { font-family: var(--font-mono); }

  .summary {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0.5rem 0 1rem;
    font-size: 0.9rem;
  }

  .dry-run-summary,
  .net-effect {
    margin-top: 0.4rem;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-surface-hover);
    font-size: 0.8rem;
  }
  .dry-run-summary ul,
  .net-effect ul {
    list-style: none;
    padding: 0.3rem 0 0 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .dry-run-summary li {
    color: var(--color-danger, #b13030);
  }
  .dry-run-summary li.ok {
    color: var(--color-success, #058257);
  }
  .net-effect li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: baseline;
  }
  .net-effect .recipient-receipts {
    width: 100%;
    padding-left: 0.8rem;
    margin: 0.1rem 0 0;
  }
  .net-effect .recipient-receipts li {
    justify-content: space-between;
  }
  .mono { font-family: var(--font-mono); }

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

  .leaderboard-loading {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.6rem;
    padding: 0.75rem 1rem;
    font-size: 0.88rem;
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
