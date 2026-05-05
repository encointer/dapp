import { AccountId } from 'polkadot-api'
import { blake2b256 } from '@paraspell/sdk'

/**
 * Reproduce the on-chain account derivations for technical (key-less) accounts:
 *  - Encointer faucet account
 *  - Encointer community treasury account
 *  - Asset Hub Kusama sibling sub-account of an encointer treasury (the "kahAccount")
 *
 * These derivations are deterministic from public inputs (community identifier,
 * faucet name, parachain id). No private key exists. This module both provides
 * inline JS implementations the dapp can run for verification, AND emits the
 * source of an equivalent self-contained snippet that the user can run in any
 * browser DevTools console (depending only on the @noble/hashes CDN).
 */

const KSM_PREFIX = 2 // Kusama / KAH / encointer-kusama
const ENCOINTER_PARA_ID = 1001
const TREASURY_PALLET_ID = 'trsrysId'
const FAUCET_PALLET_ID = 'ectrfct0'

const ksmSs58 = AccountId(KSM_PREFIX)

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function decodeBase58(s: string): Uint8Array {
  let n = 0n
  for (const c of s) {
    const i = BASE58_ALPHABET.indexOf(c)
    if (i < 0) throw new Error(`invalid base58 char: ${c}`)
    n = n * 58n + BigInt(i)
  }
  const bytes: number[] = []
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn))
    n >>= 8n
  }
  let zeros = 0
  for (const c of s) { if (c === '1') zeros++; else break }
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes])
}

function parseCid(cidStr: string): { geohash: Uint8Array; digest: Uint8Array } {
  if (cidStr.length < 6) throw new Error(`bad cid: ${cidStr}`)
  const geohash = new TextEncoder().encode(cidStr.slice(0, 5))
  const digest = decodeBase58(cidStr.slice(5))
  if (digest.length !== 4) throw new Error(`expected 4-byte digest, got ${digest.length}`)
  return { geohash, digest }
}

