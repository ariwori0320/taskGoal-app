import { defineConfig } from "@playwright/test"

// 画面の自動テスト。本番ではなく、サンプルデータ入りのモックDBで動かす（scripts/dev-mock.mjs）。
// ブラウザは、すでに入っている Microsoft Edge を使う（ダウンロード不要）。CI などでは E2E_CHANNEL=chrome などで切り替える。
const PORT = 3200
export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, channel: process.env.E2E_CHANNEL ?? "msedge", trace: "retain-on-failure", locale: "ja-JP", timezoneId: "Asia/Tokyo" },
  webServer: {
    command: "node scripts/dev-mock.mjs",
    env: { DEV_PORT: String(PORT), MOCK_PORT: "54400" },
    url: `http://localhost:${PORT}/api/settings`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
