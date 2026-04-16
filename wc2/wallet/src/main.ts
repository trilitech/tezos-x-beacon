import {
  WalletClient,
  BeaconMessageType,
  PermissionScope,
  Serializer,
  LocalStorage,
} from '@tezos-x/octez.connect-wallet'
import { TezosToolkit } from '@taquito/taquito'
import { InMemorySigner } from '@taquito/signer'

const WALLET_KEY = 'edsk3QoqBuvdamxouPhin7swCvkQNgq4jP5KZPbwWNnwdZpSpJiEbq'
const L1_RPC     = 'https://rpc.shadownet.teztnets.com'
const L2_RPC     = 'https://demo.txpark.nomadic-labs.com/rpc/tezlink'

// ── DOM refs ──────────────────────────────────────────────────────────────────
const accountAddr    = document.getElementById('account-addr')!
const statusBadge    = document.getElementById('status-badge')!
const requestSection = document.getElementById('request-section')!
const logList        = document.getElementById('log-list')!
const pairInput      = document.getElementById('pair-input') as HTMLInputElement
const btnPair        = document.getElementById('btn-pair') as HTMLButtonElement

// ── Logging ───────────────────────────────────────────────────────────────────
function addLog(msg: string, cls: 'ok' | 'err' | '' = '') {
  if (logList.querySelector('.empty-state')) logList.innerHTML = ''
  const ts = new Date().toTimeString().slice(0, 8)
  const el = document.createElement('div')
  el.className = 'log-entry'
  el.innerHTML = `<span class="log-time">${ts}</span><span class="log-msg ${cls}">${msg}</span>`
  logList.prepend(el)
}

// ── Network helpers ────────────────────────────────────────────────────────────
function networkDotClass(chainId: string) {
  return chainId.includes('NetXH12') ? 'net-dot-l2' : 'net-dot-l1'
}

function networkLabel(chainId: string) {
  return chainId.includes('NetXH12') ? 'Michelson interface' : 'Shadownet L1'
}

function rpcForChain(chainId: string, registry: Record<string, string>): string {
  return registry[chainId] ?? (chainId.includes('NetXH12') ? L2_RPC : L1_RPC)
}

// ── Request UI ─────────────────────────────────────────────────────────────────
function showPermissionRequest(
  dappName: string,
  networks: Array<{ chainId: string; name?: string }>,
  onApprove: () => void,
  onReject: () => void,
) {
  const netHtml = networks.map((n) => `
    <div class="net-item">
      <div class="net-dot ${networkDotClass(n.chainId)}"></div>
      <div>
        <div class="net-name">${n.name ?? networkLabel(n.chainId)}</div>
        <div class="net-chain">${n.chainId}</div>
      </div>
    </div>`).join('')

  requestSection.style.display = 'block'
  requestSection.innerHTML = `
    <div class="card">
      <div class="request">
        <span class="request-label">Connection request</span>
        <div class="request-title">${dappName}</div>
        <div class="request-from">Requests access to your account on:</div>
        <div class="net-list">${netHtml}</div>
        <div class="btn-row">
          <button class="btn btn-reject" id="req-reject">Reject</button>
          <button class="btn btn-approve" id="req-approve">Approve</button>
        </div>
      </div>
    </div>`

  document.getElementById('req-approve')!.addEventListener('click', () => {
    requestSection.style.display = 'none'
    requestSection.innerHTML = ''
    onApprove()
  })
  document.getElementById('req-reject')!.addEventListener('click', () => {
    requestSection.style.display = 'none'
    requestSection.innerHTML = ''
    onReject()
  })
}

