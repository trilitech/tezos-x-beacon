import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.ts',
  timeout: 600_000,
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
