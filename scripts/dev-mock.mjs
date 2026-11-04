// ローカル確認用: サンプルデータ入りのモックDB + next dev を一緒に起動する。
// 本番のSupabaseには接続しない。  node scripts/dev-mock.mjs
//   環境変数 DEV_PORT(既定3100) / MOCK_PORT(既定54321) / MOCK_EMPTY=1 で空のDB / MOCK_OLD_SCHEMA=1 で未マイグレーションを再現

import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { createMockSupabase } from "./mock-supabase.mjs"
import { loadSeed } from "./seed.mjs"

const require = createRequire(import.meta.url)
const devPort = Number(process.env.DEV_PORT ?? 3100)
const mockPort = Number(process.env.MOCK_PORT ?? 54321)
const oldSchema = process.env.MOCK_OLD_SCHEMA === "1"

const mock = createMockSupabase(oldSchema ? { newTables: false, missingColumns: ["estimate_minutes", "goal_id"] } : {})
await mock.listen(mockPort)
if (process.env.MOCK_EMPTY !== "1") loadSeed(mock)
console.log(`[dev-mock] モックDB http://127.0.0.1:${mockPort}/rest/v1 ${oldSchema ? "(未マイグレーション)" : ""}`)

const nextBin = require.resolve("next/dist/bin/next")
const child = spawn(process.execPath, [nextBin, "dev", "-p", String(devPort)], {
  stdio: "inherit",
  env: {
    ...process.env,
    SUPABASE_REST_URL: `http://127.0.0.1:${mockPort}/rest/v1`,
    SB_KEY: "local-dev",
    MYFLOW_ADMIN_KEY: process.env.MYFLOW_ADMIN_KEY ?? "dev-admin-key",
  },
})
const stop = () => { child.kill(); mock.close().finally(() => process.exit(0)) }
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
child.on("exit", code => process.exit(code ?? 0))
