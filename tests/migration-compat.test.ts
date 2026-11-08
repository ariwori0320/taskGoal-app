// マイグレーション(001)を適用する「前」の本番を再現して、既存機能が壊れないことを確認する。
// 新テーブルは存在せず、tasks に estimate_minutes / goal_id 列も無い。

import test, { before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { startMock } from "./helpers"
import { UI_PRINCIPAL } from "../lib/principal"
import { addDays, nowInTz } from "../lib/time"

let mock: Awaited<ReturnType<typeof startMock>>
let T: typeof import("../lib/services/tasks")
let B: typeof import("../lib/services/timeboxes")
let SC: typeof import("../lib/services/schedule")
let ST: typeof import("../lib/services/settings")
let A: typeof import("../lib/services/analytics")
let G: typeof import("../lib/services/goals")

before(async () => {
  mock = await startMock({ newTables: false, missingColumns: ["estimate_minutes", "goal_id"] })
  T = await import("../lib/services/tasks")
  B = await import("../lib/services/timeboxes")
  SC = await import("../lib/services/schedule")
  ST = await import("../lib/services/settings")
  A = await import("../lib/services/analytics")
  G = await import("../lib/services/goals")
})
after(async () => { await mock.close() })
beforeEach(() => mock.reset())

const UI = UI_PRINCIPAL
const today = () => nowInTz("Asia/Tokyo").date

async function rejectsWith(p: Promise<unknown>, status: number, code?: string) {
  await assert.rejects(p, (e: unknown) => {
    const err = e as { status?: number; code?: string }
    assert.equal(err.status, status)
    if (code) assert.equal(err.code, code)
    return true
  })
}

test("既存のタスク操作（追加・編集・完了・削除・カテゴリ変更）は、新テーブルが無くても動く", async () => {
  const parent = await T.addTask(UI, { text: "親", mode: "private", priority: "high", due_date: "2026-12-01" })
  const child = await T.addTask(UI, { text: "子", parent_id: parent.id })
  assert.equal(child.mode, "private")

  const edited = await T.updateTask(UI, parent.id, { text: "親(改)", memo: "メモ https://example.com" })
  assert.equal(edited.text, "親(改)")

  const done = await T.completeTask(UI, parent.id)
  assert.equal(done.task.done, true)
  assert.equal(done.timebox, null)
  await T.completeTask(UI, parent.id, false)

  const moved = await T.changeTaskCategory(UI, parent.id, "work")
  assert.ok(moved.changed)
  assert.deepEqual((mock.store.tasks as any[]).map(t => t.mode), ["work", "work"])

  const del = await T.deleteTask(UI, parent.id, { confirm: true })
  assert.ok("deleted" in del && del.deleted)
  assert.equal(mock.store.tasks.length, 0)
})

test("既存の繰り返しタスクはマイグレーション前でも従来どおり", async () => {
  const r = await T.addTask(UI, { text: "毎日", mode: "private", is_recurring: true })
  await T.completeTask(UI, r.id)
  assert.equal((mock.store.tasks as any[])[0].recurring_done_date, today())
  ;(mock.store.tasks as any[])[0].recurring_done_date = addDays(today(), -1)
  assert.equal((await T.listTasks(UI, { mode: "private" })).tasks.length, 1)
})

test("新機能は『データベースの更新が必要』と分かるエラー(503)で止まり、既存データは変わらない", async () => {
  const t = await T.addTask(UI, { text: "タスク", mode: "private" })
  await rejectsWith(B.createTimebox(UI, { task_id: t.id, date: today(), window_start: 1140, window_end: 1320, planned_minutes: 30 }), 503, "migration_required")
  await rejectsWith(B.unplaceTask(UI, t.id), 503, "migration_required")
  await rejectsWith(SC.createFixedEvent(UI, { mode: "private", title: "予定", date: today(), start_min: 600, end_min: 660 }), 503, "migration_required")
  await rejectsWith(ST.saveSettings(UI, { bufferMinutes: 10 }), 503, "migration_required")
  await rejectsWith(T.addTask(UI, { text: "見積り付き", mode: "private", estimate_minutes: 30 }), 503, "migration_required")
  await rejectsWith(T.updateTask(UI, t.id, { estimate_minutes: 30 }), 503, "migration_required")
  assert.equal(mock.store.tasks.length, 1, "失敗した操作でタスクが増えたり壊れたりしない")
})

test("読み取りは空/既定値で返り、画面は『更新が必要』を表示できる", async () => {
  assert.deepEqual(await B.listTimeboxes(UI, { mode: "private" }), [])
  const s = await SC.getSchedule(UI, { mode: "private", from: today(), to: today() })
  assert.equal(s.migrationRequired, true)
  assert.deepEqual(s.timeboxes, [])
  assert.equal(s.settings.presets.length, 3, "設定は既定のプリセット(朝/昼/夜)")
  assert.equal(s.settings.timezone, "Asia/Tokyo")
  const settings = await ST.loadSettings()
  assert.equal(settings.bufferMinutes, 5)
  assert.deepEqual(await SC.listFixedEvents(UI, "private"), [])
  const sum = await A.summary(UI, { mode: "private" })
  assert.equal(sum.history_starts_at, null)
  assert.deepEqual(await G.listGoals(UI, "private"), [])
})

test("履歴の記録に失敗しても、本来の操作は成功する", async () => {
  const t = await T.addTask(UI, { text: "履歴なし", mode: "work" })
  assert.ok(t.id)
  assert.equal(mock.log.filter(l => l.table === "myflow_events").length >= 1, true, "記録を試みた")
})

test("本番のSupabaseには一切接続していない（すべてローカルのモックへ）", async () => {
  await T.addTask(UI, { text: "x", mode: "work" })
  assert.ok(process.env.SUPABASE_REST_URL?.startsWith("http://127.0.0.1:"))
  assert.ok(mock.log.length > 0)
})
