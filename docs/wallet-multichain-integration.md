---
title: Tezos X — Multi-chain Beacon integration guide
description: Protocol changes and implementation guide for wallet developers
date: 2026-04-17
status: draft
---

# Tezos X — Multi-chain Beacon integration guide

## Context

Tezos X introduces a dual-runtime architecture: an **EVM interface** (Etherlink) and a **Michelson interface** (same account model as L1, TZIP-compatible RPCs). A single user may hold the same key on both runtimes and want to sign operations on either within a single dApp session.

This document specifies the minimal changes required to the [TZIP-10](https://gitlab.com/tezos/tzip/-/blob/master/proposals/tzip-10/tzip-10.md) Beacon protocol to support multi-chain sessions, and provides implementation guidance for two wallet archetypes:

1. **Chrome extension wallet** — injects into the page, uses the existing PostMessage channel
2. **Standalone app wallet** — web app or mobile app; uses Matrix P2P pairing or a new popup transport

The changes are **backward compatible**: a dApp that sends `networks[]` talks multi-chain to wallets that support it, and falls back gracefully to single-chain with wallets that don't.

---

## 1. Protocol changes

### 1.1 `permission_request` — new optional `networks[]` field

A dApp that wants a multi-chain session includes a `networks` array in the permission request:

```json
{
  "type": "permission_request",
  "appMetadata": { "name": "My dApp" },
  "network": { "type": "custom", "rpcUrl": "..." },
  "scopes": ["operation_request"],

  "networks": [
    {
      "chainId": "tezos:NetXsqzbfFenSTS",
      "rpcUrl": "https://rpc.shadownet.teztnets.com",
      "name": "Tezos X L1"
    },
    {
      "chainId": "tezos:NetXH12Aer3be93",
      "rpcUrl": "https://demo.txpark.nomadic-labs.com/rpc/tezlink",
      "name": "Tezos X Michelson interface"
    }
  ]
}
```

**Field details:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chainId` | string | yes | [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) chain identifier: `tezos:<chain-id-b58>` |
| `rpcUrl` | string | recommended | RPC endpoint for this chain. The wallet should store this and use it to inject operations. |
| `name` | string | no | Human-readable label to show in the approval UI |

If `networks[]` is **absent**, the wallet behaves exactly as before (standard TZIP-10 v2, single-chain).

### 1.2 `permission_response` — new optional `accounts` map

If the wallet accepts a multi-chain request, it includes an `accounts` map in the response:

```json
{
  "type": "permission_response",
  "id": "<request-id>",
  "publicKey": "edpk...",
  "scopes": ["operation_request"],

  "accounts": {
    "tezos:NetXsqzbfFenSTS": { "publicKey": "edpk..." },
    "tezos:NetXH12Aer3be93": { "publicKey": "edpk..." }
  }
}
```

**Key points:**

- `accounts` keys are the CAIP-2 chain IDs from the request.
- For Tezos-family chains, the same Ed25519 key pair is valid across all chains (L1 and Michelson interface share the same address format `tz1…`). The wallet returns the same `publicKey` for each chain.
- `publicKey` at the top level is kept for backward compat.
- The dApp detects the response version by checking: `'accounts' in response ? v3 : v2`.

### 1.3 `operation_request` — `network` field now accepts a CAIP-2 string

The `network` field on `operation_request` can now be a bare CAIP-2 string:

```json
{
  "type": "operation_request",
  "id": "<request-id>",
  "operationDetails": [...],

  "network": "tezos:NetXH12Aer3be93"
}
```

The wallet uses this chain ID to look up the RPC endpoint it stored during the permission phase, then injects the operation there.

**Backward compat:** if `network` is an object (TZIP-10 v2 format), the wallet falls back to reading `network.rpcUrl` or `network.type` as before.

### 1.4 Summary of changes

| Message | Field | Change |
|---------|-------|--------|
| `permission_request` | `networks[]` | New optional array. Presence signals a multi-chain request. |
| `permission_response` | `accounts` | New optional map `{chainId → {publicKey}}`. Presence signals multi-chain approval. |
| `operation_request` | `network` | Now accepts a CAIP-2 string in addition to the existing object format. |

---

## 2. Chrome extension wallet

### How Chrome extension wallets work with Beacon

A Chrome extension wallet typically:
1. Injects a content script into every page
2. The content script listens for `window.postMessage` from the page (from the Beacon dApp SDK)
3. Messages are forwarded to the extension background service worker via `chrome.runtime.sendMessage`
4. The background opens an extension popup for user approval, then sends the response back

**No transport changes are needed.** The existing PostMessage ↔ `chrome.runtime` channel continues to work. Only the message payload handling changes.

### 2.1 Handle `networks[]` in `permission_request`

In the message handler that receives `permission_request` (background script or popup):

```typescript
if (message.type === 'permission_request') {
  const networks: Array<{ chainId: string; rpcUrl?: string; name?: string }>
    = message.networks ?? []

  if (networks.length > 0) {
    // Multi-chain request: present approval UI listing all requested chains
    const approved = await showMultiChainApprovalUI(message.appMetadata.name, networks)
    if (!approved) {
      sendError(message.id, 'ABORTED_ERROR')
      return
    }

    // Build network registry for later operation routing
    const networkRegistry: Record<string, string> = {}
    const accounts: Record<string, { publicKey: string }> = {}

    for (const net of networks) {
      accounts[net.chainId] = { publicKey: wallet.publicKey }
      if (net.rpcUrl) networkRegistry[net.chainId] = net.rpcUrl
    }

    // Store registry in extension storage for the active session
    await chrome.storage.session.set({ networkRegistry })

    sendResponse({
      type: 'permission_response',
      id: message.id,
      publicKey: wallet.publicKey,
      accounts,                         // ← new field
      network: message.network,
      scopes: message.scopes,
    })

  } else {
    // Legacy v2 path — single-chain, no change
    sendLegacyPermissionResponse(message)
  }
}
```

### 2.2 Approval UI

The approval popup should list each requested chain with its name and chain ID:

```
My dApp wants to connect to:

  ● Tezos X L1          (tezos:NetXsqzbfFenSTS)
  ● Michelson interface (tezos:NetXH12Aer3be93)

  Your address: tz1VSUr8…Cjcjb

  [Reject]   [Connect]
```

The user approves or rejects the **entire session** (not per-chain). Partial approval (some chains but not others) is not part of this extension.

### 2.3 Route operations by chain ID

In the `operation_request` handler:

```typescript
if (message.type === 'operation_request') {
  const networkField = message.network

  let chainId: string
  let rpcUrl: string

  if (typeof networkField === 'string') {
    // New format: CAIP-2 string
    chainId = networkField.startsWith('tezos:') ? networkField : `tezos:${networkField}`
    const registry = (await chrome.storage.session.get('networkRegistry')).networkRegistry ?? {}
    rpcUrl = registry[chainId] ?? fallbackRpcForChain(chainId)
  } else {
    // Legacy format: { type, rpcUrl, name, ... }
    rpcUrl = networkField?.rpcUrl ?? DEFAULT_L1_RPC
    chainId = `tezos:${networkField?.chainId ?? ''}`
  }

  // Inject the operation using rpcUrl
  const hash = await injectOperation(rpcUrl, message.operationDetails, wallet.secretKey)
  sendResponse({ type: 'operation_response', id: message.id, transactionHash: hash })
}
```

### 2.4 Fee estimation on the Michelson interface

The Michelson interface has different mempool parameters from mainnet (higher fee floor). **Auto-computed fees from the SDK will be too low and the operation will be rejected.**

You must explicitly estimate fees via the RPC before injecting:

```typescript
// Using Taquito (recommended):
const tezos = new TezosToolkit(rpcUrl)
tezos.setSignerProvider(signer)

// For Michelson interface operations, estimate explicitly:
const estimates = await tezos.estimate.batch(operations)
const opsWithFees = operations.map((op, i) => ({
  ...op,
  fee: estimates[i].suggestedFeeMutez,
  gasLimit: estimates[i].gasLimit,
  storageLimit: estimates[i].storageLimit,
}))
const result = await tezos.contract.batch(opsWithFees).send()
```

You can detect the Michelson interface by checking the chain ID (`NetXH12Aer3be93`) or by calling `/chains/main/mempool/filter` on the RPC and checking `minimal_fees` > 100.

---

## 3. Standalone app wallet

A standalone wallet (web app or mobile app not delivered as a browser extension) does not have access to the page's JavaScript context, so it cannot intercept `window.postMessage` directly.

Two transport options are available:

### 3.1 Matrix P2P transport (existing, extended)

The existing TZIP-10 pairing flow (QR code → Matrix room → encrypted messages) continues to work. The only change is in the message payload: handle `networks[]` on `permission_request` and return `accounts` on `permission_response`, exactly as described for Chrome extensions in §2.1–2.3.

**No changes to the pairing handshake or Matrix transport are needed.**

### 3.2 Popup transport (`tzip10-popup`) — new

The dApp opens the wallet as a browser popup via `window.open()`. Communication is via cross-origin `postMessage`. This transport is useful when the wallet is a web app hosted on its own domain (e.g., `wallet.example.com`).

The dApp calls:
```javascript
const popup = window.open('https://wallet.example.com/?popup=1', 'wallet', 'width=480,height=700')
```

#### Protocol message sequence

All messages use `{ type: 'tzip10-popup', action: '...', ... }`.

```
dApp opens popup at walletUrl?popup=1
                    │
                    ▼
Wallet loads, detects ?popup=1 and window.opener ≠ null
                    │
wallet ──────────── wallet-ready ──────────────────▶ dApp
                    │
dApp ────────────── permission-request ────────────▶ wallet
                    │
          User approves (or wallet auto-approves)
                    │
wallet ──────────── permission-response ───────────▶ dApp
                    │
           Session active; popup stays open
                    │
dApp ────────────── operation-request ─────────────▶ wallet
                    │
          Wallet signs and injects
                    │
wallet ──────────── operation-response ────────────▶ dApp
```

#### Message format reference

**`wallet-ready`** (wallet → dApp, on load):
```json
{ "type": "tzip10-popup", "action": "wallet-ready", "address": "tz1…" }
```

**`permission-request`** (dApp → wallet):
```json
{
  "type": "tzip10-popup",
  "action": "permission-request",
  "id": "<uuid>",
  "appName": "My dApp",
  "networks": [
    { "chainId": "tezos:NetXsqzbfFenSTS", "rpcUrl": "...", "name": "Tezos X L1" },
    { "chainId": "tezos:NetXH12Aer3be93", "rpcUrl": "...", "name": "Michelson interface" }
  ]
}
```

**`permission-response`** (wallet → dApp, on approval):
```json
{
  "type": "tzip10-popup",
  "action": "permission-response",
  "id": "<same-uuid>",
  "publicKey": "edpk…",
  "accounts": {
    "tezos:NetXsqzbfFenSTS": { "publicKey": "edpk…" },
    "tezos:NetXH12Aer3be93": { "publicKey": "edpk…" }
  }
}
```

**`permission-error`** (wallet → dApp, on rejection):
```json
{ "type": "tzip10-popup", "action": "permission-error", "id": "<uuid>", "errorType": "ABORTED_ERROR" }
```

**`operation-request`** (dApp → wallet):
```json
{
  "type": "tzip10-popup",
  "action": "operation-request",
  "id": "<uuid>",
  "appName": "My dApp",
  "chainId": "tezos:NetXH12Aer3be93",
  "operations": [
    {
      "kind": "transaction",
      "amount": "0",
      "destination": "KT1…",
      "parameters": { "entrypoint": "default", "value": { "string": "hello" } }
    }
  ]
}
```

**`operation-response`** (wallet → dApp, on success):
```json
{
  "type": "tzip10-popup",
  "action": "operation-response",
  "id": "<same-uuid>",
  "transactionHash": "oo…"
}
```

**`operation-error`** (wallet → dApp, on failure):
```json
{ "type": "tzip10-popup", "action": "operation-error", "id": "<uuid>", "error": "insufficient_fees" }
```

#### Wallet implementation (skeleton)

```typescript
async function initPopupMode(signer: Signer): Promise<void> {
  // Guard: only enter popup mode if correctly opened as a popup
  if (!new URLSearchParams(location.search).has('popup') || !window.opener) return

  const opener = window.opener as Window
  const send = (msg: object) => opener.postMessage(msg, '*')

  let networkRegistry: Record<string, string> = {}

  // Step 1: announce ready
  send({ type: 'tzip10-popup', action: 'wallet-ready', address: await signer.publicKeyHash() })

  // Step 2: handle incoming messages
  window.addEventListener('message', async (event: MessageEvent) => {
    const msg = event.data
    if (!msg || msg.type !== 'tzip10-popup') return

    if (msg.action === 'permission-request') {
      const networks: Array<{ chainId: string; rpcUrl?: string; name?: string }> = msg.networks ?? []

      const approved = await showApprovalUI(msg.appName, networks)  // or auto-approve in headless mode
      if (!approved) {
        send({ type: 'tzip10-popup', action: 'permission-error', id: msg.id, errorType: 'ABORTED_ERROR' })
        return
      }

      networkRegistry = {}
      const accounts: Record<string, { publicKey: string }> = {}
      const publicKey = await signer.publicKey()

      for (const net of networks) {
        accounts[net.chainId] = { publicKey }
        if (net.rpcUrl) networkRegistry[net.chainId] = net.rpcUrl
      }

      send({ type: 'tzip10-popup', action: 'permission-response', id: msg.id, publicKey, accounts })
    }

    if (msg.action === 'operation-request') {
      const { chainId, operations, id, appName } = msg
      const rpcUrl = networkRegistry[chainId] ?? fallbackRpcForChain(chainId)

      const approved = await showOperationUI(appName, chainId, operations)
      if (!approved) {
        send({ type: 'tzip10-popup', action: 'operation-error', id, error: 'ABORTED_ERROR' })
        return
      }

      try {
        const hash = await injectOperation(signer, rpcUrl, operations)
        send({ type: 'tzip10-popup', action: 'operation-response', id, transactionHash: hash })
      } catch (err: any) {
        send({ type: 'tzip10-popup', action: 'operation-error', id, error: err.message })
      }
    }
  })
}
```

#### Security notes

- **`postMessage` origin**: The wallet should validate `event.origin` against a known list of trusted dApp origins, or at minimum log unknown origins.
- **Popup blocker**: `window.open()` must be called from a user gesture (click handler). If the popup is blocked, the dApp should detect `popupWindow === null` and fall back to Matrix pairing.
- **`window.opener` access**: Cross-origin `postMessage` to `window.opener` works in all modern browsers. The wallet does not need read access to the opener's DOM.

---

## 4. Backward compatibility matrix

| dApp sends `networks[]` | Wallet returns `accounts` | Behaviour |
|-------------------------|---------------------------|-----------|
| No | No | Standard TZIP-10 v2 — single chain, existing behaviour unchanged |
| Yes | No | Wallet does not support multi-chain; dApp falls back to single-chain |
| Yes | Yes | Multi-chain session — dApp uses `accounts` map for routing |

Detection in the dApp (on `permission_response`):
```typescript
if (response.accounts && typeof response.accounts === 'object') {
  // v3 multi-chain session
  const chains = Object.keys(response.accounts)
} else {
  // v2 single-chain session
  const publicKey = response.publicKey
}
```

---

## 5. Reference implementation

A working proof of concept is available at:
**`trilitech/tezos-x-beacon`** — `wc2/wallet/src/main.ts` (browser wallet) and `wc2/dapp/src/main.ts` (dApp).

Validated transports:

| Transport | Status | Test |
|-----------|--------|------|
| Matrix P2P (TZIP-10 extension) | ✓ validated | `wc2/` browser wallet + dApp |
| WalletConnect v2 | ✓ validated | `test/phase5.ts` |
| Popup (`tzip10-popup`) | ✓ validated | `test/phase6.ts` (Playwright) |

Chains tested: Shadownet L1 (`tezos:NetXsqzbfFenSTS`) + Michelson interface (`tezos:NetXH12Aer3be93`).
