import {
  DAppClient,
  NetworkType,
  BeaconEvent,
  Regions,
  LocalStorage,
} from '@tezos-x/octez.connect-dapp'

const L1_CHAIN   = 'tezos:NetXsqzbfFenSTS'
const L2_CHAIN   = 'tezos:NetXH12Aer3be93'
const L1_RPC     = 'https://rpc.shadownet.teztnets.com'
const L2_RPC     = 'https://demo.txpark.nomadic-labs.com/rpc/tezlink'
const DEST       = 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb'
const L2_CONTRACT = 'KT1PWPM4rXF8QhouXmF8EugxFvYcdfiz6L3z'
const L1_TZKT    = 'https://api.shadownet.tzkt.io'
const L2_TZKT    = 'https://demo.txpark.nomadic-labs.com/tzkt'

const WALLET_POPUP_URL = (import.meta as any).env?.VITE_WALLET_URL ?? 'http://localhost:5174'
const PM_TYPE = 'tzip10-popup'

// ── DOM refs ──────────────────────────────────────────────────────────────────
const connDot        = document.getElementById('conn-dot')!
const connLabel      = document.getElementById('conn-label')!
const uriSection     = document.getElementById('uri-section')!
const uriDisplay     = document.getElementById('uri-display')!
const btnConnect     = document.getElementById('btn-connect') as HTMLButtonElement
const btnConnPopup   = document.getElementById('btn-connect-popup') as HTMLButtonElement
const btnDisconn     = document.getElementById('btn-disconnect') as HTMLButtonElement
const sectionOps = document.getElementById('section-ops') as HTMLElement
const btnL1      = document.getElementById('btn-l1') as HTMLButtonElement
const btnL2      = document.getElementById('btn-l2') as HTMLButtonElement
const l1Status   = document.getElementById('l1-status')!
const l2Status   = document.getElementById('l2-status')!
const l1Hash     = document.getElementById('l1-hash')!
const l2Hash     = document.getElementById('l2-hash')!

// ── State ──────────────────────────────────────────────────────────────────────
type ConnState = 'idle' | 'pairing' | 'connected'
let state: ConnState = 'idle'
let client: DAppClient | null = null
let v3Accounts: Record<string, { publicKey: string }> | null = null

// ── UI helpers ──────────────────────────────────────────────────────────────────
function setConnState(s: ConnState, label: string) {
  state = s
  connDot.className = 'dot ' + (s === 'idle' ? 'dot-idle' : s === 'pairing' ? 'dot-waiting' : 'dot-ok')
  connLabel.innerHTML = label
}

function setOpStatus(el: HTMLElement, s: 'pending' | 'done' | 'err', msg: string) {
  el.className = 'op-status ' + s
  el.textContent = msg
}

// ── Client factory ──────────────────────────────────────────────────────────────
function makeClient(): DAppClient {
  const c = new DAppClient({
    name: 'Tezos X dApp POC',
    disableDefaultEvents: true,
    network: { type: NetworkType.CUSTOM, rpcUrl: L1_RPC, name: 'Shadownet L1' },
    // Prefix storage to avoid key collisions with the wallet on the same origin
    storage: new LocalStorage('tezx-dapp'),
    matrixNodes: {
      [Regions.EUROPE_WEST]: [
        'beacon-node-1.octez.io',
        'beacon-node-2.octez.io',
        'beacon-node-3.octez.io',
      ],
    },
  })

  c.subscribeToEvent(BeaconEvent.PAIR_INIT, async (data: any) => {
    try {
      const uri: string = await data.p2pPeerInfo
      uriSection.style.display = 'block'
      uriDisplay.textContent = uri
      setConnState('pairing', 'Waiting for wallet to connect…')
    } catch (_) {}
  })

  return c
}

// ── Connect ──────────────────────────────────────────────────────────────────────
btnConnect.addEventListener('click', async () => {
  if (state !== 'idle') return
  btnConnect.disabled = true
  setConnState('pairing', 'Generating pairing URI…')

  client = makeClient()

  try {
    // Monkey-patch makeRequest to inject networks[] into permission_request
    const orig = (client as any).makeRequest.bind(client)
    ;(client as any).makeRequest = function (req: any, ...args: any[]) {
      if (req?.type === 'permission_request') {
        req.networks = [
          { chainId: L1_CHAIN, rpcUrl: L1_RPC, name: 'Shadownet L1' },
          { chainId: L2_CHAIN, rpcUrl: L2_RPC, name: 'Michelson interface' },
        ]
      }
      return orig(req, ...args)
    }

    const perm: any = await client.requestPermissions()
    ;(client as any).makeRequest = orig  // restore

    if (perm?.accounts && typeof perm.accounts === 'object') {
      v3Accounts = perm.accounts
      const chains = Object.keys(v3Accounts!).join(', ')
      setConnState('connected', `<strong>Connected</strong> · v3 · ${chains}`)
    } else {
      v3Accounts = null
      setConnState('connected', `<strong>Connected</strong> · v2 · ${perm?.publicKey?.slice(0, 12)}…`)
    }

    uriSection.style.display = 'none'
    btnConnect.style.display = 'none'
    btnDisconn.style.display = 'inline-flex'
    sectionOps.style.display = 'block'
    btnL1.disabled = false
    btnL2.disabled = false
  } catch (err: any) {
    setConnState('idle', `<span style="color:#ef4444">Error: ${err.message}</span>`)
    btnConnect.disabled = false
  }
})

