// Polyfill localStorage for Node.js (Matrix transport accesses it directly)
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

import express from 'express'
import {
  WalletClient,
  BeaconMessageType,
  PermissionScope,
  Serializer,
} from '@tezos-x/octez.connect-wallet'
import { TezosToolkit } from '@taquito/taquito'
import { InMemorySigner } from '@taquito/signer'
import { MemoryStorage } from './storage'

const PORT = parseInt(process.env.PORT ?? '5174')

// Suppress SDK-internal crashes so the Express server stays alive.
// The "unload" library (imported by broadcast-channel which is used by octez.connect-wallet)
// registers an uncaughtException handler that calls process.exit(101) for ANY error.
// It adds this handler asynchronously (after the leader election completes), so
// process.removeAllListeners() called here runs too early to fully remove it.
//
// The most reliable fix: intercept process.exit and block code 101.
// This lets the SDK's die() cleanup run without killing the server.
const _origExit = process.exit.bind(process)
;(process as any).exit = (code?: number | string) => {
  if (code === 101) {
    console.error('[wallet] suppressed process.exit(101) from unload library')
    return
  }
  return _origExit(code as number)
}

const SUPPRESSED_ERRORS = [
  'Syncing stopped manually.',  // Matrix sync stopped on client teardown
]

function isSuppressed(err: any): boolean {
  return SUPPRESSED_ERRORS.some((m) => err?.message?.includes(m))
}

process.removeAllListeners('uncaughtException')
process.removeAllListeners('unhandledRejection')

process.on('uncaughtException', (err: any) => {
  if (isSuppressed(err)) return
  console.error('[wallet] uncaughtException:', err)
  _origExit(1)
})

process.on('unhandledRejection', (reason: any) => {
  if (isSuppressed(reason)) return
  console.error('[wallet] unhandledRejection:', reason)
})

// Dev key — fund at https://faucet.shadownet.teztnets.com before running phase1 test
const WALLET_KEY =
  process.env.WALLET_KEY ??
  'edsk3QoqBuvdamxouPhin7swCvkQNgq4jP5KZPbwWNnwdZpSpJiEbq'
const DEFAULT_RPC = 'https://rpc.shadownet.teztnets.com'

// V2_MODE=true → wallet ignores networks[] and responds in legacy v2 shape (for backward-compat test)
let v2Mode: boolean = process.env.V2_MODE === 'true'

// chainId (CAIP-2) → rpcUrl — populated from networks[] on permission_request
let networkRegistry: Record<string, string> = {}

let lastRpcCall: { chainId: string; rpcUrl: string } | null = null

