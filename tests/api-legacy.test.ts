// 旧来のAPI（目標・メモ・今年の目標）。画面が使っているので、応答の形と安全性を確認する。

import test, { before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { startMock } from "./helpers"

let mock: Awaited<ReturnType<typeof startMock>>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let R: Record<string, any>
const rows = (t: string) => mock.store[t] as any[] // eslint-disable-line @typescript-eslint/no-explicit-any

before(async () => {
  mock = await startMock()
  R = {
    goals: await import("../app/api/goals/route"),
    goal: await import("../app/api/goals/[id]/route"),
    memos: await import("../app/api/memos/route"),
    memo: await import("../app/api/memos/[id]/route"),
    highlights: await import("../app/api/highlights/route"),
  }
})
after(async () => { await mock.close() })
beforeEach(() => mock.reset())

async function call(fn: (req: Request, ctx: { params: { id: string } }) => Promise<Response>, method: string, path: string, body?: unknown, id = "") {
  const init: RequestInit = { method }
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "Content-Type": "application/json" } }
  const res = await fn(new Request(`http://localhost${path}`, init), { params: { id } })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null, text }
}

const goal = (id: string, mode: string, text: string, pct = 0) => rows("goals").push({ id, user_id: "default", mode, text, pct, due_date: null, created_at: new Date().toISOString() })
const task = (id: string, mode: string, goal_id: string | null, done = false) =>
  rows("tasks").push({ id, user_id: "default", mode, text: id, priority: "mid", done, parent_id: null, is_recurring: false, recurring_days: "", recurring_done_date: null, goal_id, created_at: new Date().toISOString() })

test("R-04: 目標一覧に、紐づくタスクの数と完了数が含まれる（カテゴリごと）", async () => {
  goal("g1", "private", "私的な目標", 40); goal("g2", "work", "仕事の目標", 10)
  task("a", "private", "g1"); task("b", "private", "g1", true); task("c", "private", null); task("w", "work", "g2")
  const r = await call(R.goals.GET, "GET", "/api/goals?mode=private")
  assert.equal(r.status, 200)
  assert.equal(r.json.length, 1)
  assert.deepEqual([r.json[0].id, r.json[0].pct, r.json[0].linked_total, r.json[0].linked_done], ["g1", 40, 2, 1])
  const w = await call(R.goals.GET, "GET", "/api/goals?mode=work")
  assert.deepEqual(w.json.map((g: any) => [g.id, g.linked_total, g.linked_done]), [["g2", 1, 0]]) // eslint-disable-line @typescript-eslint/no-explicit-any
})

test("R-04: 従来の項目（id/text/pct/due_date/created_at）はそのまま返る。紐づくタスクが無ければ 0", async () => {
  goal("g1", "private", "目標")
  const r = await call(R.goals.GET, "GET", "/api/goals?mode=private")
  for (const k of ["id", "text", "pct", "due_date", "created_at", "mode"]) assert.ok(k in r.json[0], k)
  assert.equal(r.json[0].linked_total, 0)
})

test("R-04: 目標の追加・更新・削除は従来どおり", async () => {
  const c = await call(R.goals.POST, "POST", "/api/goals", { text: "新しい目標", mode: "private", due_date: "2027-01-01" })
  assert.equal(c.status, 201)
  const u = await call(R.goal.PATCH, "PATCH", "/x", { pct: 55, text: "改名" }, c.json.id)
  assert.equal(u.json.pct, 55)
  assert.equal((await call(R.goal.DELETE, "DELETE", "/x", undefined, c.json.id)).status, 200)
  assert.equal(rows("goals").length, 0)
})

// ---------- R-11: 異常時に内部のエラー文を利用者へ返さない ----------

const INTERNAL = { code: "42P01", message: 'relation "public.secret_internal_table" does not exist at host db.internal.example.com password=hunter2' }
const leaks = (text: string) => /secret_internal_table|hunter2|internal\.example|42P01|relation/.test(text)

test("R-11: 目標・メモ・今年の目標のAPIは、DBが失敗しても内部のエラー文を返さない（汎用メッセージ）", async () => {
  const cases: [string, () => Promise<{ status: number; text: string }>, string][] = [
    ["goals", () => call(R.goals.GET, "GET", "/api/goals?mode=private"), "goals GET"],
    ["goals", () => call(R.goals.POST, "POST", "/api/goals", { text: "x", mode: "private" }), "goals POST"],
    ["goals", () => call(R.goal.PATCH, "PATCH", "/x", { pct: 1 }, "g1"), "goals PATCH"],
    ["goals", () => call(R.goal.DELETE, "DELETE", "/x", undefined, "g1"), "goals DELETE"],
    ["memos", () => call(R.memos.GET, "GET", "/api/memos?mode=private"), "memos GET"],
    ["memos", () => call(R.memos.POST, "POST", "/api/memos", { title: "t", mode: "private" }), "memos POST"],
    ["memos", () => call(R.memo.PATCH, "PATCH", "/x", { title: "t" }, "m1"), "memos PATCH"],
    ["memos", () => call(R.memo.DELETE, "DELETE", "/x", undefined, "m1"), "memos DELETE"],
    ["highlights", () => call(R.highlights.GET, "GET", "/api/highlights?mode=private"), "highlights GET"],
    ["highlights", () => call(R.highlights.PATCH, "PATCH", "/api/highlights", { mode: "private", year_text: "x" }), "highlights PATCH"],
  ]
  for (const [table, run, label] of cases) {
    mock.failNext(table, 500, INTERNAL)
    const r = await run()
    assert.equal(r.status, 500, `${label}: 500`)
    assert.ok(!leaks(r.text), `${label}: 内部のエラー文が漏れている → ${r.text}`)
    assert.ok(typeof JSON.parse(r.text).error === "string" && JSON.parse(r.text).error.length > 0, `${label}: 利用者向けのメッセージがある`)
  }
})

test("R-11: 入力の誤り(400)の文言は従来どおり利用者に返す", async () => {
  const r = await call(R.goals.POST, "POST", "/api/goals", { text: "  ", mode: "private" })
  assert.equal(r.status, 400)
  assert.equal(typeof r.json.error, "string")
})
