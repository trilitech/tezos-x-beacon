# Tezos X — Octez.connect Multi-chain POC

Proof of concept for extending Octez.connect (TZIP-10) to support single-session multi-chain operations across Tezos L1 and the Michelson interface of Tezos X.

## Status

All six phases validated and done. The POC demonstrates a full multi-chain session (permission + L1 transfer + L2 contract call) via both WalletConnect (Phase 5) and tzip10-popup PostMessage transport (Phase 6). All derisking objectives have been met.

## Documents

| Document | Description |
|---|---|
| [Proposal](https://trilitech.github.io/tezos-x-octez-connect/) | TZIP-10 extension for multi-chain sessions — problem, proposal, integration, demo |
| [PoC planning and execution](https://trilitech.github.io/tezos-x-octez-connect/poc-plan.html) | Phase-by-phase plan, technical details, and test infrastructure |
| [Wallet integration guide](docs/wallet-multichain-integration.md) | How to extend a Chrome extension or standalone wallet for multi-chain TZIP-10 |

## Repo structure

```
wc2/
  dapp/       dApp (Vite, port 5173) — multi-chain session demo
  wallet/     Browser wallet (Vite, port 5174) — headless + interactive modes
test/
  phase5.ts   WalletConnect multi-chain session (tsx)
  phase6.ts   Popup transport multi-chain session (Playwright)
docs/
  wallet-multichain-integration.md
plan.html     Full development plan (GitHub Pages)
```

## Running the tests

### Phase 5 — WalletConnect

```bash
# Terminal 1
cd wc2/wallet && npx vite --port 5174

# Terminal 2
cd wc2/dapp && npx vite --port 5173

# Terminal 3
npm run test:phase5
```

### Phase 6 — Popup transport (Playwright)

```bash
# Terminal 1
cd wc2/wallet && npx vite --port 5174

# Terminal 2
cd wc2/dapp && npx vite --port 5173

# Terminal 3
npm run test:phase6
```

Both tests require a funded wallet on **both** L1 (ghostnet) and the Michelson interface of Tezos X previewnet. The wallet private key is read from the `WALLET_SK` environment variable (or hardcoded in `wc2/wallet/src/main.ts` for the POC).