async function main(): Promise<void> {
  const signer = await InMemorySigner.fromSecretKey(WALLET_KEY)
  const publicKey = await signer.publicKey()

  const client = new WalletClient({
    name: 'Tezos X Wallet POC',
    storage: new MemoryStorage(),
  })
  await client.init()

  await client.connect(async (message) => {
    if (message.type === BeaconMessageType.PermissionRequest) {
      const incomingNetworks: any[] = (message as any).networks ?? []

      if (incomingNetworks.length > 0 && !v2Mode) {
        // v3 mode: respond with accounts map, one entry per approved chain
        networkRegistry = {}
        const accounts: Record<string, { publicKey: string }> = {}
        for (const net of incomingNetworks) {
          const raw: string = net.chainId ?? ''
          const chainId = raw.startsWith('tezos:') ? raw : `tezos:${raw}`
          accounts[chainId] = { publicKey }
          if (net.rpcUrl) networkRegistry[chainId] = net.rpcUrl
        }
        await client.respond({
          type: BeaconMessageType.PermissionResponse,
          id: message.id,
          publicKey,          // keep for SDK session establishment
          accounts,           // v3 extension: multi-chain account map
          network: message.network,
          scopes: message.scopes ?? [PermissionScope.OPERATION_REQUEST],
        } as any)
      } else {
        // v2 mode (legacy or V2_MODE=true)
        await client.respond({
          type: BeaconMessageType.PermissionResponse,
          id: message.id,
          publicKey,
          network: message.network,
          scopes: message.scopes ?? [PermissionScope.OPERATION_REQUEST],
        } as any)
      }
    } else if (message.type === BeaconMessageType.OperationRequest) {
      const networkField = (message as any).network
      let rpcUrl: string
      let chainId: string

      if (typeof networkField === 'string') {
        // v3: CAIP-2 string e.g. "tezos:NetXsqzbfFenSTS"
        chainId = networkField.startsWith('tezos:') ? networkField : `tezos:${networkField}`
        rpcUrl = networkRegistry[chainId] ?? DEFAULT_RPC
      } else {
        // v2: network object { type, rpcUrl?, chainId? }
        const raw: string = (networkField as any)?.chainId ?? 'NetXsqzbfFenSTS'
        chainId = raw.startsWith('tezos:') ? raw : `tezos:${raw}`
        rpcUrl = (networkField as any)?.rpcUrl ?? DEFAULT_RPC
      }

      lastRpcCall = { chainId, rpcUrl }

      const tezos = new TezosToolkit(rpcUrl)
      tezos.setSignerProvider(signer)

      try {
        const ops = (message.operationDetails as any[]).map((op) => {
          if (op.kind === 'transaction') {
            return {
              kind: 'transaction' as const,
              to: op.destination,
              amount: parseInt(op.amount, 10),
              mutez: true,
            }
          }
          return op
        })

        // tezlink (Michelson L2): estimate fees first, then apply 2× safety margin
        let result: any
        const isL2 = rpcUrl.includes('txpark') || rpcUrl.includes('tezlink')
        if (isL2) {
          const estimates = await tezos.estimate.batch(ops)
          const opsWithFees = ops.map((op: any, i: number) => ({
            ...op,
            fee: Math.ceil((estimates[i]?.suggestedFeeMutez ?? 0) * 2),
            gasLimit: Math.ceil((estimates[i]?.gasLimit ?? 1000) * 1.5),
            storageLimit: estimates[i]?.storageLimit ?? 257,
          }))

          // Snapshot counter before injection so we can detect inclusion.
          // The tezlink protocol does not expose operations in blocks/{id}/operations —
          // the account counter is the only reliable confirmation signal.
          const senderAddress = await signer.publicKeyHash()
          const counterBefore = await tezos.rpc
            .getContract(senderAddress, { block: 'head' })
            .then((r) => parseInt(String((r as any).counter ?? -1), 10))
            .catch(() => -1)

          result = await tezos.contract.batch(opsWithFees).send()

          // Wait for the counter to advance past counterBefore — this proves the
          // operation was included in a tezlink block.  The stream is opened BEFORE
          // the counter snapshot so we cannot miss the inclusion event; the
          // counterBefore snapshot then serves as a backfill guard.
          if (counterBefore >= 0) {
            await new Promise<void>((resolve) => {
              const deadline = setTimeout(resolve, 60_000)  // give up after 60 s
              const poll = setInterval(async () => {
                try {
                  const c = await tezos.rpc
                    .getContract(senderAddress, { block: 'head' })
                    .then((r) => parseInt(String((r as any).counter ?? 0), 10))
                  if (c > counterBefore) {
                    clearInterval(poll)
                    clearTimeout(deadline)
                    resolve()
                  }
                } catch (_) {}
              }, 3_000)
            })
          }
        } else {
          result = await tezos.contract.batch(ops).send()
        }
        await client.respond({
          type: BeaconMessageType.OperationResponse,
          id: message.id,
          transactionHash: result.hash,
        } as any)
      } catch (err: any) {
        console.error('[wallet] operation error:', err.message)
        await client.respond({
          type: BeaconMessageType.Error,
          id: message.id,
          errorType: 'UNKNOWN_ERROR',
        } as any)
      }
    }
  })

  const app = express()
  app.use(express.json())
  app.use(express.text({ type: 'text/plain' }))

  // POST /connect — wallet receives pairing URI from test runner
  app.post('/connect', async (req, res) => {
    try {
      const uri = req.body as string
      const peer = await new Serializer().deserialize(uri)
      await client.addPeer(peer as any)
      res.sendStatus(200)
    } catch (err: any) {
      console.error('[wallet] addPeer error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // GET /last-rpc-call — last operation_request routing (chainId + rpcUrl)
  app.get('/last-rpc-call', (_req, res) => {
    res.json(lastRpcCall)
  })

  // POST /set-mode — toggle v2/v3 behavior (for backward-compat tests)
  // Body: { mode: "v2" | "v3" }
  app.post('/set-mode', (req, res) => {
    const { mode } = req.body ?? {}
    if (mode === 'v2') { v2Mode = true; res.sendStatus(200) }
    else if (mode === 'v3') { v2Mode = false; res.sendStatus(200) }
    else res.status(400).json({ error: 'mode must be "v2" or "v3"' })
  })

  // POST /wc2-ready — Phase 5 stub (always 200 for now)
  app.post('/wc2-ready', (_req, res) => {
    res.sendStatus(200)
  })

  // GET /account — sender address (derived from WALLET_KEY)
  app.get('/account', async (_req, res) => {
    try {
      const address = await signer.publicKeyHash()
      res.json({ address })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /reset — clear state
  app.post('/reset', async (_req, res) => {
    lastRpcCall = null
    networkRegistry = {}
    try {
      const peers = await client.getPeers()
      for (const peer of peers) {
        await client.removePeer(peer as any)
      }
    } catch (_e) {}
    res.sendStatus(200)
  })

  app.listen(PORT, () => console.log(`[wallet] listening on :${PORT}`))
}

main().catch((err) => {
  console.error('[wallet] fatal:', err)
  process.exit(1)
})
