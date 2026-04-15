export {}  // ensure isolated module scope

/**
 * Phase 2 — single-step multi-chain version negotiation.
 *
 * Sends permission_request with networks[] (L1 + Michelson interface).
 * Detects v3 vs v2 from response shape. Validates routing on operation_request.
 *
 * Prerequisites:
 *   1. wallet running:  cd wallet && npm start  (port 5174)
 *   2. dapp running:    cd dapp && npm start    (port 5173)
 *   3. Both wallets funded on L1 and L2
 *
 * Run: npm run test:phase2
 */

const DAPP_URL = process.env.DAPP_URL ?? 'http://localhost:5173'
const WALLET_URL = process.env.WALLET_URL ?? 'http://localhost:5174'
const L1_RPC = 'https://rpc.shadownet.teztnets.com'
const L2_RPC = 'https://demo.txpark.nomadic-labs.com/rpc/tezlink'
const L1_CHAIN = 'tezos:NetXsqzbfFenSTS'
const L2_CHAIN = 'tezos:NetXH12Aer3be93'
const DEST = process.env.DEST ?? 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb'

async function get(url: string): Promise<unknown> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`)
  const ct = r.headers.get('content-type') ?? ''
  return ct.includes('application/json') ? r.json() : r.text()
}

async function post(url: string, body?: unknown): Promise<unknown> {
  const isText = typeof body === 'string'
  const r = await fetch(url, {
    method: 'POST',
    headers: body !== undefined
      ? { 'Content-Type': isText ? 'text/plain' : 'application/json' }
      : {},
    body: body !== undefined ? (isText ? body : JSON.stringify(body)) : undefined,
  })
  if (!r.ok) {
    const text = await r.text()
    throw new Error(`POST ${url} → ${r.status}: ${text}`)
  }
  const ct = r.headers.get('content-type') ?? ''
  return ct.includes('application/json') ? r.json() : r.text()
}

async function waitForConfirmation(hash: string, rpc: string, timeoutMs = 60_000): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  async function inBlock(blockId: string): Promise<boolean> {
    for (const pass of [0, 1, 2, 3]) {
      const ops: any[] = await fetch(`${rpc}/chains/main/blocks/${blockId}/operations/${pass}`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])
      if (Array.isArray(ops) && ops.find((o: any) => o.hash === hash)) return true
    }
    return false
  }

  try {
    // Open the stream first so no block slips between backfill and streaming.
    const monRes = await fetch(`${rpc}/monitor/heads/main`, { signal: controller.signal })

    if (!monRes.ok || !monRes.body) {
      // Fallback: simple head polling (used when the node doesn't expose monitor/heads,
      // e.g. the shadownet archive node returns 401 on that endpoint).
      while (!controller.signal.aborted) {
        if (await inBlock('head')) return
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 5_000)
          controller.signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
        })
      }
      throw new Error(`Operation ${hash} not confirmed after ${timeoutMs}ms`)
    }

    // Backfill: op may already be included before the stream was opened.
    const head: any = await fetch(`${rpc}/chains/main/blocks/head/header`).then((r) => r.json())
    for (let lvl = Math.max(1, head.level - 3); lvl <= head.level; lvl++) {
      if (await inBlock(String(lvl))) return
    }

    // Stream new heads and check each one.
    const reader = monRes.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const blk = JSON.parse(line) as { hash: string }
        if (await inBlock(blk.hash)) return
      }
    }
  } finally {
    clearTimeout(timer)
  }
  throw new Error(`Operation ${hash} not confirmed after ${timeoutMs}ms`)
}


async function connectSession(): Promise<void> {
  await post(`${DAPP_URL}/reset`)
  await post(`${WALLET_URL}/reset`)

  await post(`${DAPP_URL}/request-permissions`, {
    networks: [
      { chainId: L1_CHAIN, rpcUrl: L1_RPC, name: 'Shadownet L1' },
      { chainId: L2_CHAIN, rpcUrl: L2_RPC, name: 'Michelson interface' },
    ],
  })

  const uri = await get(`${DAPP_URL}/pairing-uri`) as string
  if (!uri || uri.length < 10) throw new Error(`invalid pairing URI: ${uri}`)

  await post(`${WALLET_URL}/connect`, uri)

  let perm: any = null
  for (let i = 0; i < 20; i++) {
    perm = await get(`${DAPP_URL}/last-permission`)
    if (perm?.accounts || perm?.publicKey) break
    await new Promise((r) => setTimeout(r, 1_000))
  }
  if (!perm?.accounts && !perm?.publicKey) throw new Error(`permission not granted: ${JSON.stringify(perm)}`)
}

async function main(): Promise<void> {
  console.log('─── Phase 2 — single-step multi-chain negotiation ───')

  // ── Part A: v3 session ───────────────────────────────────────────────────

  console.log('\n[ A ] v3 session (patched wallet)')
  await post(`${WALLET_URL}/set-mode`, { mode: 'v3' })
  await connectSession()

  const perm: any = await get(`${DAPP_URL}/last-permission`)
  const handshake: any = await get(`${DAPP_URL}/last-handshake`)

  if (handshake?.mode !== 'v3') throw new Error(`expected mode=v3, got: ${JSON.stringify(handshake)}`)
  console.log('✓ handshake mode: v3')

  if (!perm?.accounts?.[L1_CHAIN]?.publicKey)
    throw new Error(`missing accounts[${L1_CHAIN}]: ${JSON.stringify(perm)}`)
  if (!perm?.accounts?.[L2_CHAIN]?.publicKey)
    throw new Error(`missing accounts[${L2_CHAIN}]: ${JSON.stringify(perm)}`)
  console.log(`✓ accounts: L1 + L2 (publicKey: ${perm.accounts[L1_CHAIN].publicKey})`)

  // ── Part B: L1 operation routing ─────────────────────────────────────────

  console.log('\n[ B ] L1 operation — network routing')
  const l1Op: any = await post(`${DAPP_URL}/request-operation`, {
    network: L1_CHAIN,
    operationDetails: [{ kind: 'transaction', amount: '1', destination: DEST }],
  })
  if (!l1Op?.transactionHash) throw new Error(`no hash: ${JSON.stringify(l1Op)}`)
  console.log(`✓ L1 op hash: ${l1Op.transactionHash}`)

  const rpc1: any = await get(`${WALLET_URL}/last-rpc-call`)
  if (rpc1?.rpcUrl !== L1_RPC) throw new Error(`wrong rpcUrl: expected ${L1_RPC}, got ${rpc1?.rpcUrl}`)
  if (rpc1?.chainId !== L1_CHAIN) throw new Error(`wrong chainId: expected ${L1_CHAIN}, got ${rpc1?.chainId}`)
  console.log(`✓ wallet routed to L1 RPC (${L1_RPC})`)

  try {
    await waitForConfirmation(l1Op.transactionHash, L1_RPC)
    console.log('✓ confirmed on L1')
  } catch (err: any) {
    console.warn(`⚠  L1 confirmation: ${err.message}`)
  }

  // ── Part C: L2 (Michelson interface) operation routing ───────────────────

  console.log('\n[ C ] L2 operation — Michelson interface routing')
  // The wallet waits for counter-based confirmation before responding (see wallet/src/index.ts).
  // The tezlink protocol does not expose operations in blocks/{id}/operations/{pass}, so the
  // wallet uses the account counter as the only reliable inclusion signal.
  const l2Op: any = await post(`${DAPP_URL}/request-operation`, {
    network: L2_CHAIN,
    operationDetails: [{ kind: 'transaction', amount: '1', destination: DEST }],
  })
  if (!l2Op?.transactionHash) throw new Error(`no hash: ${JSON.stringify(l2Op)}`)
  console.log(`✓ L2 op hash: ${l2Op.transactionHash} (confirmed by wallet)`)

  const rpc2: any = await get(`${WALLET_URL}/last-rpc-call`)
  if (rpc2?.rpcUrl !== L2_RPC) throw new Error(`wrong rpcUrl: expected ${L2_RPC}, got ${rpc2?.rpcUrl}`)
  if (rpc2?.chainId !== L2_CHAIN) throw new Error(`wrong chainId: expected ${L2_CHAIN}, got ${rpc2?.chainId}`)
  console.log(`✓ wallet routed to L2 RPC (${L2_RPC})`)

  // ── Part D: backward compat — v2 wallet ignores networks[] ───────────────

  console.log('\n[ D ] backward compat — unpatched (v2) wallet')
  await post(`${WALLET_URL}/set-mode`, { mode: 'v2' })
  await connectSession()

  const permV2: any = await get(`${DAPP_URL}/last-permission`)
  const handshakeV2: any = await get(`${DAPP_URL}/last-handshake`)

  if (handshakeV2?.mode !== 'v2') throw new Error(`expected mode=v2, got: ${JSON.stringify(handshakeV2)}`)
  if (!permV2?.publicKey) throw new Error(`expected publicKey in v2 response: ${JSON.stringify(permV2)}`)
  console.log(`✓ handshake mode: v2 (publicKey: ${permV2.publicKey})`)

  // v2 op: no network field → routes to default L1
  const v2Op: any = await post(`${DAPP_URL}/request-operation`, {
    operationDetails: [{ kind: 'transaction', amount: '1', destination: DEST }],
  })
  if (!v2Op?.transactionHash) throw new Error(`no hash: ${JSON.stringify(v2Op)}`)
  const rpcV2: any = await get(`${WALLET_URL}/last-rpc-call`)
  if (rpcV2?.rpcUrl !== L1_RPC) throw new Error(`v2 op routed wrong: ${rpcV2?.rpcUrl}`)
  console.log('✓ v2 op routed to L1 (no network field)')

  // Restore v3 mode for future test runs
  await post(`${WALLET_URL}/set-mode`, { mode: 'v3' })

  console.log('\n✅ Phase 2 PASSED')
}

main().catch((err) => {
  console.error(`\n❌ Phase 2 FAILED: ${err.message}`)
  process.exit(1)
})
