// Polyfill browser globals for Node.js
// (SDK accesses window.indexedDB, window.addEventListener, localStorage, BroadcastChannel)
import 'fake-indexeddb/auto'

if (typeof localStorage === 'undefined') {
  const _store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => _store.get(k) ?? null,
    setItem: (k: string, v: string) => _store.set(k, String(v)),
    removeItem: (k: string) => _store.delete(k),
    clear: () => _store.clear(),
    key: (i: number) => [..._store.keys()][i] ?? null,
    get length() { return _store.size },
  }
}

if (typeof window === 'undefined') {
  const _listeners: Record<string, Array<(...args: any[]) => void>> = {}
  ;(globalThis as any).window = {
    indexedDB: (globalThis as any).indexedDB,
    localStorage: (globalThis as any).localStorage,
    navigator: { userAgent: 'node.js' },
    addEventListener: (type: string, cb: (...args: any[]) => void) => {
      ;(_listeners[type] ??= []).push(cb)
    },
    removeEventListener: (type: string, cb: (...args: any[]) => void) => {
      _listeners[type] = (_listeners[type] ?? []).filter((l) => l !== cb)
    },
    matchMedia: (_query: string) => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    location: { href: 'http://localhost/' },
    open: () => null,
  }
}

if (typeof BroadcastChannel === 'undefined') {
  ;(globalThis as any).BroadcastChannel = class {
    constructor(_name: string) {}
    postMessage(_data: unknown) {}
    addEventListener(_type: string, _cb: unknown) {}
    removeEventListener(_type: string, _cb: unknown) {}
    close() {}
  }
}

if (typeof navigator === 'undefined') {
  ;(globalThis as any).navigator = { userAgent: 'node.js' }
}

import express from 'express'
import {
  DAppClient,
  NetworkType,
  BeaconEvent,
  Regions,
} from '@tezos-x/octez.connect-dapp'
import { MemoryStorage } from './storage'

const PORT = parseInt(process.env.PORT ?? '5173')
const L1_RPC = 'https://octez-shadownet-archive.octez.io'

// ── State ──────────────────────────────────────────────────────────────────

let pairingUri: string | null = null
let pairingUriWaiters: Array<() => void> = []
let lastPermission: unknown = null
let lastOp: { transactionHash: string } | null = null
let lastHandshake: { mode: string } = { mode: 'v2' }

// ── Client factory ─────────────────────────────────────────────────────────

function createClient(): DAppClient {
  const client = new DAppClient({
    name: 'Tezos X dApp POC',
    disableDefaultEvents: true,
    storage: new MemoryStorage() as any,
    network: {
      type: NetworkType.CUSTOM,
      rpcUrl: L1_RPC,
      name: 'Shadownet L1',
    },
    matrixNodes: {
      [Regions.EUROPE_WEST]: [
        'beacon-node-1.octez.io',
        'beacon-node-2.octez.io',
        'beacon-node-3.octez.io',
      ],
    },
  })

  // Capture pairing URI as soon as it is generated (before any modal would show)
  client.subscribeToEvent(BeaconEvent.PAIR_INIT, async (data: any) => {
    try {
      const uri: string = await data.p2pPeerInfo
      pairingUri = uri
      for (const resolve of pairingUriWaiters) resolve()
      pairingUriWaiters = []
    } catch (err) {
      console.error('[dapp] PAIR_INIT p2pPeerInfo error:', err)
    }
  })

  return client
}

let client: DAppClient = createClient()
let _pendingPermission: Promise<void> | null = null

// ── Express server ─────────────────────────────────────────────────────────

const app = express()
app.use(express.json())

// POST /request-permissions
// No body → v2 flow (Phase 1).
// {networks:[...]} → single-step multi-chain (Phase 2).
// Returns 200 once the pairing URI is ready — does NOT wait for wallet approval.
app.post('/request-permissions', async (_req, res) => {
  pairingUri = null
  pairingUriWaiters = []

  // Start requestPermissions in background; capture result when wallet approves
  _pendingPermission = (client.requestPermissions() as any)
    .then((perm: any) => {
      lastPermission = {
        version: '2',
        publicKey: perm.publicKey,
        address: perm.address,
      }
      lastHandshake = { mode: 'v2' }
    })
    .catch((err: any) => console.error('[dapp] requestPermissions error:', err.message))

  // Wait until pairing URI is available before responding to test runner
  if (!pairingUri) {
    await new Promise<void>((resolve) => pairingUriWaiters.push(resolve))
  }

  res.sendStatus(200)
})

// GET /pairing-uri
app.get('/pairing-uri', (_req, res) => {
  if (!pairingUri) return res.status(404).json({ error: 'no pairing URI yet' })
  res.type('text/plain').send(pairingUri)
})

// POST /request-operation
// Body: { network?: string, operationDetails: PartialTezosOperation[] }
app.post('/request-operation', async (req, res) => {
  try {
    const { operationDetails } = req.body
    const result = await (client as any).requestOperation({ operationDetails })
    lastOp = { transactionHash: result.transactionHash }
    res.json(lastOp)
  } catch (err: any) {
    console.error('[dapp] requestOperation error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /last-permission
app.get('/last-permission', (_req, res) => {
  res.json(lastPermission)
})

// GET /last-handshake
app.get('/last-handshake', (_req, res) => {
  res.json(lastHandshake)
})

// GET /last-op
app.get('/last-op', (_req, res) => {
  res.json(lastOp)
})

// POST /reset
app.post('/reset', async (_req, res) => {
  pairingUri = null
  pairingUriWaiters = []
  lastPermission = null
  lastOp = null
  lastHandshake = { mode: 'v2' }
  _pendingPermission = null
  try {
    await (client as any).destroy()
  } catch (_e) {}
  client = createClient()
  res.sendStatus(200)
})

app.listen(PORT, () => console.log(`[dapp] listening on :${PORT}`))
