// 本番ビルド(next start)をサンプルデータ入りのモックDBにつないで起動し、主要な経路を通しで確認する。
// 本番のSupabaseには接続しない。  事前に `npm run build` が必要。  npm run smoke
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { createMockSupabase } from "./mock-supabase.mjs"
import { loadSeed } from "./seed.mjs"

const require = createRequire(import.meta.url)
const PORT = 3299, MOCK = 54399, ADMIN = "smoke-admin-key"
const base = `http://127.0.0.1:${PORT}`
let failed = 0
const check = (cond, msg, extra = "") => { console.log(`${cond ? "✔" : "✘"} ${msg}${cond ? "" : "  " + extra}`); if (!cond) failed++ }

const mock = createMockSupabase()
await mock.listen(MOCK)
loadSeed(mock)

const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-p", String(PORT)], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, SUPABASE_REST_URL: `http://127.0.0.1:${MOCK}/rest/v1`, SB_KEY: "smoke", MYFLOW_ADMIN_KEY: ADMIN, NODE_ENV: "production" },
})
let serverLog = ""
child.stdout.on("data", d => { serverLog += d }); child.stderr.on("data", d => { serverLog += d })
const stop = async () => { child.kill(); await mock.close() }

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/")).ok) break } catch { /* 起動待ち */ } await new Promise(r => setTimeout(r, 250)) }

  const home = await fetch(base + "/")
  const html = await home.text()
  check(home.status === 200 && html.includes("MyFlow"), "トップページが 200 で返る")
  check(!/application error|Internal Server Error/i.test(html), "トップページにエラー表示が無い")

  const j = async (path, init) => { const r = await fetch(base + path, init); const t = await r.text(); let b = null; try { b = JSON.parse(t) } catch { /* 無視 */ } return { status: r.status, body: b } }
  const post = (path, body, headers = {}) => j(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })

  const tasks = await j("/api/tasks?mode=private")
  check(tasks.status === 200 && tasks.body.length > 0 && tasks.body.every(t => t.mode === "private"), "タスク一覧（プライベートのみ）")
  const work = await j("/api/tasks?mode=work")
  check(work.status === 200 && work.body.every(t => t.mode === "work"), "タスク一覧（仕事のみ）。カテゴリが混ざらない")

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date())
  const planner = await j(`/api/planner?mode=private&from=${today}&to=${today}&includeOther=1`)
  check(planner.status === 200 && Array.isArray(planner.body.timeboxes) && planner.body.settings.presets.length === 3, "計画データ（週間プランナー用）")
  check(!JSON.stringify(planner.body).includes("社外秘"), "計画データに別カテゴリの内容が含まれない")

  const created = await post("/api/tasks", { text: "スモークテスト", mode: "private", estimate_minutes: 20 })
  check(created.status === 201 && created.body.id, "タスクを追加できる", JSON.stringify(created.body))
  const box = await post("/api/timeboxes", { task_id: created.body.id, date: today, window_start: 1140, window_end: 1320, planned_minutes: 20 })
  check(box.status === 201 && box.body.timebox.preset === "night", "予定（夜）を作成できる", JSON.stringify(box.body))
  const done = await post(`/api/tasks/${created.body.id}/complete`, {})
  check(done.status === 200 && done.body.task.done === true && done.body.timebox?.status === "done", "完了すると今日の予定が実施済みになる", JSON.stringify(done.body))

  // AI 連携: 発行 → 利用 → 取り消し
  const adminH = { Authorization: `Bearer ${ADMIN}` }
  check((await j("/api/admin/ai-tokens")).status === 401, "管理キー無しでは合鍵を扱えない")
  const tk = await post("/api/admin/ai-tokens", { name: "smoke", scopes: ["read"] }, adminH)
  check(tk.status === 201 && tk.body.token?.startsWith("mf_"), "合鍵を発行できる")
  const rpc = async (token, method, params) => {
    const r = await fetch(base + "/api/connect/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
    const t = await r.text(); const m = /data: (.*)/.exec(t)
    return { status: r.status, body: m ? JSON.parse(m[1]) : t }
  }
  check((await rpc(null, "tools/list")).status === 401, "MCP: 合鍵なしは 401")
  const list = await rpc(tk.body.token, "tools/call", { name: "list_tasks", arguments: { status: "all" } })
  const data = JSON.parse(list.body.result.content[0].text)
  check(data.tasks.length > 0 && data.tasks.every(t => t.mode === "private"), "MCP: プライベートのタスクだけが返る")
  check(!JSON.stringify(list.body).includes("社外秘"), "MCP: 仕事の内容が応答に含まれない")
  const denied = await rpc(tk.body.token, "tools/call", { name: "list_tasks", arguments: { mode: "work" } })
  check(denied.body.result.isError === true, "MCP: 仕事を指定すると拒否される")
  await j(`/api/admin/ai-tokens/${tk.body.id}`, { method: "DELETE", headers: adminH })
  check((await rpc(tk.body.token, "tools/list")).status === 401, "MCP: 取り消した直後から使えない")

  check(!/\b(TypeError|ReferenceError|Unhandled|ECONNREFUSED)\b/.test(serverLog), "サーバーログに例外が無い", serverLog.split("\n").filter(l => /Error|Unhandled/.test(l)).slice(0, 3).join(" | "))
  // DBへの通信はすべてモックに届いている（接続先を SUPABASE_REST_URL で切り替えられている = 本番へ向かっていない）
  check(mock.log.length > 20 && mock.log.some(l => l.table === "tasks") && mock.log.some(l => l.table === "myflow_ai_tokens"), `DBへの通信はローカルのモックに届いた（${mock.log.length}件）`)
} finally {
  await stop()
}
console.log(failed === 0 ? "\nスモークテスト: すべてOK" : `\nスモークテスト: ${failed}件の失敗`)
process.exit(failed === 0 ? 0 : 1)
