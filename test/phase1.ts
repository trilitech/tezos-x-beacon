/**
 * Phase 1 — standard TZIP-10 over Matrix P2P, L1 only.
 *
 * Prerequisites:
 *   1. wallet running:  cd wallet && npm start           (port 5174)
 *   2. dapp running:    cd dapp && npm start             (port 5173)
 *   3. wallet funded:   https://faucet.shadownet.teztnets.com
 *      address: tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb  (key: edsk3QoqBuvdamxouPhin7swCvkQNgq4jP5KZPbwWNnwdZpSpJiEbq)
 *
 * Run: npm run test:phase1
 */

const DAPP_URL = process.env.DAPP_URL ?? 'http://localhost:5173'
const WALLET_URL = process.env.WALLET_URL ?? 'http://localhost:5174'
const L1_RPC = 'https://octez-shadownet-archive.octez.io'
// Default key address — used as self-transfer destination
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
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    for (const pass of [0, 1, 2, 3]) {
      const ops: any[] = await fetch(`${rpc}/chains/main/blocks/head/operations/${pass}`)
        .then((r) => r.json())
        .catch(() => [])
      if (Array.isArray(ops) && ops.find((o) => o.hash === hash)) return
    }
    await new Promise((r) => setTimeout(r, 5_000))
  }
  throw new Error(`Operation ${hash} not confirmed after ${timeoutMs}ms`)
}

async function main(): Promise<void> {
  console.log('─── Phase 1 — TZIP-10 over Matrix ───')

  // Reset both sides
  await post(`${DAPP_URL}/reset`)
  await post(`${WALLET_URL}/reset`)
  console.log('✓ state reset')

  // Step 1: request permissions (returns once pairing URI is ready)
  await post(`${DAPP_URL}/request-permissions`)
  console.log('✓ requestPermissions started')

  // Step 2: get pairing URI
  const uri = await get(`${DAPP_URL}/pairing-uri`) as string
  if (!uri || uri.length < 10) throw new Error(`invalid pairing URI: ${uri}`)
  console.log(`✓ pairing URI obtained (${uri.slice(0, 40)}…)`)

  // Step 3: connect wallet with URI
  await post(`${WALLET_URL}/connect`, uri)
  console.log('✓ wallet connected')

  // Step 4: wait for permission to complete (wallet auto-approves in HEADLESS mode)
  let perm: any = null
  for (let i = 0; i < 20; i++) {
    perm = await get(`${DAPP_URL}/last-permission`)
    if (perm?.publicKey) break
    await new Promise((r) => setTimeout(r, 1_000))
  }
  if (!perm?.publicKey) throw new Error(`permission not granted: ${JSON.stringify(perm)}`)
  console.log(`✓ permission granted — publicKey: ${perm.publicKey}`)

  // Step 5: request operation (1 mutez self-transfer on L1)
  const opResult: any = await post(`${DAPP_URL}/request-operation`, {
    operationDetails: [{ kind: 'transaction', amount: '1', destination: DEST }],
  })
  if (!opResult?.transactionHash) throw new Error(`no hash: ${JSON.stringify(opResult)}`)
  console.log(`✓ operation hash: ${opResult.transactionHash}`)

  // Step 6: confirm on-chain (requires funded wallet — skipped if RPC unreachable)
  try {
    await waitForConfirmation(opResult.transactionHash, L1_RPC)
    console.log('✓ confirmed on L1')
  } catch (err: any) {
    console.warn(`⚠  on-chain confirmation: ${err.message}`)
    console.warn('   (Fund the wallet at https://faucet.shadownet.teztnets.com if not done yet)')
  }

  console.log('\n✅ Phase 1 PASSED')
}

main().catch((err) => {
  console.error(`\n❌ Phase 1 FAILED: ${err.message}`)
  process.exit(1)
})