function compactScale(n: number): Uint8Array {
  if (n < 64) return new Uint8Array([n << 2])
  if (n < 16384) return new Uint8Array([(n << 2) | 0b01, n >> 6])
  if (n < 1073741824) return new Uint8Array([(n << 2) | 0b10, n >> 6, n >> 14, n >> 22])
  throw new Error('compact: number too large for this helper')
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

// ──────────────────────────────────────────────────────────────────────────────
// Derivations (used by the dapp's local "verify" button)

export function deriveEncointerTreasury(cidStr: string): { ss58: string; bytes: Uint8Array } {
  const palletId = new TextEncoder().encode(TREASURY_PALLET_ID) // 8 bytes
  const { geohash, digest } = parseCid(cidStr)
  // The Rust pallet builds a Vec<u8> identifier and then hashes it with
  // T::Hashing::hash_of(&id), which goes through Encode::using_encoded — so
  // the bytes hashed are the SCALE encoding of the Vec<u8>: compact(len) ++ bytes.
  const optSome = new Uint8Array([0x01, ...geohash, ...digest])  // SCALE Option::Some(cid) — 10 bytes
  const ident = concat(palletId, optSome)                         // 18 bytes
  const preimage = concat(compactScale(ident.length), ident)
  const hash = blake2b256(preimage)
  return { ss58: ksmSs58.dec(hash), bytes: hash }
}

export function deriveFaucetAccount(name: string): { ss58: string; bytes: Uint8Array } {
  const palletId = new TextEncoder().encode(FAUCET_PALLET_ID) // 8 bytes
  const nameBytes = new TextEncoder().encode(name)            // raw UTF-8
  // Same Encode-then-hash pattern as the treasury derivation (see comment above).
  const ident = concat(palletId, nameBytes)
  const preimage = concat(compactScale(ident.length), ident)
  const hash = blake2b256(preimage)
  return { ss58: ksmSs58.dec(hash), bytes: hash }
}

export function deriveKahFromTreasury(treasuryBytes: Uint8Array, paraId: number = ENCOINTER_PARA_ID): { ss58: string; bytes: Uint8Array } {
  // xcm-builder HashedDescription<AccountId, DescribeFamily<DescribeAllTerminal>> for
  // Location { parents: 1, interior: X2[Parachain(paraId), AccountId32{network: None, id}] }:
  //
  // Outer pre-image = SCALE-encode: ([12 bytes "SiblingChain"], Compact(paraId), inner: Vec<u8>)
  // where inner is itself SCALE-encoded: ([11 bytes "AccountId32"], id: [u8; 32])
  // Note: byte-string literals like b"SiblingChain" encode as fixed-size [u8; N] (no length prefix).
  // Vec<u8> values inside a tuple ARE compact-prefixed.
  const accIdTag = new TextEncoder().encode('AccountId32') // 11 bytes
  const inner = concat(accIdTag, treasuryBytes)            // 11 + 32 = 43 bytes
  const sibling = new TextEncoder().encode('SiblingChain') // 12 bytes
  const preimage = concat(
    sibling,
    compactScale(paraId),
    compactScale(inner.length),
    inner,
  )
  const hash = blake2b256(preimage)
  return { ss58: ksmSs58.dec(hash), bytes: hash }
}

// ──────────────────────────────────────────────────────────────────────────────
// Self-contained snippets the user can paste into any browser console.

const SNIPPET_PRELUDE = `// Auditable proof: this address has no private key.
// It is deterministically derived from public inputs.
// Run in any browser DevTools (uses only @noble/hashes from the CDN).
(async () => {
  const { blake2b } = await import('https://esm.sh/@noble/hashes/blake2b');
  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58dec = s => {
    let n = 0n; for (const c of s) n = n * 58n + BigInt(ALPHA.indexOf(c));
    const out = []; while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
    let z = 0; for (const c of s) { if (c === '1') z++; else break; }
    return new Uint8Array([...Array(z).fill(0), ...out]);
  };
  const b58enc = b => {
    let n = 0n; for (const x of b) n = n * 256n + BigInt(x);
    let s = ''; while (n > 0n) { s = ALPHA[Number(n % 58n)] + s; n /= 58n; }
    let z = 0; for (const x of b) { if (x === 0) z++; else break; }
    return '1'.repeat(z) + s;
  };
  const ss58 = (bytes, prefix) => {
    const pfx = prefix < 64
      ? new Uint8Array([prefix])
      : new Uint8Array([((prefix & 0xfc) >> 2) | 0x40, (prefix >> 8) | ((prefix & 0x03) << 6)]);
    const data = new Uint8Array([...pfx, ...bytes]);
    const ctx = new TextEncoder().encode('SS58PRE');
    const h = blake2b.create({ dkLen: 64 }).update(ctx).update(data).digest();
    return b58enc(new Uint8Array([...pfx, ...bytes, h[0], h[1]]));
  };
  const compact = n => {
    if (n < 64) return new Uint8Array([n << 2]);
    if (n < 16384) return new Uint8Array([(n << 2) | 1, n >> 6]);
    return new Uint8Array([(n << 2) | 2, n >> 6, n >> 14, n >> 22]);
  };
  const cat = (...xs) => {
    const t = xs.reduce((s, x) => s + x.length, 0);
    const o = new Uint8Array(t); let p = 0;
    for (const x of xs) { o.set(x, p); p += x.length; }
    return o;
  };`

const SNIPPET_EPILOGUE = `})();`

export function snippetForFaucet(name: string): string {
  return `${SNIPPET_PRELUDE}

  // ── Encointer faucet account derivation ─────────────────────────────
  // pallet-encointer-faucet :: create_faucet builds a Vec<u8> identifier
  // ( PalletId(8B "ectrfct0") || raw_utf8(name) ), then hashes it via
  // T::Hashing::hash_of(&id) which SCALE-encodes the Vec<u8> first:
  //   account = blake2_256( compact(id.len) || id )
  const palletId  = new TextEncoder().encode('${FAUCET_PALLET_ID}');     // 8 bytes
  const nameBytes = new TextEncoder().encode(${JSON.stringify(name)});   // raw UTF-8
  const ident     = cat(palletId, nameBytes);
  const preimage  = cat(compact(ident.length), ident);
  const hash = blake2b(preimage, { dkLen: 32 });
  const addr = ss58(hash, ${KSM_PREFIX});
  console.log('faucet account:', addr);
${SNIPPET_EPILOGUE}`
}

export function snippetForEncointerTreasury(cidStr: string): string {
  const { geohash } = parseCid(cidStr)
  const geohashStr = new TextDecoder().decode(geohash)
  const digestB58 = cidStr.slice(5)
  return `${SNIPPET_PRELUDE}

  // ── Encointer community treasury account derivation ─────────────────
  // pallet-encointer-treasuries :: get_community_treasury_account_unchecked(Some(cid))
  // builds a Vec<u8> identifier and hashes via T::Hashing::hash_of(&id) which
  // SCALE-encodes the Vec<u8> first:
  //   ident   = PalletId(8B "trsrysId") || SCALE(Option::Some(cid))
  //   account = blake2_256( compact(ident.len) || ident )
  // (SCALE Option::Some prefix = 0x01; CommunityIdentifier = geohash[5] || digest[4])
  const palletId  = new TextEncoder().encode('${TREASURY_PALLET_ID}'); // 8 bytes
  const geohash   = new TextEncoder().encode(${JSON.stringify(geohashStr)}); // 5 bytes
  const digestB58 = ${JSON.stringify(digestB58)};
  const digest    = b58dec(digestB58); // 4 bytes
  const someCid   = new Uint8Array([0x01, ...geohash, ...digest]); // 10 bytes
  const ident     = cat(palletId, someCid); // 18 bytes
  const preimage  = cat(compact(ident.length), ident);
  const hash = blake2b(preimage, { dkLen: 32 });
  const addr = ss58(hash, ${KSM_PREFIX});
  console.log('encointer treasury account:', addr);
${SNIPPET_EPILOGUE}`
}

export function snippetForKahTreasury(cidStr: string, paraId: number = ENCOINTER_PARA_ID): string {
  const { geohash } = parseCid(cidStr)
  const geohashStr = new TextDecoder().decode(geohash)
  const digestB58 = cidStr.slice(5)
  return `${SNIPPET_PRELUDE}

  // ── Asset Hub Kusama sibling sub-account of an encointer treasury ────
  // Step 1 — derive the encointer treasury account.
  // pallet-encointer-treasuries hashes via T::Hashing::hash_of(&id) (Encode-then-hash):
  //   ident1   = PalletId(8B "trsrysId") || SCALE(Option::Some(cid))
  //   treasury = blake2_256( compact(ident1.len) || ident1 )
  const palletId  = new TextEncoder().encode('${TREASURY_PALLET_ID}');
  const geohash   = new TextEncoder().encode(${JSON.stringify(geohashStr)});
  const digestB58 = ${JSON.stringify(digestB58)};
  const digest    = b58dec(digestB58);
  const someCid   = new Uint8Array([0x01, ...geohash, ...digest]);
  const ident1    = cat(palletId, someCid);
  const treasury  = blake2b(cat(compact(ident1.length), ident1), { dkLen: 32 });
  console.log('encointer treasury account:', ss58(treasury, ${KSM_PREFIX}));

  // Step 2 — derive its sibling sub-account on Asset Hub Kusama.
  // xcm-builder: HashedDescription<AccountId, DescribeFamily<DescribeAllTerminal>>
  // for Location { parents: 1, interior: X2[Parachain(${paraId}), AccountId32{None, treasury}] }
  //   inner = "AccountId32"(11B raw) || treasury(32B)
  //   pre2  = "SiblingChain"(12B raw) || Compact(${paraId}) || Compact(inner.len) || inner
  //   kahAccount = blake2_256(pre2)
  const sibling = new TextEncoder().encode('SiblingChain');   // 12 bytes
  const accIdTag = new TextEncoder().encode('AccountId32');   // 11 bytes
  const inner = cat(accIdTag, treasury);                       // 11 + 32 = 43 bytes
  const pre2 = cat(sibling, compact(${paraId}), compact(inner.length), inner);
  const kah = blake2b(pre2, { dkLen: 32 });
  console.log('asset hub kusama sub-account:', ss58(kah, ${KSM_PREFIX}));
${SNIPPET_EPILOGUE}`
}
