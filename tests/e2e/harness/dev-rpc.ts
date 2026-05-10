import { WebSocket } from 'ws'

/** Tiny raw-JSON-RPC client for chopsticks's dev_* methods. PAPI's high-level
 *  client doesn't expose these; we just open a raw WebSocket. */
export class DevRpc {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  private ready: Promise<void>

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.once('error', (err: Error) => reject(err))
    })
    this.ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as { id?: number; result?: unknown; error?: { message: string } }
        if (msg.id == null) return
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message))
        else p.resolve(msg.result)
      } catch (err) {
        console.warn('[dev-rpc] failed to parse message:', err)
      }
    })
  }

  async call<T = unknown>(method: string, params: unknown[]): Promise<T> {
    await this.ready
    const id = this.nextId++
    // chopsticks's `dev_setStorage` structured form takes u128 balances as
    // decimal strings; encode bigints accordingly.
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    )
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject })
      this.ws.send(payload, (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  close() {
    this.ws.close()
  }
}

/** Apply a high-level state mutation via chopsticks `dev_setStorage`. The
 *  state object follows chopsticks's structured form: top-level keys are
 *  pallet names, leaves are `[keyArgs, value]` tuples decoded according to
 *  the chain's metadata. Chopsticks creates a new block after applying. */
export async function setStorage(rpc: DevRpc, state: Record<string, unknown>): Promise<void> {
  await rpc.call('dev_setStorage', [state])
}

/** Force a new block to be produced. Chopsticks's manual mode stays at the
 *  forked block until told to advance; tests need this to make submitted txs
 *  finalize. */
export async function newBlock(rpc: DevRpc, count = 1): Promise<void> {
  await rpc.call('dev_newBlock', [{ count }])
}
