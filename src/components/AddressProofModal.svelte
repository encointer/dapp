<script lang="ts">
  import {
    deriveFaucetAccount,
    deriveEncointerTreasury,
    deriveKahFromTreasury,
    snippetForFaucet,
    snippetForEncointerTreasury,
    snippetForKahTreasury,
  } from '../lib/keylessProof'

  type Props =
    | { kind: 'faucet'; name: string; expectedAddress: string; onClose: () => void }
    | { kind: 'encointer-treasury'; cid: string; expectedAddress: string; onClose: () => void }
    | { kind: 'kah-treasury'; cid: string; expectedAddress: string; onClose: () => void }
  let props: Props = $props()

  const title = $derived(
    props.kind === 'faucet'
      ? 'Faucet account derivation'
      : props.kind === 'encointer-treasury'
        ? 'Encointer treasury derivation'
        : 'KAH sibling sub-account derivation',
  )

  const snippet = $derived(
    props.kind === 'faucet'
      ? snippetForFaucet(props.name)
      : props.kind === 'encointer-treasury'
        ? snippetForEncointerTreasury(props.cid)
        : snippetForKahTreasury(props.cid),
  )

  let computedAddress = $state<string | null>(null)
  let runError = $state<string | null>(null)

  function runInline() {
    runError = null
    try {
      let computed: string
      if (props.kind === 'faucet') {
        computed = deriveFaucetAccount(props.name).ss58
      } else if (props.kind === 'encointer-treasury') {
        computed = deriveEncointerTreasury(props.cid).ss58
      } else {
        const treasury = deriveEncointerTreasury(props.cid)
        computed = deriveKahFromTreasury(treasury.bytes).ss58
      }
      computedAddress = computed
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err)
    }
  }

  async function copySnippet() {
    try { await navigator.clipboard.writeText(snippet) } catch { /* ignore */ }
  }

  function onBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) props.onClose()
  }

  const matches = $derived(computedAddress !== null && computedAddress === props.expectedAddress)
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal-backdrop" role="presentation" onclick={onBackdrop}>
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="proof-title">
    <button class="close" onclick={props.onClose} type="button" aria-label="Close">×</button>
    <h3 id="proof-title">{title}</h3>

    <p class="lead">
      This address has <strong>no private key</strong>. It is deterministically computed from public
      inputs (community identifier{props.kind === 'faucet' ? ' / faucet name' : ''}{props.kind === 'kah-treasury' ? ' + parachain id' : ''}).
      Anyone can reproduce it from the snippet below.
    </p>

    <div class="meta">
      <span class="dim-text">Expected:</span>
      <code class="addr">{props.expectedAddress}</code>
    </div>

    <pre class="snippet"><code>{snippet}</code></pre>

    <div class="actions">
      <button class="btn btn-ghost" onclick={copySnippet} type="button">Copy snippet</button>
      <button class="btn btn-primary" onclick={runInline} type="button">Verify here</button>
    </div>

    {#if runError}
      <p class="error-text">{runError}</p>
    {:else if computedAddress !== null}
      <div class="result" class:ok={matches} class:bad={!matches}>
        {#if matches}
          ✓ Computed <code class="addr">{computedAddress}</code> — matches the displayed address.
        {:else}
          ✗ Computed <code class="addr">{computedAddress}</code> — does NOT match.
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex; align-items: center; justify-content: center;
    z-index: 100;
    padding: 1rem;
  }
  .modal-card {
    position: relative;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 1.25rem 1.25rem 1rem;
    width: 100%;
    max-width: 720px;
    max-height: 90vh;
    overflow-y: auto;
    display: flex; flex-direction: column; gap: 0.75rem;
  }
  .close {
    position: absolute; top: 0.4rem; right: 0.5rem;
    width: 1.8rem; height: 1.8rem;
    background: transparent; border: none;
    font-size: 1.4rem; line-height: 1;
    color: var(--color-text-dim);
    cursor: pointer;
  }
  .close:hover { color: var(--color-text); }

  h3 { font-size: 1.05rem; font-weight: 600; margin: 0 1.5rem 0 0; }

  .lead { font-size: 0.85rem; color: var(--color-text-dim); margin: 0; }

  .meta {
    display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline;
    font-size: 0.8rem;
  }
  .addr {
    font-family: var(--font-mono);
    word-break: break-all;
    font-size: 0.78rem;
    color: var(--color-text);
  }

  .snippet {
    background: var(--color-surface-hover);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 0.75rem;
    font-size: 0.72rem;
    line-height: 1.45;
    overflow-x: auto;
    margin: 0;
  }
  .snippet code { font-family: var(--font-mono); white-space: pre; }

  .actions { display: flex; gap: 0.5rem; }
  .actions .btn { flex: 0 0 auto; }

  .result {
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius);
    font-size: 0.85rem;
    word-break: break-all;
  }
  .result.ok { background: rgba(0, 180, 80, 0.12); color: var(--color-success, #058257); }
  .result.bad { background: rgba(220, 50, 50, 0.12); color: var(--color-danger, #b13030); }
</style>
