/// <reference types="vite/client" />
import { AccountId, createClient, type PolkadotClient } from 'polkadot-api'
import { getWsProvider } from 'polkadot-api/ws'

const PEOPLE_KSM_RPC = 'wss://kusama-people-rpc.polkadot.io'
const PEOPLE_DOT_RPC = 'wss://polkadot-people-rpc.polkadot.io'

// Identity registries are keyed by public key, not by ss58 prefix. The same
// donor can have identity registered on either people-chain regardless of how
// the address is encoded, so we query both and take whichever returns a name.
let ksmClient: PolkadotClient | null = null
let dotClient: PolkadotClient | null = null

function getKsmClient(): PolkadotClient {
  if (!ksmClient) ksmClient = createClient(getWsProvider(PEOPLE_KSM_RPC))
  return ksmClient
}
function getDotClient(): PolkadotClient {
  if (!dotClient) dotClient = createClient(getWsProvider(PEOPLE_DOT_RPC))
  return dotClient
}

const ksmCodec = AccountId(2)
const dotCodec = AccountId(0)

/** Re-encode an arbitrary ss58 to the target chain's expected prefix. Returns
 *  null on decode failure (malformed input). polkadot-api's AccountId codec
 *  encodes ss58→bytes and decodes bytes→ss58 (the codec carries the prefix). */
function reEncode(ss58: string, codec: typeof ksmCodec): string | null {
  try {
    const pubkey = ksmCodec.enc(ss58)
    return codec.dec(pubkey)
  } catch {
    try {
      const pubkey = dotCodec.enc(ss58)
      return codec.dec(pubkey)
    } catch {
      return null
    }
  }
}

const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

interface DataLike { type?: string; value?: unknown }

function hexToBytes(hex: string): Uint8Array | null {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
  if (h.length === 0 || h.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(h)) return null
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Decode an Identity `Data` enum to a display string. polkadot-api may surface
 *  the `value` field as a hex string (`"0x6272656e7a69"`), a `Binary` object
 *  (with `asText/asBytes/asHex`), or a `Uint8Array`. Empty (`None`) and hash
 *  variants (`BlakeTwo256` etc.) return `null`. */
function dataToString(d: unknown): string | null {
  if (!d || typeof d !== 'object') return null
  const dd = d as DataLike
  const t = typeof dd.type === 'string' ? dd.type : ''
  if (!t.startsWith('Raw')) return null
  const v = dd.value
  if (v == null) return null
  if (typeof v === 'string') {
    const bytes = hexToBytes(v)
    if (!bytes) return null
    try { return new TextDecoder().decode(bytes) } catch { return null }
  }
  if (v instanceof Uint8Array) {
    try { return new TextDecoder().decode(v) } catch { return null }
  }
  const obj = v as { asText?: () => string; asBytes?: () => Uint8Array }
  if (typeof obj.asText === 'function') {
    try { return obj.asText() } catch { /* fall through */ }
  }
  if (typeof obj.asBytes === 'function') {
    try { return new TextDecoder().decode(obj.asBytes()) } catch { return null }
  }
  return null
}

interface IdentityApi {
  query: {
    Identity: {
      IdentityOf: { getValue: (a: string) => Promise<unknown> }
      SuperOf: { getValue: (a: string) => Promise<unknown> }
    }
  }
}

async function readDisplay(api: IdentityApi, ss58: string): Promise<string | null> {
  const raw = await api.query.Identity.IdentityOf.getValue(ss58)
  if (!raw) return null
  // Newer pallets return Option<(Registration, Option<Username>)>; older
  // return Option<Registration>.
  const reg = Array.isArray(raw) ? raw[0] : raw
  const info = (reg as { info?: { display?: unknown } })?.info
  return dataToString(info?.display)
}

async function queryOne(client: PolkadotClient, ss58: string): Promise<string | null> {
  try {
    const api = client.getUnsafeApi() as unknown as IdentityApi
    const direct = await readDisplay(api, ss58)
    if (direct) return direct

    // Fall back to sub-identity lookup. SuperOf returns Option<(parent, sub-name)>;
    // polkadot-api decodes the tuple as [parentSs58, Data].
    const sup = await api.query.Identity.SuperOf.getValue(ss58)
    if (!sup) return null
    const tuple = sup as [string, unknown] | { parent?: string; name?: unknown } | undefined
    let parent: string | undefined
    let subData: unknown
    if (Array.isArray(tuple)) {
      [parent, subData] = tuple
    } else if (tuple && typeof tuple === 'object') {
      parent = tuple.parent
      subData = tuple.name
    }
    if (!parent) return null
    const subName = dataToString(subData)
    const superDisplay = await readDisplay(api, parent)
    if (!superDisplay) return subName // sub with no super display — fall back to just the sub name
    return subName ? `${superDisplay}/${subName}` : superDisplay
  } catch (err) {
    console.warn('[identity] query failed for', ss58, err)
    return null
  }
}

async function doLookup(ss58: string): Promise<string | null> {
  // Query both people-chains in parallel with the address re-encoded to each
  // chain's expected prefix. Prefer the result matching the input's ecosystem
  // (heuristic: Polkadot ss58 starts with '1'), so for addresses that have
  // identities on both chains we surface the "home" one.
  const ksmAddr = reEncode(ss58, ksmCodec)
  const dotAddr = reEncode(ss58, dotCodec)
  if (!ksmAddr && !dotAddr) return null

  const [ksmRes, dotRes] = await Promise.all([
    ksmAddr ? queryOne(getKsmClient(), ksmAddr) : Promise.resolve(null),
    dotAddr ? queryOne(getDotClient(), dotAddr) : Promise.resolve(null),
  ])

  const polkadotFirst = ss58.startsWith('1')
  return polkadotFirst ? (dotRes ?? ksmRes) : (ksmRes ?? dotRes)
}

/** Cache key: canonical Kusama-prefix ss58 (or original on decode failure).
 *  Ensures the same public key, however the caller encodes it, shares a cache
 *  entry and an in-flight request. */
function canonicalKey(ss58: string): string {
  return reEncode(ss58, ksmCodec) ?? ss58
}

export async function lookupIdentity(ss58: string): Promise<string | null> {
  const key = canonicalKey(ss58)
  if (cache.has(key)) return cache.get(key) ?? null
  const existing = inflight.get(key)
  if (existing) return existing
  const p = doLookup(ss58).then((res) => {
    cache.set(key, res)
    inflight.delete(key)
    return res
  })
  inflight.set(key, p)
  return p
}