// ── Disconnect ────────────────────────────────────────────────────────────────────
btnDisconn.addEventListener('click', async () => {
  try { await client?.clearActiveAccount() } catch (_) {}
  try { await (client as any)?.removeAllPeers() } catch (_) {}
  client = null
  v3Accounts = null
  setConnState('idle', 'Not connected')
  uriSection.style.display = 'none'
  btnConnect.style.display = 'inline-flex'
  btnConnect.disabled = false
  btnDisconn.style.display = 'none'
  sectionOps.style.display = 'none'
  ;[l1Status, l2Status].forEach(el => { el.textContent = ''; el.className = 'op-status' })
  ;[l1Hash, l2Hash].forEach(el => { el.style.display = 'none'; el.textContent = '' })
  btnL1.disabled = true
  btnL2.disabled = true
})

// ── Popup connect (Phase 6) ───────────────────────────────────────────────────
let popupWindow: Window | null = null
let popupPendingOp: { resolve: (hash: string) => void; reject: (e: Error) => void } | null = null

window.addEventListener('message', (event) => {
  const msg = event.data
  if (!msg || msg.type !== PM_TYPE) return

  if (msg.action === 'permission-response') {
    const accs = msg.accounts as Record<string, { publicKey: string }>
    const chains = Object.keys(accs).join(', ')
    v3Accounts = accs
    setConnState('connected', `<strong>Connected</strong> · popup · ${chains}`)
    btnConnPopup.style.display = 'none'
    btnConnect.style.display = 'none'
    btnDisconn.style.display = 'inline-flex'
    sectionOps.style.display = 'block'
    btnL1.disabled = false
    btnL2.disabled = false
  }

  if (msg.action === 'permission-error') {
    setConnState('idle', `<span style="color:#ef4444">Rejected by wallet</span>`)
    btnConnPopup.disabled = false
    btnConnect.disabled = false
  }

  if (msg.action === 'operation-response') {
    popupPendingOp?.resolve(msg.transactionHash)
    popupPendingOp = null
  }

  if (msg.action === 'operation-error') {
    popupPendingOp?.reject(new Error(msg.error ?? 'Unknown error'))
    popupPendingOp = null
  }
})

btnConnPopup.addEventListener('click', () => {
  if (state !== 'idle') return
  btnConnPopup.disabled = true
  btnConnect.disabled = true
  setConnState('pairing', 'Opening wallet popup…')

  const walletUrl = `${WALLET_POPUP_URL}/?popup=1`
  popupWindow = window.open(walletUrl, 'tezos-x-wallet', 'width=480,height=700')
  if (!popupWindow) {
    setConnState('idle', '<span style="color:#ef4444">Popup blocked by browser</span>')
    btnConnPopup.disabled = false
    btnConnect.disabled = false
    return
  }

  // Wait for wallet-ready then send permission request
  const onReady = (event: MessageEvent) => {
    const msg = event.data
    if (!msg || msg.type !== PM_TYPE || msg.action !== 'wallet-ready') return
    window.removeEventListener('message', onReady)
    setConnState('pairing', 'Wallet popup open — waiting for approval…')
    popupWindow!.postMessage({
      type: PM_TYPE,
      action: 'permission-request',
      id: crypto.randomUUID(),
      appName: 'Tezos X dApp POC',
      networks: [
        { chainId: L1_CHAIN, rpcUrl: L1_RPC, name: 'Shadownet L1' },
        { chainId: L2_CHAIN, rpcUrl: L2_RPC, name: 'Michelson interface' },
      ],
    }, '*')
  }
  window.addEventListener('message', onReady)
})

// ── Popup send operation ──────────────────────────────────────────────────────
async function sendOpPopup(
  chainId: string,
  operations: any[],
  statusEl: HTMLElement,
  hashEl: HTMLElement,
  btn: HTMLButtonElement,
  rpcBase: string,
  tzktBase: string,
  knownIncluded: boolean,
): Promise<void> {
  btn.disabled = true
  setOpStatus(statusEl, 'pending', 'Waiting for signature…')
  try {
    const hash = await new Promise<string>((resolve, reject) => {
      popupPendingOp = { resolve, reject }
      popupWindow!.postMessage({
        type: PM_TYPE,
        action: 'operation-request',
        id: crypto.randomUUID(),
        appName: 'Tezos X dApp POC',
        chainId,
        operations,
      }, '*')
    })
    hashEl.textContent = hash
    hashEl.style.display = 'block'
    setOpStatus(statusEl, 'pending', '✓ submitted — waiting for inclusion…')
    watchIncluded(hash, rpcBase, tzktBase, statusEl, hashEl, knownIncluded)
  } catch (err: any) {
    setOpStatus(statusEl, 'err', `✗ ${err.message}`)
    btn.disabled = false
  }
}

