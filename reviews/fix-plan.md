# Fix plan — addressing Raphaël's review

Working notes on what to change in `plan.html` and `docs/` in response to `raphael.md`.

## Root cause of the confusion

The plan sells the POC as "validates multi-chain across three transports." It isn't. The real deliverable is a **payload-only extension to TZIP-10**:

- `permission_request` gains optional `networks[]`
- `permission_response` gains optional `accounts` map
- Both fields absent → unchanged v2 behavior (backward compatible)
- **Transport-agnostic by construction**

The document buries this thesis at `plan.html:1393` ("Transport unchanged. All changes are in message payload handling only — no new APIs, no new permissions"). It should be the lede.

## Terminology collision — "PostMessage"

The word "PostMessage" is overloaded in the plan:

1. **Extension PostMessage** — existing TZIP-10 transport (beacon-sdk `PostMessage` transport class): dApp ↔ content script via `window.postMessage`, bridged to background via `chrome.runtime`. Real, deployed (Temple et al.).
2. **`tzip10-popup` PostMessage** — new transport *invented by this POC* for Phase 6: dApp ↔ popup window via cross-origin `window.postMessage`, no extension runtime.

Both use the postMessage primitive; they are otherwise distinct (topology, envelope, lifecycle, edge cases).

Inconsistencies in `plan.html`:

| Line | Text | Problem |
|---|---|---|
| 374 (header) | "three transports: PostMessage, Matrix P2P, WalletConnect v2" | "PostMessage" reads as extension transport, which was never exercised by a phase; omits the popup entirely |
| 416 (overview) | "three Octez.connect transports (Matrix P2P, WalletConnect v2, PostMessage popup)" | Consistent with legend, but contradicts header |
| 454-456 (legend) | Matrix / WC2 / Popup | Correct for what was tested |
| 1393 (extension panel) | "PostMessage ↔ chrome.runtime channel continues to work as-is" | Correct, but undermines header's claim this was "covered" |
| 1540 (standalone panel) | "Popup transport (new)" | Correct, but reader can't tell if "Popup" = the header's "PostMessage" or a fourth thing |

## Asymmetry between phases 5 and 6

Plan pitches Phase 5 and Phase 6 as peers. They aren't:

| Phase | Transport | Pre-existing? | Validation claim |
|---|---|---|---|
| 5 | WalletConnect v2 | Yes — beacon-sdk `WalletConnectCommunicationClient`, patched for multi-chain | Payload delta + CAIP namespace shape rides on a real existing transport |
| 6 | `tzip10-popup` | **No — invented in this repo** (6 files, nothing outside) | An invented transport carrying the invented payload |

Phase 6 demoed that *a popup-style UX could carry multi-chain payload*. It did not validate multi-chain against any existing wallet or SDK. The name `tzip10-popup` overstates its status — it is not part of TZIP-10 and was not previously in beacon-sdk.

## Proposed reframing

### Thesis (new lede)

> A payload-only extension to TZIP-10 adds optional `networks[]` / `accounts` fields, enabling single-session multi-chain operations across Tezos L1 and the Tezos X Michelson interface. Transport-agnostic — works over all three existing TZIP-10 transports (extension PostMessage, Matrix P2P, WalletConnect v2) with no transport changes. Backward compatible: wallets that don't support multi-chain behave exactly as before.

### What the POC actually proves

1. **Payload delta carried on Matrix P2P** — Phases 1-4, end-to-end on real previewnet.
2. **Payload delta carried on WalletConnect v2** — Phase 5, via `tezos_send` with CAIP routing.
3. **Extension PostMessage** — not behaviorally tested, but payload-only nature means the change is a small diff in the extension's permission handler (shown at `plan.html:1418-1428`). Temple et al. adopt the extension by handling two new optional fields.
4. **Popup UX exploration (Phase 6)** — separate sidebar: *if* someone wants to build a standalone web wallet opened as a popup, the multi-chain payload fits in a minimal postMessage protocol. Not part of the TZIP proposal.

### What the TZIP looks like

Small. Not a fully-fledged new TZIP — either a revision of TZIP-10 or a short companion TZIP. Contents:

- Motivation (Tezos X dual-runtime)
- Two optional field additions
- Backward-compat behavior
- Note on transport-agnosticism
- CAIP-2 chain id convention (`tezos:<chain-id-b58>`)

`docs/wallet-multichain-integration.md` is already ~90% of this; needs to be recast as a TZIP draft (frontmatter, numbering, spec language) rather than an integration guide.

## Concrete edits to `plan.html`

- **line 374** — rewrite header to lead with "payload-only TZIP-10 extension, transport-agnostic." Drop bare "PostMessage, Matrix P2P, WalletConnect v2" enumeration from the tagline; move to a body sentence that clarifies what was tested where.
- **line 416** — reframe "Transport coverage" section from "validated three transports" to "validated the payload delta on two programmable transports (Matrix, WC2); extension PostMessage adopts the change via payload-only diff."
- **lines 454-456** — transport legend can stay, but relabel the popup item to something that doesn't imply it's a TZIP-10 transport. Options: "Popup UX exploration" or "Popup demo wallet." Remove the `tzip10-popup` name from user-facing copy where possible.
- **Phase 6 entry** — demote to "appendix / UX exploration" styling. Keep the content (still valuable as evidence the popup archetype works) but detach from the "three transports validated" narrative.
- **Standalone app panel (line 1532+)** — split cleanly: "Matrix P2P transport (existing, payload-only change)" and "Popup UX (exploratory, not part of the TZIP proposal)."
- **Navigation** — per Raphaël: the "7-step plan all marked done" is bloat, and the proposal-vs-validation-plan distinction is hard to see. Merge the two or at minimum signpost which tab is the *proposal* and which is the *validation evidence*. Consider removing the "Technical details" tab entirely.
- **Demo link** — add one (Raphaël missed the video, found it via Slack).
- **Header badges (line 370-372)** — "In progress" contradicts "all six phases done" in the README. Pick one.

## Concrete edits to `docs/`

- Rename or repurpose `wallet-multichain-integration.md` into a TZIP draft. Either:
  - split into `tzip-XXX-multichain.md` (the spec) and `wallet-integration-guide.md` (implementer notes and per-archetype diffs), or
  - keep the integration guide as-is and add a new `tzip-draft.md` alongside it.
- The Chrome-extension section already has the full payload diff; that's the core of the TZIP.
- The standalone-app section's "Popup transport (new)" subsection moves to a non-normative appendix.

## Open questions

- Is the `tzip10-popup` name worth keeping anywhere, even as an internal label? Leaning no — rename to `popup-demo` in code comments and `wc2/wallet/src/main.ts` to kill the TZIP association.
- Who owns the upstream PR against `@airgap/beacon-sdk`? The plan mentions the fork is "archived at POC completion" — needs a concrete handoff plan.
- Does Temple's team need a heads-up / review before we publish the TZIP draft? They're the primary consumer of the extension path that was never tested here.
