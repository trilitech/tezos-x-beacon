# Landing page restructure

Notes for restructuring `plan.html` so the proposal is the star, not the validation.

## Problem with the current structure

Three top-level tabs: **Overview**, **Technical details**, **Wallet integration**. The proposal lives in the last tab under a label that sounds like a how-to. The first two tabs duplicate each other (both have "Phases" sections, one short, one long). Validation real-estate crowds out the thing the document is actually *for*.

Raphaël's summary version: "hard to tell the proposal description apart from the validation plan" + "the 7-step plan takes up too much space" + "no link to the demo."

## New structure — three tabs

| # | Tab | Hash | Role |
|---|---|---|---|
| 1 | **Proposal** | `#proposal` | Problem, proposal, rationale, observations. The TZIP pitch in one page. |
| 2 | **Integration** | `#integration` | Per-audience implementation guide (dApp, extension, standalone). Diffs are the star. |
| 3 | **Demo** | `#demo` | Video first. Compact validation table. Reproduce-locally instructions. |

Tabs must be **deep-linkable via URL hash** — people share links to specific tabs. Sub-tabs inside Tab 2 also deep-linkable (e.g. `#integration/extension`). Implementation: JS reads `window.location.hash` on load and on `hashchange`, sets `active` class on the matching tab/panel. Default (no hash) → Tab 1. Tab buttons are `<a href="#...">` elements so right-click → copy-link works.

## Tab 1 — Proposal

Content, in order:

1. **Problem statement** — 2-3 short paragraphs. TZIP-10 single-network today; Tezos X has two runtimes sharing one account model; dApps need both chains in one session.
2. **The proposal** (visual callout — the one card worth having on this tab):
   - Optional `networks[]` on `permission_request`
   - Optional `accounts` map on `permission_response`
   - CAIP-2 chain ids as a bare string in `operation_request.network`
   - Payload-only. Backward-compatible. Transport-agnostic.
3. **Why it's cheap** — prose with inline emphasis. This is a payload delta, not a new transport. Existing wallets adopt it by handling two new optional fields in their permission handler. No transport work, no new APIs, no new permissions.
4. **Observations** — compact list, 4-6 items:
   - Backward-compat means zero-risk rollout (dApp senses capability from response shape).
   - Extension wallets (Temple): payload-handler diff only, transport untouched.
   - WC2 wallets: small patch to session-proposal code (`WalletConnectCommunicationClient`).
   - Same Ed25519 key valid across Tezos-family chains → `accounts` entries often identical.
   - Popup UX sketch exists (see Integration → Standalone) but is not part of the TZIP proposal.
   - Scope of the TZIP: short revision / companion to TZIP-10, not a new fully-fledged TZIP.
5. **Status line** — one sentence: "Validated end-to-end on Matrix P2P and WalletConnect v2 on a dual-runtime previewnet. See *Demo*."

## Tab 2 — Integration

Content:

1. **Protocol summary** — re-use the same callout as Tab 1 so a deep-linked reader still gets anchored.
2. **Sub-tab nav** — three audience sub-tabs with hash routing:
   - `#integration/dapp` — Before/after diffs for `requestPermissions`, response detection, per-op chain tagging, edge cases.
   - `#integration/extension` — "Transport unchanged" banner + payload-handler diff. This is the minimum-change case; lead with it to reinforce the message.
   - `#integration/standalone` — Two clearly distinct sections:
     - *Existing standalone wallet (Matrix P2P or WC2):* same payload-only change as extension.
     - *Popup UX (exploratory):* the `tzip10-popup` message flow, clearly labeled as not part of the TZIP.

## Tab 3 — Demo

Content, in order:

1. **Video** — embedded at top. The PoC demo video. Raphaël couldn't find it on the current site — it must be the first thing here.
2. **What was validated** — compact table (not card grid):
   - Matrix P2P — payload delta carried end-to-end.
   - WalletConnect v2 — payload delta + CAIP namespace, real relay.
   - Cross-domain deployment — dApp and wallet on separate HTTPS origins.
   - Popup UX — exploratory, demoed end-to-end in browser.
   - Dual-runtime previewnet — operations confirmed on both chains.
3. **Reproduce locally** — the README's phase 5/6 commands verbatim. Two blocks, terminal-style. Credibility + auditability.
4. *(Optional)* Implementation notes — collapsed `<details>` with the headless control-API tables from the current Tab 2. Only useful for someone running the POC. Can also be dropped entirely from the site and kept in the repo README.

## UI principle: as simple as possible

Cards only where they are a **major** readability improvement. Concretely:

- **Keep**: the proposal-summary callout (1 card, high visual weight); the before/after diff-grid (2 columns side by side is uniquely useful for a payload diff).
- **Drop**: the objectives card grid, the phase cards (both compact and full), the obj-grid, most col-boxes.
- **Replace**: phase cards → one-line validation table rows. Objectives → short prose.

Reuse the existing color tokens (`--bg`, `--surface`, `--blue`, etc.) and typography — no reskin, just dramatically less furniture.

## Navigation and linking

- Top nav: three `<a href="#proposal|#integration|#demo">` tab buttons. Sticky.
- Tab 2 sub-nav: three `<a href="#integration/dapp|#integration/extension|#integration/standalone">` buttons, styled as a secondary nav inside the panel.
- Default (no hash) → activate Tab 1. Hash like `#integration/dapp` → activate Tab 2 + dapp sub-panel.
- JS listens to `hashchange` so back/forward work, and uses `history.pushState` on tab clicks to avoid unnecessary scrolls.

## Migration / housekeeping

- Old `plan.html` is served at `trilitech.github.io/tezos-x-octez-connect` via `.github/workflows/deploy-pages.yml`. Can swap in place once the new structure is ready.
- Drafts live in `reviews/plan-skeleton.html` until approved.
- Header badges (`POC`, `In progress`, `Tezos X`): drop "In progress" (README says all phases done) — contradicting itself looks sloppy.
- Top-line header tagline: rewrite to the one-sentence pitch. No more transport enumeration there.
