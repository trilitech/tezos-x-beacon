/**
 * Phase 6 — Popup model, PostMessage transport.
 *
 * dApp opens the wallet as a browser popup via window.open().
 * Communication is via PostMessage (tzip10-popup protocol).
 * The wallet runs in headless mode (?popup=1&headless=1): auto-approves all requests.
 *
 * Prerequisites:
 *   1. wallet dev server:  cd wc2/wallet && ./node_modules/.bin/vite --port 5174
 *   2. dApp dev server:    cd wc2/dapp   && ./node_modules/.bin/vite --port 5173
 *   (Both must be running before the test starts.)
 *
 * Run: npm run test:phase6
 */

import { test, expect } from '@playwright/test'

const DAPP_URL   = process.env.DAPP_URL   ?? 'http://localhost:5173'
const WALLET_URL = process.env.WALLET_URL ?? 'http://localhost:5174'

test.describe('Phase 6 — Popup transport', () => {
  test('multi-chain session via popup wallet', async ({ page, context }) => {
    // Navigate to dApp
    await page.goto(DAPP_URL)
    await page.waitForLoadState('networkidle')

    // ── Step 1: Register popup listener BEFORE clicking ────────────────────────
    const popupPromise = context.waitForEvent('page')

    // Click "Connect via popup"
    const btnPopup = page.locator('#btn-connect-popup')
    await expect(btnPopup).toBeVisible()

    // Intercept window.open to inject ?headless=1 so the wallet auto-approves
    await page.evaluate((walletUrl: string) => {
      const origOpen = window.open.bind(window)
      ;(window as any).open = (url: string, ...args: any[]) => {
        const u = new URL(url, window.location.href)
        u.searchParams.set('headless', '1')
        u.searchParams.set('popup', '1')
        const walletBase = new URL(walletUrl)
        u.hostname = walletBase.hostname
        u.port = walletBase.port
        u.protocol = walletBase.protocol
        u.pathname = walletBase.pathname + (u.pathname !== '/' ? u.pathname : '')
        return origOpen(u.toString(), ...args)
      }
    }, WALLET_URL)

    await btnPopup.click()

    // ── Step 2: Popup opens ────────────────────────────────────────────────────
    const popupPage = await popupPromise
    await popupPage.waitForLoadState('networkidle')
    console.log('Popup URL:', popupPage.url())

    // ── Step 3: Permission response received ──────────────────────────────────
    // Wait for 'Connected via popup' state in dApp
    await expect(page.locator('#conn-label')).toContainText('Connected', { timeout: 15_000 })
    console.log('✓ Session established (popup)')

    // Verify both chains present in connection label
    const connLabel = await page.locator('#conn-label').textContent()
    expect(connLabel).toContain('NetXsqzbfFenSTS')   // L1
    expect(connLabel).toContain('NetXH12Aer3be93')   // Michelson

    // ── Step 4: L1 transfer ────────────────────────────────────────────────────
    const btnL1 = page.locator('#btn-l1')
    await expect(btnL1).toBeEnabled({ timeout: 5_000 })
    await btnL1.click()
    console.log('Clicked L1 transfer')

    // Wait for hash to appear
    await expect(page.locator('#l1-hash')).not.toBeEmpty({ timeout: 60_000 })
    const l1Hash = (await page.locator('#l1-hash').textContent())?.trim() ?? ''
    expect(l1Hash).toMatch(/^o[A-Za-z0-9]{50,}$/)
    console.log('✓ L1 hash:', l1Hash)

    // Wait for inclusion (shadownet blocks ~30-60s; EventSource streams new heads)
    await expect(page.locator('#l1-status')).toContainText('included', { timeout: 180_000 })
    console.log('✓ L1 confirmed')

    // ── Step 5: L2 contract call ──────────────────────────────────────────────
    const btnL2 = page.locator('#btn-l2')
    await expect(btnL2).toBeEnabled({ timeout: 5_000 })
    await btnL2.click()
    console.log('Clicked L2 contract call')

    await expect(page.locator('#l2-hash')).not.toBeEmpty({ timeout: 90_000 })
    const l2Hash = (await page.locator('#l2-hash').textContent())?.trim() ?? ''
    expect(l2Hash).toMatch(/^o[A-Za-z0-9]{50,}$/)
    console.log('✓ L2 hash:', l2Hash)

    await expect(page.locator('#l2-status')).toContainText('included', { timeout: 90_000 })
    console.log('✓ L2 confirmed')

    // ── Step 6: Popup lifecycle ──────────────────────────────────────────────
    // Popup should still be open (stays across operations)
    expect(popupPage.isClosed()).toBe(false)
    console.log('✓ Popup still open after both ops')

    console.log('\n✅ Phase 6 passed — popup transport validated')
  })
})
