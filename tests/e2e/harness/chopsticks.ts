import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { CHOPSTICKS_PORTS } from './ports'

/** Spawn the two chopsticks XCM-mode instances (Kusama-side and Polkadot-side)
 *  and wait until every WS port is reachable.
 *
 *  Why two processes: chopsticks XCM mode pairs ONE relay with N parachains
 *  and auto-forwards HRMP between siblings. Cross-consensus (PAH↔KAH bridge)
 *  spans two different relays, so it can't live in a single chopsticks
 *  invocation. The test harness forwards bridge messages between the two
 *  processes manually (see `bridge.ts`), keeping HRMP automatic and the
 *  bridge layer explicit. */
export interface ChopsticksHandle {
  kusama: ChildProcess
  polkadot: ChildProcess
  shutdown: () => Promise<void>
}

const HERE = dirname(fileURLToPath(import.meta.url))
const CHOPSTICKS_DIR = resolve(HERE, '..', 'chopsticks')

const DEBUG = process.env.DEBUG_CHOPSTICKS === '1'

function pipeStreams(label: string, child: ChildProcess) {
  if (!DEBUG) return
  child.stdout?.on('data', (b: Buffer) => process.stdout.write(`[${label}] ${b}`))
  child.stderr?.on('data', (b: Buffer) => process.stderr.write(`[${label}] ${b}`))
}

async function isPortOpen(port: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = createServer()
    sock.once('error', () => res(true)) // listen failed → port already in use
    sock.once('listening', () => sock.close(() => res(false)))
    sock.listen(port, '127.0.0.1')
  })
}

async function waitForPort(port: number, timeoutMs = 180_000, label = ''): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(port)) return
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new Error(`chopsticks${label ? ` (${label})` : ''} port ${port} did not open within ${timeoutMs}ms`)
}

/** XCM-mode invocations: one relay + N parachains per process. Cross-
 *  consensus (PAH↔KAH) needs two such processes since chopsticks pairs ONE
 *  relay with its parachains and there's no cross-relay connector. */
const SIDE_LAYOUT: Record<'kusama' | 'polkadot', { relay: string; paras: string[] }> = {
  kusama: { relay: 'kusama-relay.yml', paras: ['kah.yml', 'encointer.yml'] },
  polkadot: { relay: 'polkadot-relay.yml', paras: ['pah.yml'] },
}

function spawnChopsticks(side: 'kusama' | 'polkadot'): ChildProcess {
  const layout = SIDE_LAYOUT[side]
  const args = [
    '--yes', '@acala-network/chopsticks', 'xcm',
    '--relaychain', resolve(CHOPSTICKS_DIR, layout.relay),
    ...layout.paras.flatMap((p) => ['--parachain', resolve(CHOPSTICKS_DIR, p)]),
  ]
  // stdio: 'ignore' for stdout/stderr unless DEBUG — otherwise the pipe
  // buffer fills (~64KB) and chopsticks blocks on writes, hanging the whole
  // suite. With DEBUG=1 we inherit so the user sees full chopsticks output.
  const child = spawn('npx', args, {
    cwd: CHOPSTICKS_DIR,
    stdio: DEBUG ? 'inherit' : ['ignore', 'ignore', 'ignore'],
    detached: false,
  })
  pipeStreams(`chopsticks-${side}`, child)
  child.on('exit', (code, signal) => {
    if (DEBUG) console.log(`[chopsticks-${side}] exited code=${code} signal=${signal}`)
  })
  return child
}

export async function startChopsticks(): Promise<ChopsticksHandle> {
  const kusama = spawnChopsticks('kusama')
  const polkadot = spawnChopsticks('polkadot')

  // Wait for every parachain port (the relay ports come up first, so a child
  // ready means its relay is too).
  await Promise.all([
    waitForPort(CHOPSTICKS_PORTS.kah, 300_000, 'kah'),
    waitForPort(CHOPSTICKS_PORTS.encointer, 300_000, 'encointer'),
    waitForPort(CHOPSTICKS_PORTS.pah, 300_000, 'pah'),
  ])

  const shutdown = async (): Promise<void> => {
    for (const c of [kusama, polkadot]) {
      if (c.exitCode != null) continue
      c.kill('SIGTERM')
    }
    await Promise.all(
      [kusama, polkadot].map(
        (c) =>
          new Promise<void>((res) => {
            if (c.exitCode != null) return res()
            const t = setTimeout(() => {
              c.kill('SIGKILL')
              res()
            }, 5_000)
            c.on('exit', () => {
              clearTimeout(t)
              res()
            })
          }),
      ),
    )
  }

  return { kusama, polkadot, shutdown }
}