function showOperationRequest(
  dappName: string,
  chainId: string,
  ops: any[],
  onApprove: () => void,
  onReject: () => void,
) {
  const netLabel = networkLabel(chainId)
  const opsHtml = ops.map((op) => `
    <div class="op-detail">
      <div class="op-detail-row">
        <span class="op-detail-key">Kind</span>
        <span class="op-detail-val">${op.parameters ? 'contract call' : op.kind}</span>
      </div>
      ${op.destination ? `<div class="op-detail-row">
        <span class="op-detail-key">To</span>
        <span class="op-detail-val">${op.destination}</span>
      </div>` : ''}
      ${op.parameters?.entrypoint ? `<div class="op-detail-row">
        <span class="op-detail-key">Entrypoint</span>
        <span class="op-detail-val">${op.parameters.entrypoint}</span>
      </div>` : ''}
      ${op.amount && op.amount !== '0' ? `<div class="op-detail-row">
        <span class="op-detail-key">Amount</span>
        <span class="op-detail-val">${op.amount} mutez</span>
      </div>` : ''}
    </div>`).join('')

  requestSection.style.display = 'block'
  requestSection.innerHTML = `
    <div class="card">
      <div class="request">
        <span class="request-label">Operation request</span>
        <div class="request-title">${dappName}</div>
        <div class="request-from">Wants to submit an operation on:</div>
        <div class="net-list">
          <div class="net-item">
            <div class="net-dot ${networkDotClass(chainId)}"></div>
            <div>
              <div class="net-name">${netLabel}</div>
              <div class="net-chain">${chainId}</div>
            </div>
          </div>
        </div>
        ${opsHtml}
        <div class="btn-row">
          <button class="btn btn-reject" id="req-reject">Reject</button>
          <button class="btn btn-approve" id="req-approve">Sign &amp; send</button>
        </div>
      </div>
    </div>`

  document.getElementById('req-approve')!.addEventListener('click', () => {
    requestSection.style.display = 'none'
    requestSection.innerHTML = ''
    onApprove()
  })
  document.getElementById('req-reject')!.addEventListener('click', () => {
    requestSection.style.display = 'none'
    requestSection.innerHTML = ''
    onReject()
  })
}

