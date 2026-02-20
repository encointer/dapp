import type { ProviderMode } from './types'

const STORAGE_KEY = 'encointer-dapp-settings'

interface Settings {
  providerMode: ProviderMode
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as Settings
  } catch {
    // ignore
  }
  return { providerMode: 'smoldot' }
}

function save(s: Settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}

const initial = load()

let providerMode = $state<ProviderMode>(initial.providerMode)

export function getProviderMode(): ProviderMode {
  return providerMode
}

export function setProviderMode(mode: ProviderMode) {
  providerMode = mode
  save({ providerMode: mode })
}
