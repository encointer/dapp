<script lang="ts">
  import { formatBalance, truncateAddress } from '../lib/format'
  import { lookupIdentity } from '../lib/identity.svelte'
  import type { AggregateLeaderboard } from '../lib/accountingApi'

  type Props = {
    board: AggregateLeaderboard
    /** Sum of current on-chain balances across all recipients, queried by the
     *  parent. `null` while loading; `undefined` to omit the balance line. */
    currentBalance?: bigint | null
    title: string
  }
  let { board, currentBalance, title }: Props = $props()

  const decimals = $derived(board.decimals)
  const token = $derived(board.token)
  const inflowsTotal = $derived(BigInt(board.totalInflowsRaw))

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

  let copiedAddr = $state<string | null>(null)
  let copyTimeout: ReturnType<typeof setTimeout> | null = null

  async function copyAddr(addr: string) {
    try {
      await navigator.clipboard.writeText(addr)
      copiedAddr = addr
      if (copyTimeout) clearTimeout(copyTimeout)
      copyTimeout = setTimeout(() => { copiedAddr = null }, 1500)
    } catch (err) {
      console.warn('[leaderboard-card] clipboard write failed', err)
    }
  }
</script>

<section class="card leaderboard-card">
  <h3>{title}</h3>
  <p class="summary">
    <span>Total donations received: <strong>{fmt(inflowsTotal)} {token}</strong></span>
    {#if currentBalance !== undefined && currentBalance !== null}
      <span class="sep">·</span>
      <span>Current balance: <strong>{fmt(currentBalance)} {token}</strong></span>
    {/if}
  </p>

  {#if board.donors.length === 0 && board.crossChainUnidentified.length === 0}
    <p class="dim-text empty">No donations yet — be the first to support this {token === 'USDC' ? 'ecosystem' : 'faucet'}.</p>
  {:else}
    <ol class="donor-list">
      {#each board.donors as d, i}
        {@const identity = identities[d.ss58]}
        <li>
          <span class="rank">{i + 1}.</span>
          <span class="donor">
            <button
              type="button"
              class="addr"
              class:as-identity={!!identity}
              title={copiedAddr === d.ss58 ? 'Copied!' : `Copy ${d.ss58}`}
              aria-label={`Copy address ${d.ss58}`}
              onclick={() => copyAddr(d.ss58)}
            >{copiedAddr === d.ss58 ? 'copied' : (identity ?? truncateAddress(d.ss58))}</button>
            <span class="count">· {d.count} {d.count === 1 ? 'donation' : 'donations'}</span>
          </span>
          <span class="amount">{fmt(d.totalRaw)} {token}</span>
        </li>
      {/each}
      {#if board.crossChainUnidentified.length > 0}
        {@const anonCount = board.crossChainUnidentified.length}
        {@const anonTotal = board.crossChainUnidentified.reduce((s, a) => s + BigInt(a.amountRaw), 0n)}
        <li class="unidentified">
          <span class="rank">—</span>
          <span class="donor">
            <span class="identity">Unidentified (via XCM)</span>
            <span class="count">· {anonCount} {anonCount === 1 ? 'donation' : 'donations'}</span>
          </span>
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
    grid-template-columns: 1.5rem 1fr auto;
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
    background: none;
    border: none;
    padding: 0;
    font-size: inherit;
    cursor: pointer;
    text-decoration: underline dotted;
    text-underline-offset: 2px;
    text-decoration-color: var(--color-text-dim);
  }
  .addr.as-identity {
    font-family: inherit;
    color: var(--color-text);
    font-weight: 700;
  }
  .addr:hover {
    text-decoration-style: solid;
    text-decoration-color: var(--color-accent);
  }
  .addr:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: 2px;
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
  .unidentified .donor {
    color: var(--color-text-dim);
  }
</style>
