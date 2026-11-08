// AI 連携(MCP)の認証・権限・カテゴリ分離・取り消し・操作履歴を、実際の JSON-RPC 呼び出しで検証する。

import test, { before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { startMock } from "./helpers"
import { addDays, nowInTz } from "../lib/time"

let mock: Awaited<ReturnType<typeof startMock>>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let R: Record<string, any>
let T: typeof import("../lib/services/tasks")
let SC: typeof import("../lib/services/schedule")
let P: typeof import("../lib/principal")

const ADMIN_KEY = "test-admin-key-0123456789"
const SECRET = "社外秘の仕事タスク"
const rows = (t: string) => mock.store[t] as any[] // eslint-disable-line @typescript-eslint/no-explicit-any
const today = () => nowInTz("Asia/Tokyo").date

before(async () => {
  mock = await startMock()
  R = {
    mcp: await import("../app/api/connect/[transport]/route"),
    tokens: await import("../app/api/admin/ai-tokens/route"),
    token: await import("../app/api/admin/ai-tokens/[id]/route"),
    audit: await import("../app/api/admin/audit/route"),
  }
  T = await import("../lib/services/tasks")
  SC = await import("../lib/services/schedule")
  P = await import("../lib/principal")
})
after(async () => { await mock.close() })
beforeEach(() => { mock.reset(); process.env.MYFLOW_ADMIN_KEY = ADMIN_KEY; delete process.env.GPT_API_KEY })

// ---- ヘルパー ----
async function admin(fn: (req: Request, ctx: { params: { id: string } }) => Promise<Response>, method: string, path: string, body?: unknown, key: string | null = ADMIN_KEY, id = "") {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (key !== null) headers.Authorization = `Bearer ${key}`
  const res = await fn(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { params: { id } })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
const mint = async (body: Record<string, unknown> = {}) => (await admin(R.tokens.POST, "POST", "/api/admin/ai-tokens", { name: "claude", ...body })).json as { token: string; id: string }

async function rpc(token: string | null, method: string, params?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await R.mcp.POST(new Request("http://localhost/api/connect/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), { params: { transport: "mcp" } })
  const text = await res.text()
  const m = /data: (.*)/.exec(text)
  return { status: res.status, body: m ? JSON.parse(m[1]) : text ? (() => { try { return JSON.parse(text) } catch { return text } })() : null }
}
async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await rpc(token, "tools/call", { name, arguments: args })
  const res = r.body?.result
  const text = res?.content?.[0]?.text
  let data: unknown = text
  try { data = JSON.parse(text) } catch { /* エラー文などはそのまま */ }
  return { status: r.status, isError: !!res?.isError, data, rpcError: r.body?.error, raw: JSON.stringify(r.body) }
}
const toolNames = async (token: string) => ((await rpc(token, "tools/list")).body?.result?.tools ?? []).map((t: { name: string }) => t.name) as string[]
const mk = (text: string, mode: "work" | "private", extra: Record<string, unknown> = {}) => T.addTask(P.UI_PRINCIPAL, { text, mode, ...extra })

// ============ 認証 ============

test("認証なし・不正なトークンは 401。内部の理由（存在しない/取り消し/期限切れ）は区別して教えない", async () => {
  assert.equal((await rpc(null, "tools/list")).status, 401)
  assert.equal((await rpc("mf_not-a-real-token", "tools/list")).status, 401)
  assert.equal((await rpc("random", "tools/list")).status, 401)
  const r = await rpc("mf_not-a-real-token", "tools/list")
  assert.deepEqual(r.body, { error: "unauthorized" })
})

test("管理API: 管理キー未設定は 503、誤りは 401、正しければ通る", async () => {
  delete process.env.MYFLOW_ADMIN_KEY
  assert.equal((await admin(R.tokens.GET, "GET", "/api/admin/ai-tokens")).status, 503)
  process.env.MYFLOW_ADMIN_KEY = ADMIN_KEY
  assert.equal((await admin(R.tokens.GET, "GET", "/api/admin/ai-tokens", undefined, null)).status, 401)
  assert.equal((await admin(R.tokens.GET, "GET", "/api/admin/ai-tokens", undefined, "wrong")).status, 401)
  assert.equal((await admin(R.tokens.GET, "GET", "/api/admin/ai-tokens")).status, 200)
  // AIのトークンでは管理APIは使えない
  const t = await mint()
  assert.equal((await admin(R.tokens.GET, "GET", "/api/admin/ai-tokens", undefined, t.token)).status, 401)
})

test("トークン: 平文は発行時の1回だけ。DBにはハッシュしか無く、一覧にも出ない。既定は『プライベートのみ・閲覧のみ』", async () => {
  const t = await mint()
  assert.ok(t.token.startsWith("mf_") && t.token.length > 40)
  assert.deepEqual((t as any).modes, ["private"]) // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.deepEqual((t as any).scopes, ["read"]) // eslint-disable-line @typescript-eslint/no-explicit-any
  const stored = rows("myflow_ai_tokens")[0]
  assert.notEqual(stored.token_hash, t.token)
  assert.match(stored.token_hash, /^[0-9a-f]{64}$/)
  assert.ok(!JSON.stringify(rows("myflow_ai_tokens")).includes(t.token), "DBのどこにも平文は無い")
  const list = await admin(R.tokens.GET, "GET", "/api/admin/ai-tokens")
  const text = JSON.stringify(list.json)
  assert.ok(!text.includes(t.token) && !text.includes(stored.token_hash), "一覧にはハッシュも平文も出ない")
  assert.equal(list.json.tokens[0].prefix, t.token.slice(0, 9))
})

test("トークンの発行は入力を検証する（不正なカテゴリ・権限・名前・期限）", async () => {
  const post = (b: unknown) => admin(R.tokens.POST, "POST", "/api/admin/ai-tokens", b)
  assert.equal((await post({ name: "" })).status, 400)
  assert.equal((await post({ name: "x", modes: ["home"] })).status, 400)
  assert.equal((await post({ name: "x", scopes: ["root"] })).status, 400)
  assert.equal((await post({ name: "x", expires_in_days: 0 })).status, 400)
  assert.equal((await post({ name: "x".repeat(61) })).status, 400)
  assert.equal(rows("myflow_ai_tokens").length, 0)
})

// ============ 権限に応じたツール ============

test("ツール一覧は、トークンの権限に合うものだけ（既定は閲覧系のみ）", async () => {
  const readOnly = await mint()
  const names = await toolNames(readOnly.token)
  assert.ok(names.includes("list_tasks") && names.includes("get_schedule") && names.includes("get_my_access"))
  for (const w of ["add_task", "update_task", "complete_task", "create_timebox", "move_timebox", "delete_task", "change_task_category"]) assert.ok(!names.includes(w), `${w} は見えない`)

  const planner = await mint({ name: "planner", scopes: ["read", "schedule"] })
  const n2 = await toolNames(planner.token)
  assert.ok(n2.includes("create_timebox") && n2.includes("move_timebox") && !n2.includes("add_task") && !n2.includes("delete_task"))

  const all = await mint({ name: "all", scopes: ["read", "task_add", "task_edit", "schedule", "complete", "delete"] })
  const n3 = await toolNames(all.token)
  assert.equal(n3.length, 21)
})

test("見えないツールを直接呼んでも実行されない", async () => {
  const t = await mkTaskAndToken()
  const r = await call(t.token, "add_task", { text: "不正な追加" })
  assert.ok(r.isError || r.rpcError, "エラーになる")
  assert.equal(rows("tasks").filter(x => x.text === "不正な追加").length, 0)
  const d = await call(t.token, "delete_task", { id: t.privateId, confirm: true })
  assert.ok(d.isError || d.rpcError)
  assert.ok(rows("tasks").some(x => x.id === t.privateId), "削除されていない")
})
async function mkTaskAndToken() {
  const priv = await mk("私的タスク", "private")
  await mk(SECRET, "work", { memo: "機密メモ" })
  return { ...(await mint()), privateId: priv.id }
}

// ============ カテゴリの分離（最重要） ============

test("プライベートのみ許可のトークンは、どの読み取りツールでも仕事のデータを一切取得できない", async () => {
  const d = today()
  const priv = await mk("私的タスク", "private", { due_date: d })
  const work = await mk(SECRET, "work", { due_date: d, memo: "機密メモ" })
  await SC.createFixedEvent(P.UI_PRINCIPAL, { mode: "work", title: "社外秘の会議", date: d, start_min: 600, end_min: 660 })
  rows("goals").push({ id: "gw", user_id: "default", mode: "work", text: "社外秘の目標", pct: 50 })
  rows("memos").push({ id: "mw", user_id: "default", mode: "work", title: "社外秘のメモ", content: "x", tags: "", updated_at: "x" })
  const { createTimebox } = await import("../lib/services/timeboxes")
  await createTimebox(P.UI_PRINCIPAL, { task_id: work.id, date: d, window_start: 720, window_end: 1020, planned_minutes: 60 })
  await T.completeTask(P.UI_PRINCIPAL, work.id)

  const t = await mint({ scopes: ["read"] })
  const range = { from: addDays(d, -7), to: addDays(d, 7) }
  const results = [
    await call(t.token, "get_my_access"),
    await call(t.token, "list_tasks", { status: "all" }),
    await call(t.token, "list_goals"),
    await call(t.token, "list_timeboxes"),
    await call(t.token, "get_schedule", range),
    await call(t.token, "get_completion_history", range),
    await call(t.token, "get_postponements", range),
    await call(t.token, "get_summary", {}),
    await call(t.token, "get_task", { id: priv.id }),
  ]
  for (const r of results) {
    assert.ok(!r.raw.includes("社外秘"), "仕事の内容が応答に含まれてはいけない: " + r.raw.slice(0, 120))
    assert.ok(!r.raw.includes("機密"), "仕事の内容が応答に含まれてはいけない")
  }
  assert.deepEqual((results[1].data as any).tasks.map((x: any) => x.text), ["私的タスク"]) // eslint-disable-line @typescript-eslint/no-explicit-any
  // 仕事を明示的に指定すると拒否
  for (const [name, args] of [["list_tasks", { mode: "work" }], ["list_goals", { mode: "work" }], ["get_schedule", { mode: "work", ...range }], ["get_summary", { mode: "work" }], ["list_timeboxes", { mode: "work" }]] as const) {
    const r = await call(t.token, name, args as Record<string, unknown>)
    assert.equal(r.isError, true, `${name} mode=work は拒否される`)
    assert.ok(!r.raw.includes("社外秘"))
  }
  // IDを直接指定しても「存在しない」。存在を漏らさない
  const g = await call(t.token, "get_task", { id: work.id })
  assert.equal(g.isError, true)
  assert.match(String(g.data), /見つかりません/)
  const gp = await call(t.token, "get_goal_progress", { id: "gw" })
  assert.equal(gp.isError, true)
})

test("仕事のみ許可 / 両方許可 / 何も許可しない、の各トークンでカテゴリが正しく絞られる", async () => {
  await mk("私的", "private"); await mk("仕事", "work")
  const texts = async (tok: string) => ((await call(tok, "list_tasks", { status: "all" })).data as any).tasks.map((x: any) => x.text).sort() // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.deepEqual(await texts((await mint({ modes: ["work"] })).token), ["仕事"])
  assert.deepEqual(await texts((await mint({ modes: ["work", "private"] })).token), ["仕事", "私的"])
  assert.deepEqual(await texts((await mint({ modes: [] })).token), [])
})

// ============ 書き込みの権限 ============

test("書き込み: 許可された権限・カテゴリの範囲でだけ実行できる。仕事側には書けない", async () => {
  const priv = await mk("私的", "private"), work = await mk("仕事タスク", "work")
  const t = await mint({ name: "editor", scopes: ["read", "task_add", "task_edit", "complete"] })

  const added = await call(t.token, "add_task", { text: "AIが追加", estimate_minutes: 30 })
  assert.equal(added.isError, false)
  assert.equal(rows("tasks").find(x => x.text === "AIが追加").mode, "private", "許可カテゴリに追加される")
  assert.equal((await call(t.token, "add_task", { text: "仕事に追加", mode: "work" })).isError, true)

  assert.equal((await call(t.token, "update_task", { id: priv.id, text: "私的(改)" })).isError, false)
  assert.equal(rows("tasks").find(x => x.id === priv.id).text, "私的(改)")
  assert.equal((await call(t.token, "update_task", { id: work.id, text: "改ざん" })).isError, true)
  assert.equal(rows("tasks").find(x => x.id === work.id).text, "仕事タスク", "仕事のデータは変わらない")

  assert.equal((await call(t.token, "complete_task", { id: priv.id })).isError, false)
  assert.equal(rows("tasks").find(x => x.id === priv.id).done, true)
  assert.equal((await call(t.token, "complete_task", { id: work.id })).isError, true)
  assert.equal((await call(t.token, "change_task_category", { id: priv.id, mode: "work" })).isError, true, "移動先が許可されていない")
})

test("予定の操作: スロット指定で作成→移動(先送り)→分割→サイズ変更→未配置。履歴と警告も返る", async () => {
  const d = today()
  const task = await mk("TikTok編集", "private", { estimate_minutes: 120 })
  const t = await mint({ name: "planner", scopes: ["read", "schedule"] })

  const created = await call(t.token, "create_timebox", { task_id: task.id, date: d, slot: "night", minutes: 60 })
  assert.equal(created.isError, false)
  const box = (created.data as any).timebox // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(box.slot, "night"); assert.equal(box.start, "19:00"); assert.equal(box.minutes, 60)
  assert.equal((await call(t.token, "create_timebox", { task_id: task.id, date: d, minutes: 30 })).isError, true, "時間帯の指定が無い")
  assert.equal((await call(t.token, "create_timebox", { task_id: task.id, date: d, slot: "night", minutes: 999 })).isError, true, "時間帯より長い")
  assert.equal((await call(t.token, "create_timebox", { task_id: task.id, date: "2026-02-30", slot: "night", minutes: 30 })).isError, true)

  const moved = await call(t.token, "move_timebox", { id: box.id, date: addDays(d, 1) })
  assert.equal(moved.isError, false)
  assert.ok(rows("myflow_events").some(e => e.type === "timebox_postponed"), "後ろの日への移動は先送りとして記録")
  const split = await call(t.token, "split_timebox", { id: box.id, minutes: 20, date: addDays(d, 2) })
  assert.equal(split.isError, false)
  assert.equal((await call(t.token, "resize_timebox", { id: box.id, minutes: 30 })).isError, false)
  const sched = await call(t.token, "get_schedule", { from: d, to: addDays(d, 3) })
  assert.equal((sched.data as any).timeboxes.length, 2) // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal((await call(t.token, "unplace_task", { task_id: task.id })).isError, false)
  assert.equal(rows("myflow_timeboxes").filter(b => b.status === "planned").length, 0)
  // 仕事のタスクには予定を作れない
  const work = await mk("仕事", "work")
  assert.equal((await call(t.token, "create_timebox", { task_id: work.id, date: d, slot: "night", minutes: 10 })).isError, true)
})

test("削除: 確認なしでは実行されず、承認(confirm:true)後だけ削除される。削除権限が無ければツールが見えない", async () => {
  const task = await mk("消す", "private")
  const noDelete = await mint({ scopes: ["read", "task_edit"] })
  assert.ok(!(await toolNames(noDelete.token)).includes("delete_task"))
  const t = await mint({ name: "cleaner", scopes: ["read", "delete"] })
  const pre = await call(t.token, "delete_task", { id: task.id })
  assert.equal((pre.data as any).needsConfirmation, true) // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.ok(rows("tasks").some(x => x.id === task.id), "承認前は消えない")
  await call(t.token, "delete_task", { id: task.id, confirm: true })
  assert.ok(!rows("tasks").some(x => x.id === task.id))
})

// ============ 取り消し・期限・変更 ============

test("取り消しはその場で効く。期限切れも使えない。取り消し済みは変更できない", async () => {
  const t = await mint()
  assert.equal((await rpc(t.token, "tools/list")).status, 200)
  const rev = await admin(R.token.DELETE, "DELETE", "/x", undefined, ADMIN_KEY, t.id)
  assert.equal(rev.status, 200)
  assert.ok(rev.json.revoked_at)
  assert.equal((await rpc(t.token, "tools/list")).status, 401, "取り消した直後から使えない")
  assert.equal(rows("myflow_ai_tokens").length, 1, "行は残る（履歴のため）")
  assert.equal((await admin(R.token.PATCH, "PATCH", "/x", { scopes: ["read", "delete"] }, ADMIN_KEY, t.id)).status, 400)

  const e = await mint({ name: "short", expires_in_days: 1 })
  assert.equal((await rpc(e.token, "tools/list")).status, 200)
  rows("myflow_ai_tokens").find(r => r.id === e.id).expires_at = new Date(Date.now() - 1000).toISOString()
  assert.equal((await rpc(e.token, "tools/list")).status, 401)
  assert.equal((await admin(R.token.DELETE, "DELETE", "/x", undefined, ADMIN_KEY, "tk_unknown")).status, 404)
})

test("権限の変更は再発行なしで、次の呼び出しから反映される", async () => {
  const t = await mint()
  assert.ok(!(await toolNames(t.token)).includes("add_task"))
  await admin(R.token.PATCH, "PATCH", "/x", { scopes: ["read", "task_add"], modes: ["private", "work"] }, ADMIN_KEY, t.id)
  assert.ok((await toolNames(t.token)).includes("add_task"))
  assert.equal((await call(t.token, "add_task", { text: "仕事へ", mode: "work" })).isError, false)
  await admin(R.token.PATCH, "PATCH", "/x", { modes: ["private"] }, ADMIN_KEY, t.id)
  assert.equal((await call(t.token, "add_task", { text: "もう仕事へは追加できない", mode: "work" })).isError, true)
})

// ============ 操作履歴（監査） ============

test("AIの全操作が履歴に残る（誰が・どのツールを・成功/失敗）。内容そのものは記録しない", async () => {
  const priv = await mk("私的", "private")
  const t = await mint({ name: "claude", scopes: ["read", "task_add"] })
  await call(t.token, "list_tasks")
  await call(t.token, "add_task", { text: "とても個人的な内容のタスク" })
  await call(t.token, "list_tasks", { mode: "work" }) // 拒否される操作も残る
  const ev = rows("myflow_events").filter(e => e.type === "ai_call")
  assert.equal(ev.length, 3)
  assert.ok(ev.every(e => e.actor === "ai:claude"))
  assert.deepEqual(ev.map(e => [e.payload.tool, e.payload.ok]), [["list_tasks", true], ["add_task", true], ["list_tasks", false]])
  assert.equal(ev[2].payload.error, "forbidden")
  assert.ok(!JSON.stringify(ev).includes("とても個人的な内容"), "ログに本文は残さない")
  void priv

  const log = await admin(R.audit.GET, "GET", "/api/admin/audit?ai=1&limit=10")
  assert.equal(log.status, 200)
  assert.ok(log.json.events.some((e: any) => e.type === "ai_call" && e.actor === "ai:claude")) // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.ok(log.json.events.some((e: any) => e.type === "token_created")) // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal((await admin(R.audit.GET, "GET", "/api/admin/audit", undefined, "wrong")).status, 401)
})

// ============ 旧方式の共有キー・マイグレーション前 ============

test("旧方式の共有キー(GPT_API_KEY): 互換のため使えるが、プライベートのみ・削除不可に制限される", async () => {
  process.env.GPT_API_KEY = "legacy-shared-key-abc"
  await mk("私的", "private"); await mk(SECRET, "work")
  const names = await toolNames("legacy-shared-key-abc")
  assert.ok(names.includes("list_tasks") && names.includes("add_task") && !names.includes("delete_task"))
  const r = await call("legacy-shared-key-abc", "list_tasks", { status: "all" })
  assert.ok(!r.raw.includes("社外秘"))
  assert.equal((await call("legacy-shared-key-abc", "list_tasks", { mode: "work" })).isError, true)
  assert.equal((await rpc("wrong-legacy-key", "tools/list")).status, 401)
  const me = await call("legacy-shared-key-abc", "get_my_access")
  assert.match(JSON.stringify((me.data as any).note), /旧方式/) // eslint-disable-line @typescript-eslint/no-explicit-any
})

test("get_my_access: 今日の日付・時間帯・使える操作を返す（AIが日付を取り違えない）", async () => {
  const t = await mint({ scopes: ["read", "schedule"], modes: ["private"] })
  const me = (await call(t.token, "get_my_access")).data as any // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(me.today, today())
  assert.equal(me.timezone, "Asia/Tokyo")
  assert.deepEqual(me.accessible_modes, ["private"])
  assert.deepEqual(me.time_slots.map((s: any) => [s.key, s.start, s.end]), [["morning", "06:00", "10:00"], ["noon", "12:00", "17:00"], ["night", "19:00", "22:00"]]) // eslint-disable-line @typescript-eslint/no-explicit-any
})

test("R-10: 予定の作成・移動・サイズ変更・分割の応答にタスク名が入る", async () => {
  const d = today()
  const task = await mk("資料づくり", "private", { estimate_minutes: 120 })
  const t = await mint({ name: "planner", scopes: ["read", "schedule"] })
  const created = await call(t.token, "create_timebox", { task_id: task.id, date: d, slot: "night", minutes: 60 })
  const box = (created.data as any).timebox // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(box.task_text, "資料づくり")
  assert.equal(((await call(t.token, "move_timebox", { id: box.id, date: addDays(d, 1) })).data as any).timebox.task_text, "資料づくり") // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(((await call(t.token, "resize_timebox", { id: box.id, minutes: 50 })).data as any).timebox.task_text, "資料づくり") // eslint-disable-line @typescript-eslint/no-explicit-any
  const sp = (await call(t.token, "split_timebox", { id: box.id, minutes: 20, date: addDays(d, 2) })).data as any // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.deepEqual([sp.original.task_text, sp.created.task_text], ["資料づくり", "資料づくり"])
  const list = (await call(t.token, "list_timeboxes", {})).data as any // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.ok(list.timeboxes.length >= 2 && list.timeboxes.every((b: any) => b.task_text === "資料づくり")) // eslint-disable-line @typescript-eslint/no-explicit-any
})

test("R-10: change_task_category の応答の「完了か」は設定のタイムゾーンの日付で判定する", async () => {
  // 繰り返しタスクが「今日」完了済みかどうかは日付に依存する。設定のタイムゾーンが日付をまたぐ場所(例: Pacific/Kiritimati +14)なら
  // Asia/Tokyo 固定だと判定がずれる。設定の tz の今日で completed を判定していること。
  const { nowInTz } = await import("../lib/time")
  // 東京と日付が食い違うタイムゾーンを選ぶ（+14時間と-11時間のどちらかは、いつでも東京と日付が違う）
  const tdate = nowInTz("Asia/Tokyo").date
  const tz = ["Pacific/Kiritimati", "Pacific/Pago_Pago"].find(z => nowInTz(z).date !== tdate)!
  const kdate = nowInTz(tz).date
  rows("myflow_settings").push({ user_id: "default", timezone: tz, presets: [], buffer_minutes: 5 })
  const task = await mk("毎日の習慣", "private", { is_recurring: true, recurring_days: "0,1,2,3,4,5,6" })
  rows("tasks").find(r => r.id === task.id).recurring_done_date = kdate // 設定tzの「今日」に完了済み
  const t = await mint({ name: "editor", modes: ["work", "private"], scopes: ["read", "task_edit"] })
  const r = await call(t.token, "change_task_category", { id: task.id, mode: "work" })
  assert.equal(r.isError, false)
  assert.equal((r.data as any).task.completed, true) // eslint-disable-line @typescript-eslint/no-explicit-any
})

test("R-14: 管理キーの認証に失敗し続けると、接続元ごとに一時ブロックされる（正しいキーでも）。他の接続元には影響しない", async () => {
  const { resetThrottle, MAX_FAILURES } = await import("../lib/throttle")
  resetThrottle()
  const asIp = (ip: string, key: string | null) => async () => {
    const headers: Record<string, string> = { "x-forwarded-for": ip }
    if (key) headers.Authorization = `Bearer ${key}`
    const res = await R.tokens.GET(new Request("http://localhost/api/admin/ai-tokens", { headers }), { params: { id: "" } })
    return { status: res.status, retry: res.headers.get("Retry-After") }
  }
  for (let i = 0; i < MAX_FAILURES; i++) assert.equal((await asIp("203.0.113.9", `wrong-${i}`)()).status, 401)
  const blocked = await asIp("203.0.113.9", ADMIN_KEY)()
  assert.equal(blocked.status, 429, "ブロック中は正しいキーでも通らない")
  assert.ok(Number(blocked.retry) > 0, "Retry-After が付く")
  assert.equal((await asIp("198.51.100.7", ADMIN_KEY)()).status, 200, "別の接続元は通る")
  resetThrottle()
  assert.equal((await asIp("203.0.113.9", ADMIN_KEY)()).status, 200)
})

test("R-14: 成功すると失敗の回数はリセットされる／時間が過ぎればブロックは解ける", async () => {
  const T = await import("../lib/throttle")
  T.resetThrottle()
  for (let i = 0; i < T.MAX_FAILURES - 1; i++) T.recordFailure("k", 1000)
  assert.equal(T.blockedSeconds("k", 1000), 0, "上限の手前ではブロックしない")
  T.recordFailure("k", 1000)
  assert.ok(T.blockedSeconds("k", 1000) > 0)
  assert.equal(T.blockedSeconds("k", 1000 + T.WINDOW_MS), 0, "時間が過ぎれば解ける")
  T.recordFailure("j", 1000); T.clearFailures("j")
  for (let i = 0; i < T.MAX_FAILURES - 1; i++) T.recordFailure("j", 2000)
  assert.equal(T.blockedSeconds("j", 2000), 0, "成功でリセット済み")
})
