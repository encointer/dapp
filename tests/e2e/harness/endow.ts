import { ss58Address } from '@polkadot-labs/hdkd-helpers'
import { DevRpc, newBlock, setStorage } from './dev-rpc'
import { WS_URL } from './ports'
import type { TestAccount } from './signer'

/** Pre-state categories from issues/9. */
export type PreState = 'usdc-only' | 'usdc-and-native'

/** Bridged-USDC location on KAH (parents:2 cross-consensus). The pjs-form
 *  shape (uppercase variants, GeneralIndex as number/bigint) is what
 *  chopsticks `dev_setStorage` accepts when used with the structured
 *  high-level form. */
const USDC_KAH_FOREIGN_LOC = {
  parents: 2,
  interior: {
    X4: [
      { GlobalConsensus: { Polkadot: null } },
      { Parachain: 1000 },
      { PalletInstance: 50 },
      { GeneralIndex: 1337 },
    ],
  },
}

/** Bridged-DOT location on KAH. */
const DOT_KAH_FOREIGN_LOC = {
  parents: 2,
  interior: { X1: [{ GlobalConsensus: { Polkadot: null } }] },
}

/** Bridged-KSM location on PAH. */
const KSM_PAH_FOREIGN_LOC = {
  parents: 2,
  interior: { X1: [{ GlobalConsensus: { Kusama: null } }] },
}

/** Default bumped balances large enough that nothing can run dry mid-test. */
const ENDOW = {
  KSM: 100n * 10n ** 12n, // 100 KSM (12 decimals)
  DOT: 100n * 10n ** 10n, // 100 DOT (10 decimals)
  USDC: 1_000n * 10n ** 6n, // 1_000 USDC (6 decimals)
}

function systemAccount(address: string, freePlanck: bigint): unknown {
  return [[address], { providers: 1, sufficients: 0, data: { free: freePlanck, reserved: 0n, frozen: 0n, flags: 0n } }]
}

function assetsAccount(assetId: number, address: string, balance: bigint): unknown {
  return [[assetId, address], { balance, status: 'Liquid', reason: { Sufficient: null }, extra: null }]
}

function foreignAssetsAccount(location: unknown, address: string, balance: bigint): unknown {
  return [[location, address], { balance, status: 'Liquid', reason: { Sufficient: null }, extra: null }]
}

/** Endow a test account on every chain so that test scenarios can run.
 *  `preState` controls whether the source chain's native token is also funded
 *  (per issue #9 pre-state categories (a) and (b)). All other chains receive
 *  generous balances so destination-side checks have something to compare
 *  against. */
export async function endowTestAccount(account: TestAccount, opts: {
  /** Source chain for the user-story under test. Pre-state semantics apply
   *  to this chain's *native* token (KSM on KAH, DOT on PAH). */
  source?: 'pah' | 'kah'
  /** Whether the user holds the source's native token. */
  preState: PreState
} = { preState: 'usdc-and-native' }): Promise<void> {
  const { source, preState } = opts
  const wantsNativeOnSource = preState === 'usdc-and-native'

  // Address representations: chopsticks's structured setStorage takes SS58
  // strings and re-encodes them per chain. We use Substrate-prefix (42) which
  // every chain accepts as input.
  const addr = ss58Address(account.publicKey)

  // Encointer (Kusama parachain): native KSM + nothing else.
  // Always endow generously so it can receive teleports.
  const encointerRpc = new DevRpc(WS_URL.encointer)
  try {
    await setStorage(encointerRpc, {
      System: { Account: [systemAccount(addr, ENDOW.KSM)] },
    })
    await newBlock(encointerRpc)
  } finally {
    encointerRpc.close()
  }

  // KAH: native KSM + bridged DOT + bridged USDC.
  const kahKsm = source === 'kah' ? (wantsNativeOnSource ? ENDOW.KSM : 0n) : ENDOW.KSM
  const kahRpc = new DevRpc(WS_URL.kah)
  try {
    await setStorage(kahRpc, {
      System: { Account: [systemAccount(addr, kahKsm)] },
      ForeignAssets: {
        Account: [
          foreignAssetsAccount(USDC_KAH_FOREIGN_LOC, addr, ENDOW.USDC),
          foreignAssetsAccount(DOT_KAH_FOREIGN_LOC, addr, ENDOW.DOT),
        ],
      },
    })
    await newBlock(kahRpc)
  } finally {
    kahRpc.close()
  }

  // PAH: native DOT + local USDC (assetId 1337) + bridged KSM (foreign).
  const pahDot = source === 'pah' ? (wantsNativeOnSource ? ENDOW.DOT : 0n) : ENDOW.DOT
  const pahRpc = new DevRpc(WS_URL.pah)
  try {
    await setStorage(pahRpc, {
      System: { Account: [systemAccount(addr, pahDot)] },
      Assets: { Account: [assetsAccount(1337, addr, ENDOW.USDC)] },
      ForeignAssets: { Account: [foreignAssetsAccount(KSM_PAH_FOREIGN_LOC, addr, ENDOW.KSM)] },
    })
    await newBlock(pahRpc)
  } finally {
    pahRpc.close()
  }
}
