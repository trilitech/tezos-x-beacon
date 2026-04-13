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

// Dev key — fund at https://faucet.shadownet.teztnets.com before running phase1 test
const WALLET_KEY =
  process.env.WALLET_KEY ??
  'edsk3QoqBuvdamxouPhin7swCvkQNgq4jP5KZPbwWNnwdZpSpJiEbq'
const DEFAULT_RPC = 'https://octez-shadownet-archive.octez.io'

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
      await client.respond({
        type: BeaconMessageType.PermissionResponse,
        id: message.id,
        publicKey,
        network: message.network,
        scopes: message.scopes ?? [PermissionScope.OPERATION_REQUEST],
      } as any)
    } else if (message.type === BeaconMessageType.OperationRequest) {
      const rpcUrl: string = (message.network as any)?.rpcUrl ?? DEFAULT_RPC
      const rawChainId: string = (message.network as any)?.chainId ?? 'NetXsqzbfFenSTS'
      const chainId = rawChainId.startsWith('tezos:') ? rawChainId : `tezos:${rawChainId}`
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
        const result = await tezos.contract.batch(ops).send()
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
  app.use(express.text({ type: '*/*' }))
  app.use(express.json())

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

  // POST /wc2-ready — Phase 5 stub (always 200 for now)
  app.post('/wc2-ready', (_req, res) => {
    res.sendStatus(200)
  })

  // POST /reset — clear state
  app.post('/reset', async (_req, res) => {
    lastRpcCall = null
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
