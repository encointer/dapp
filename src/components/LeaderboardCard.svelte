<script lang="ts">
  import { formatBalance, truncateAddress } from '../lib/format'
  import { lookupIdentity } from '../lib/identity.svelte'
  import type { TreasuryLeaderboard, FaucetLeaderboard } from '../lib/accountingApi'

  type Props = {
    /** Pre-fetched leaderboard (treasury or faucet) */
    board: TreasuryLeaderboard | FaucetLeaderboard
    /** Current on-chain balance of the pot, queried by the parent via paraspell.
     *  `null` while loading. */
    currentBalance: bigint | null
    /** Display title (e.g. "Nyota Treasury", "PioneerPot") */
    title: string
  }
  let { board, currentBalance, title }: Props = $props()

  const decimals = $derived(board.decimals)
  const token = $derived(board.token)
  const inflowsTotal = $derived(BigInt(board.totalInflowsRaw))

  // Lazy identity lookups — keyed by ss58, populated as Promise.allSettled resolves
  let identities = $state<Record<string, string | null>>({})

  $effect(() => {
    const seen = new Set<string>()
    for (const d of board.donors) {
      if (seen.has(d.ss58) || d.ss58 in identities) continue
      seen.add(d.ss58)
      lookupIdentity(d.ss58).then(name => {
        identities = { ...identities, [d.ss58]: name }
      })
    }
  })

  function fmt(raw: string | bigint): string {
    const v = typeof raw === 'bigint' ? raw : BigInt(raw)
    return formatBalance(v, decimals)
  }
</script>

<section class="card leaderboard-card">
  <h3>Top supporters · {title}</h3>
  <p class="summary">
    <span>Donations received: <strong>{fmt(inflowsTotal)} {token}</strong></span>
    {#if currentBalance !== null}
      <span class="sep">·</span>
      <span>Current balance: <strong>{fmt(currentBalance)} {token}</strong></span>
    {/if}
  </p>

  {#if board.donors.length === 0 && board.crossChainAnonymous.length === 0}
    <p class="dim-text empty">No donations yet — be the first to support this {token === 'USDC' ? 'treasury' : 'faucet'}.</p>
  {:else}
    <ol class="donor-list">
      {#each board.donors as d, i}
        {@const identity = identities[d.ss58]}
        <li>
          <span class="rank">{i + 1}.</span>
          <span class="donor">
            <span class="addr" title={d.ss58}>{truncateAddress(d.ss58)}</span>
            {#if identity}
              <span class="identity">{identity}</span>
            {/if}
          </span>
          <span class="count">{d.count}×</span>
          <span class="amount">{fmt(d.totalRaw)} {token}</span>
        </li>
      {/each}
      {#if board.crossChainAnonymous.length > 0}
        {@const anonCount = board.crossChainAnonymous.length}
        {@const anonTotal = board.crossChainAnonymous.reduce((s, a) => s + BigInt(a.amountRaw), 0n)}
        <li class="anonymous">
          <span class="rank">—</span>
          <span class="donor"><span class="identity">Anonymous (via XCM)</span></span>
          <span class="count">{anonCount}×</span>
          <span class="amount">{fmt(anonTotal)} {token}</span>
        </li>
      {/if}
    </ol>
  {/if}
</section>

<style>
  .leaderboard-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  h3 {
    font-size: 0.95rem;
    font-weight: 600;
    margin: 0;
  }
  .summary {
    margin: 0;
    font-size: 0.85rem;
    color: var(--color-text-dim);
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .summary strong {
    color: var(--color-text);
    font-weight: 600;
  }
  .summary .sep {
    color: var(--color-text-dim);
  }
  .empty {
    margin: 0.25rem 0;
    font-size: 0.85rem;
  }
  .donor-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .donor-list li {
    display: grid;
    grid-template-columns: 1.5rem 1fr auto auto;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.88rem;
    padding: 0.15rem 0;
  }
  .rank {
    color: var(--color-text-dim);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .donor {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: baseline;
    min-width: 0;
  }
  .addr {
    font-family: var(--font-mono, ui-monospace, monospace);
    color: var(--color-text);
  }
  .identity {
    color: var(--color-text-dim);
    font-style: italic;
  }
  .count {
    color: var(--color-text-dim);
    font-variant-numeric: tabular-nums;
  }
  .amount {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
  }
  .anonymous .donor {
    color: var(--color-text-dim);
  }
</style>