// ── Init ───────────────────────────────────────────────────────────────────────
async function main() {
  const signer = await InMemorySigner.fromSecretKey(WALLET_KEY)
  const publicKey = await signer.publicKey()
  const address   = await signer.publicKeyHash()

  accountAddr.textContent = address

  // Network registry: chainId → rpcUrl (populated from permission_request.networks[])
  let networkRegistry: Record<string, string> = {}

  const client = new WalletClient({
    name: 'Tezos X Wallet POC',
    // Prefix storage to avoid key collisions with the dApp on the same origin
    storage: new LocalStorage('tezx-wallet'),
  })
  await client.init()

  statusBadge.textContent = 'Listening'
  addLog('Wallet ready — listening for connections', 'ok')

  // ── Pairing via URI ────────────────────────────────────────────────────────
  const serializer = new Serializer()
  btnPair.addEventListener('click', async () => {
    const raw = pairInput.value.trim()
    if (!raw) return
    try {
      const peerInfo = await serializer.deserialize(raw) as any
      await client.addPeer(peerInfo)
      pairInput.value = ''
      addLog(`Paired with ${peerInfo.name ?? 'dApp'}`, 'ok')
    } catch (err: any) {
      console.error('Pairing error:', err)
      const msg = err?.message ?? err?.description ?? err?.errorType
        ?? (typeof err === 'object' ? JSON.stringify(err) : String(err))
      addLog(`Pairing failed: ${msg}`, 'err')
    }
  })

  await client.connect(async (message) => {
    if (message.type === BeaconMessageType.PermissionRequest) {
      const incomingNetworks: any[] = (message as any).networks ?? []
      const isV3 = incomingNetworks.length > 0

      if (isV3) {
        // Build registry and show approval UI
        const nets = incomingNetworks.map((n: any) => ({
          chainId: n.chainId?.startsWith('tezos:') ? n.chainId : `tezos:${n.chainId ?? ''}`,
          name: n.name,
          rpcUrl: n.rpcUrl,
        }))

        showPermissionRequest(
          message.appMetadata?.name ?? 'Unknown dApp',
          nets,
          async () => {
            // Approve — build accounts map
            networkRegistry = {}
            const accounts: Record<string, { publicKey: string }> = {}
            for (const n of nets) {
              accounts[n.chainId] = { publicKey }
              if (n.rpcUrl) networkRegistry[n.chainId] = n.rpcUrl
            }
            await client.respond({
              type: BeaconMessageType.PermissionResponse,
              id: message.id,
              publicKey,
              accounts,
              network: message.network,
              scopes: message.scopes ?? [PermissionScope.OPERATION_REQUEST],
            } as any)
            addLog(`Approved v3 session for ${Object.keys(accounts).join(', ')}`, 'ok')
          },
          async () => {
            await client.respond({
              type: BeaconMessageType.Error,
              id: message.id,
              errorType: 'ABORTED_ERROR',
            } as any)
            addLog('Permission request rejected', 'err')
          },
        )
      } else {
        // v2 legacy — auto-approve without UI (no networks[] to show)
        await client.respond({
          type: BeaconMessageType.PermissionResponse,
          id: message.id,
          publicKey,
          network: message.network,
          scopes: message.scopes ?? [PermissionScope.OPERATION_REQUEST],
        } as any)
        addLog('Approved v2 permission request', 'ok')
      }

    } else if (message.type === BeaconMessageType.OperationRequest) {
      const networkField = (message as any).network
      let chainId: string
      let rpcUrl: string

      if (typeof networkField === 'string') {
        chainId = networkField.startsWith('tezos:') ? networkField : `tezos:${networkField}`
        rpcUrl  = rpcForChain(chainId, networkRegistry)
      } else {
        const raw = (networkField as any)?.chainId ?? ''
        chainId = raw.startsWith('tezos:') ? raw : `tezos:${raw}`
        rpcUrl  = (networkField as any)?.rpcUrl ?? L1_RPC
      }

      const ops: any[] = (message.operationDetails as any[]).map((op) => {
        if (op.kind === 'transaction') {
          const base = { kind: 'transaction' as const, to: op.destination,
                         amount: parseInt(op.amount ?? '0', 10), mutez: true }
          return op.parameters ? { ...base, parameter: op.parameters } : base
        }
        return op
      })

      showOperationRequest(
        message.appMetadata?.name ?? 'Unknown dApp',
        chainId,
        message.operationDetails as any[],
        async () => {
          addLog(`Signing op on ${networkLabel(chainId)}…`)
          try {
            const tezos = new TezosToolkit(rpcUrl)
            tezos.setSignerProvider(signer)

            const isL2 = rpcUrl.includes('txpark') || rpcUrl.includes('tezlink')
            let result: any

            if (isL2) {
              const estimates = await tezos.estimate.batch(ops)
              const opsWithFees = ops.map((op: any, i: number) => ({
                ...op,
                fee: estimates[i]?.suggestedFeeMutez ?? 0,
                gasLimit: estimates[i]?.gasLimit,
                storageLimit: estimates[i]?.storageLimit,
              }))
              result = await tezos.contract.batch(opsWithFees).send()

              // Wait for counter to advance (tezlink protocol doesn't expose ops in block passes)
              const addr = await signer.publicKeyHash()
              const counterBefore = await tezos.rpc
                .getContract(addr, { block: 'head' })
                .then((r) => parseInt(String((r as any).counter ?? -1), 10))
                .catch(() => -1)
              if (counterBefore >= 0) {
                const deadline = Date.now() + 60_000
                while (Date.now() < deadline) {
                  await new Promise((res) => setTimeout(res, 3_000))
                  const c = await tezos.rpc
                    .getContract(addr, { block: 'head' })
                    .then((r) => parseInt(String((r as any).counter ?? 0), 10))
                    .catch(() => counterBefore)
                  if (c > counterBefore) break
                }
              }
            } else {
              result = await tezos.contract.batch(ops).send()
            }

            await client.respond({
              type: BeaconMessageType.OperationResponse,
              id: message.id,
              transactionHash: result.hash,
            } as any)
            addLog(`✓ ${networkLabel(chainId)}: ${result.hash.slice(0, 16)}…`, 'ok')
          } catch (err: any) {
            await client.respond({
              type: BeaconMessageType.Error,
              id: message.id,
              errorType: 'UNKNOWN_ERROR',
            } as any)
            const detail = err?.message ?? String(err)
            console.error('Operation failed:', err)
            addLog(`✗ ${detail}`, 'err')
          }
        },
        async () => {
          await client.respond({
            type: BeaconMessageType.Error,
            id: message.id,
            errorType: 'ABORTED_ERROR',
          } as any)
          addLog('Operation rejected by user', 'err')
        },
      )
    }
  })
}

main().catch((err) => {
  addLog(`Fatal: ${err.message}`, 'err')
  console.error(err)
})
