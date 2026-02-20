import {
  getInjectedExtensions,
  connectInjectedExtension,
  type InjectedExtension,
  type InjectedPolkadotAccount,
} from 'polkadot-api/pjs-signer'
import type { PolkadotSigner } from 'polkadot-api'

const STORAGE_KEY = 'encointer-dapp-wallet'

interface PersistedWallet {
  extensionName: string
  address: string
}

let extensionName = $state<string | null>(null)
let address = $state<string | null>(null)
let accountName = $state<string | null>(null)
let signer = $state<PolkadotSigner | null>(null)
let accounts = $state<InjectedPolkadotAccount[]>([])
let connected = $state(false)
let connecting = $state(false)
let error = $state<string | null>(null)

let extension: InjectedExtension | null = null
let unsubAccounts: (() => void) | null = null

function persist() {
  if (extensionName && address) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ extensionName, address }))
  }
}

function clearPersisted() {
  localStorage.removeItem(STORAGE_KEY)
}

function loadPersisted(): PersistedWallet | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as PersistedWallet
  } catch {
    // ignore
  }
  return null
}

function updateSelectedAccount(accs: InjectedPolkadotAccount[], targetAddress?: string) {
  accounts = accs
  const target = targetAddress ?? address
  const found = target ? accs.find(a => a.address === target) : accs[0]
  if (found) {
    address = found.address
    accountName = found.name ?? null
    signer = found.polkadotSigner
  } else if (accs.length > 0) {
    address = accs[0].address
    accountName = accs[0].name ?? null
    signer = accs[0].polkadotSigner
  } else {
    address = null
    accountName = null
    signer = null
  }
  persist()
}

export function discoverExtensions(): string[] {
  return getInjectedExtensions()
}

export async function connectExtension(name: string, targetAddress?: string) {
  disconnect()
  connecting = true
  error = null

  try {
    extension = await connectInjectedExtension(name)
    extensionName = name
    connected = true

    const accs = extension.getAccounts()
    updateSelectedAccount(accs, targetAddress)

    unsubAccounts = extension.subscribe((newAccounts) => {
      updateSelectedAccount(newAccounts)
    })
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to connect wallet'
    connected = false
  } finally {
    connecting = false
  }
}

export function selectAccount(addr: string) {
  const found = accounts.find(a => a.address === addr)
  if (found) {
    address = found.address
    accountName = found.name ?? null
    signer = found.polkadotSigner
    persist()
  }
}

export function disconnect() {
  unsubAccounts?.()
  unsubAccounts = null
  extension?.disconnect()
  extension = null
  extensionName = null
  address = null
  accountName = null
  signer = null
  accounts = []
  connected = false
  error = null
  clearPersisted()
}

export async function autoReconnect() {
  const persisted = loadPersisted()
  if (!persisted) return

  const available = getInjectedExtensions()
  if (available.includes(persisted.extensionName)) {
    await connectExtension(persisted.extensionName, persisted.address)
  }
}

export function getWalletState() {
  return {
    connected,
    connecting,
    extensionName,
    address,
    name: accountName,
    signer,
    accounts,
    error,
  }
}
