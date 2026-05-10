import { sr25519CreateDerive } from '@polkadot-labs/hdkd'
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from '@polkadot-labs/hdkd-helpers'
import { getPolkadotSigner } from 'polkadot-api/signer'
import type { PolkadotSigner } from 'polkadot-api'

/** Standard substrate dev mnemonic and well-known derivation paths
 *  (//Alice, //Bob, ...). The same accounts that node-dev's `--alice`/`--bob`
 *  keys produce, so chopsticks's pre-funded dev accounts work out-of-the-box. */
export type DevAccount = '//Alice' | '//Bob' | '//Charlie' | '//Dave' | '//Eve' | '//Ferdie'

const miniSecret = entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE))
const derive = sr25519CreateDerive(miniSecret)

export interface TestAccount {
  /** Derivation path, e.g. `//Alice`. */
  suri: DevAccount
  /** Raw 32-byte sr25519 public key. */
  publicKey: Uint8Array
  /** SS58 string with no prefix override (i.e. format 42 — "Substrate"). For
   *  chain-specific representations, use `ss58Address(publicKey, prefix)` from
   *  hdkd-helpers. */
  address: string
  /** PAPI-compatible signer ready to pass to `signAndSubmit`. */
  signer: PolkadotSigner
}

const cache = new Map<DevAccount, TestAccount>()

export function devAccount(suri: DevAccount): TestAccount {
  const cached = cache.get(suri)
  if (cached) return cached

  const keyPair = derive(suri)
  const signer = getPolkadotSigner(keyPair.publicKey, 'Sr25519', keyPair.sign)
  const account: TestAccount = {
    suri,
    publicKey: keyPair.publicKey,
    address: ss58Address(keyPair.publicKey),
    signer,
  }
  cache.set(suri, account)
  return account
}

/** Same dev account encoded with the chain's preferred SS58 prefix. */
export function ss58For(account: TestAccount, prefix: number): string {
  return ss58Address(account.publicKey, prefix)
}