// ── Inclusion watcher ──────────────────────────────────────────────────────────
// knownIncluded=true  → wallet already confirmed inclusion (L2 counter-based);
//                       show "included" immediately, enrich with block # if TzKT catches up.
// knownIncluded=false → wait for TzKT to confirm (L1); use EventSource per new block.
function watchIncluded(
  hash: string,
  rpcBase: string,
  tzktBase: string,
  statusEl: HTMLElement,
  hashEl: HTMLElement,
  knownIncluded: boolean,
): void {
  const tzktUrl = `${tzktBase}/v1/operations/${hash}`
  const explorerLink = `<a href="${tzktBase}/${hash}" target="_blank" style="color:#7dd3fc">${hash}</a>`

  if (knownIncluded) {
    // Wallet confirmed via counter — show included now, enrich with block # later
    setOpStatus(statusEl, 'done', '✓ included')
    hashEl.innerHTML = explorerLink
    // Background: poll TzKT until block number available (up to 5 min)
    const deadline = Date.now() + 300_000
    const timer = setInterval(async () => {
      if (Date.now() > deadline) { clearInterval(timer); return }
      try {
        const ops = await fetch(tzktUrl).then(r => r.json()) as any[]
        if (ops.length > 0) {
          clearInterval(timer)
          const level = ops[0]?.level
          if (level) setOpStatus(statusEl, 'done', `✓ included · block ${level}`)
        }
      } catch (_) {}
    }, 5_000)
    return
  }

  // L1: stream-driven TzKT poller
  const es = new EventSource(`${rpcBase}/monitor/heads/main`)
  const deadline = setTimeout(() => {
    es.close()
    setOpStatus(statusEl, 'done', '✓ included (timeout fallback)')
  }, 120_000)

  async function check() {
    try {
      const ops = await fetch(tzktUrl).then(r => r.json()) as any[]
      if (ops.length > 0) {
        clearTimeout(deadline)
        es.close()
        const level = ops[0]?.level
        setOpStatus(statusEl, 'done', `✓ included${level ? ` · block ${level}` : ''}`)
        hashEl.innerHTML = explorerLink
      }
    } catch (_) {}
  }

  es.onmessage = () => check()
  es.onerror = () => {}
  check()
}

// ── Send operation helper ───────────────────────────────────────────────────────
async function sendOp(
  chainId: string,
  rpcBase: string,
  tzktBase: string,
  knownIncluded: boolean,
  operationDetails: any[],
  statusEl: HTMLElement,
  hashEl: HTMLElement,
  btn: HTMLButtonElement,
) {
  btn.disabled = true
  setOpStatus(statusEl, 'pending', 'Waiting for signature…')

  try {
    // Monkey-patch makeRequest to inject network CAIP-2 on operation_request
    const orig = (client as any).makeRequest.bind(client)
    ;(client as any).makeRequest = function (req: any, ...args: any[]) {
      if (req?.type === 'operation_request') req.network = chainId
      return orig(req, ...args)
    }

    let result: any
    try {
      result = await (client as any).requestOperation({ operationDetails })
    } finally {
      ;(client as any).makeRequest = orig
    }

    const hash = result.transactionHash
    hashEl.textContent = hash
    hashEl.style.display = 'block'
    setOpStatus(statusEl, 'pending', '✓ submitted — waiting for inclusion…')
    watchIncluded(hash, rpcBase, tzktBase, statusEl, hashEl, knownIncluded)
  } catch (err: any) {
    const msg = err?.message ?? err?.errorType ?? err?.description ?? String(err)
    setOpStatus(statusEl, 'err', `✗ ${msg}`)
    btn.disabled = false
  }
}

const L1_OPS = [{ kind: 'transaction', amount: '1', destination: DEST }]
const L2_OPS = [{
  kind: 'transaction',
  amount: '0',
  destination: L2_CONTRACT,
  parameters: { entrypoint: 'default', value: { string: 'hello from Tezos X dApp' } },
}]

btnL1.addEventListener('click', () => {
  if (popupWindow && !popupWindow.closed) {
    sendOpPopup(L1_CHAIN, L1_OPS, l1Status, l1Hash, btnL1, L1_RPC, L1_TZKT, false)
  } else {
    sendOp(L1_CHAIN, L1_RPC, L1_TZKT, false, L1_OPS, l1Status, l1Hash, btnL1)
  }
})
btnL2.addEventListener('click', () => {
  if (popupWindow && !popupWindow.closed) {
    sendOpPopup(L2_CHAIN, L2_OPS, l2Status, l2Hash, btnL2, L2_RPC, L2_TZKT, true)
  } else {
    sendOp(L2_CHAIN, L2_RPC, L2_TZKT, true, L2_OPS, l2Status, l2Hash, btnL2)
  }
})
