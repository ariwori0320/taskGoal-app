import test, { before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { startMock } from "./helpers"
import { addDays, nowInTz } from "../lib/time"

let mock: Awaited<ReturnType<typeof startMock>>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let R: Record<string, any>

before(async () => {
  mock = await startMock()
  R = {
    tasks: await import("../app/api/tasks/route"),
    task: await import("../app/api/tasks/[id]/route"),
    taskComplete: await import("../app/api/tasks/[id]/complete/route"),
    taskUnplace: await import("../app/api/tasks/[id]/unplace/route"),
    boxes: await import("../app/api/timeboxes/route"),
    box: await import("../app/api/timeboxes/[id]/route"),
    boxComplete: await import("../app/api/timeboxes/[id]/complete/route"),
    boxSplit: await import("../app/api/timeboxes/[id]/split/route"),
    planner: await import("../app/api/planner/route"),
    fixed: await import("../app/api/fixed-events/route"),
    fixedOne: await import("../app/api/fixed-events/[id]/route"),
    settings: await import("../app/api/settings/route"),
  }
})
after(async () => { await mock.close() })
beforeEach(() => mock.reset())

const today = () => nowInTz("Asia/Tokyo").date

async function call(fn: (req: Request, ctx: { params: { id: string } }) => Promise<Response>, method: string, path: string, body?: unknown, id = "") {
  const init: RequestInit = { method }
  if (body !== undefined) { init.body = typeof body === "string" ? body : JSON.stringify(body); init.headers = { "Content-Type": "application/json" } }
  const res = await fn(new Request(`http://localhost${path}`, init), { params: { id } })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

const addTask = async (text: string, mode = "private", extra: object = {}) =>
  (await call(R.tasks.POST, "POST", "/api/tasks", { text, mode, ...extra })).json

test("タスク: 追加(201)・取得・従来のPATCH項目・削除の連鎖", async () => {
  const created = await call(R.tasks.POST, "POST", "/api/tasks", { text: "親", mode: "private", priority: "high", due_date: "2026-12-01" })
  assert.equal(created.status, 201)
  assert.equal(created.json.priority, "high")
  const child = (await call(R.tasks.POST, "POST", "/api/tasks", { text: "子", parent_id: created.json.id })).json
  assert.equal(child.mode, "private")

  const list = await call(R.tasks.GET, "GET", "/api/tasks?mode=private")
  assert.equal(list.json.length, 2)
  assert.equal((await call(R.tasks.GET, "GET", "/api/tasks?mode=work")).json.length, 0, "仕事側には出ない")

  // 編集モーダルが送る形（従来どおり）
  const patched = await call(R.task.PATCH, "PATCH", "/x", {
    text: "親(改)", priority: "low", start_date: "2026-11-20", due_date: "2026-12-05",
    is_recurring: false, recurring_days: "", memo: "メモ",
  }, created.json.id)
  assert.equal(patched.status, 200)
  assert.equal(patched.json.text, "親(改)")
  assert.equal(patched.json.start_date, "2026-11-20")

  // 並び順・完了の直接更新（従来の経路）
  const sorted = await call(R.task.PATCH, "PATCH", "/x", { sort_order: 2.5, done: true }, created.json.id)
  assert.equal(sorted.json.sort_order, 2.5)
  assert.equal(sorted.json.done, true)

  const del = await call(R.task.DELETE, "DELETE", "/x", undefined, created.json.id)
  assert.equal(del.status, 200)
  assert.equal(del.json.subtasks, 1)
  assert.equal(mock.store.tasks.length, 0, "子タスクも残らない")
})

test("タスク: 不正な入力・存在しないIDは日本語のエラーで 400/404", async () => {
  const bad = await call(R.tasks.POST, "POST", "/api/tasks", { text: "", mode: "work" })
  assert.equal(bad.status, 400)
  assert.match(bad.json.error, /タスク名/)
  assert.equal((await call(R.tasks.POST, "POST", "/api/tasks", "{broken")).status, 400)
  assert.equal((await call(R.task.PATCH, "PATCH", "/x", { text: "a" }, "nope")).status, 404)
  assert.equal((await call(R.task.DELETE, "DELETE", "/x", undefined, "nope")).status, 404)
})

test("カテゴリ変更はPATCHのmodeで行え、サブタスクも一緒に移る", async () => {
  const p = await addTask("親"); await call(R.tasks.POST, "POST", "/api/tasks", { text: "子", parent_id: p.id })
  const r = await call(R.task.PATCH, "PATCH", "/x", { mode: "work" }, p.id)
  assert.equal(r.json.mode, "work")
  assert.deepEqual(mock.store.tasks.map((t: any) => t.mode), ["work", "work"])
  assert.equal((await call(R.task.PATCH, "PATCH", "/x", { mode: "x" }, p.id)).status, 400)
})

test("プランナー: 配置→取得→移動→分割→実施→未配置の一連の流れ", async () => {
  const t = await addTask("動画編集", "private", { estimate_minutes: 120 })
  const d = today()
  const NIGHT = { window_start: 1140, window_end: 1320 }

  const c = await call(R.boxes.POST, "POST", "/api/timeboxes", { task_id: t.id, date: d, ...NIGHT, planned_minutes: 90 })
  assert.equal(c.status, 201)
  assert.equal(c.json.timebox.preset, "night")
  const id = c.json.timebox.id

  const week = await call(R.planner.GET, "GET", `/api/planner?mode=private&from=${d}&to=${addDays(d, 6)}`)
  assert.equal(week.status, 200)
  assert.equal(week.json.timeboxes.length, 1)
  assert.equal(week.json.timeboxes[0].task_text, "動画編集")
  assert.equal(week.json.analysis.private.length, 7)
  assert.equal(week.json.settings.presets.length, 3)

  const moved = await call(R.box.PATCH, "PATCH", "/x", { date: addDays(d, 1), planned_minutes: 60 }, id)
  assert.equal(moved.json.timebox.date, addDays(d, 1))

  const split = await call(R.boxSplit.POST, "POST", "/x", { minutes: 20, date: addDays(d, 2) }, id)
  assert.equal(split.status, 201)
  assert.equal(split.json.original.planned_minutes, 40)
  assert.equal(split.json.created.planned_minutes, 20)

  const done = await call(R.boxComplete.POST, "POST", "/x", { actual_minutes: 35 }, id)
  assert.equal(done.json.timebox.status, "done")
  assert.equal(mock.store.tasks.length, 1)
  assert.equal((mock.store.tasks as any[])[0].done, false, "予定の実施はタスク完了ではない")

  const un = await call(R.taskUnplace.POST, "POST", "/x", undefined, t.id)
  assert.equal(un.json.removed, 1, "残っていた予定(分割分)のみ外れる。実施済みは履歴として残る")
  assert.equal((mock.store.myflow_timeboxes as any[]).filter(b => b.status === "done").length, 1)

  const fin = await call(R.taskComplete.POST, "POST", "/x", {}, t.id)
  assert.equal(fin.json.task.done, true)
  const reopen = await call(R.taskComplete.POST, "POST", "/x", { done: false }, t.id)
  assert.equal(reopen.json.task.done, false)
})

test("プランナー: 不正な要求は 400/404（他カテゴリの詳細は返さない）", async () => {
  const d = today()
  assert.equal((await call(R.planner.GET, "GET", `/api/planner?mode=bogus&from=${d}&to=${d}`)).status, 400)
  assert.equal((await call(R.planner.GET, "GET", `/api/planner?mode=work&from=${d}`)).status, 400)
  assert.equal((await call(R.boxes.POST, "POST", "/api/timeboxes", { task_id: "nope", date: d, window_start: 0, window_end: 60, planned_minutes: 30 })).status, 404)
  assert.equal((await call(R.box.PATCH, "PATCH", "/x", { planned_minutes: 5 }, "nope")).status, 404)
  assert.equal((await call(R.box.DELETE, "DELETE", "/x", undefined, "nope")).status, 404)
})

test("プランナー: 他カテゴリの予定は時間だけが返り、警告にも予定名が出ない", async () => {
  const d = today()
  await call(R.fixed.POST, "POST", "/api/fixed-events", { mode: "work", title: "機密会議", date: d, start_min: 1170, end_min: 1230 })
  await call(R.fixed.POST, "POST", "/api/fixed-events", { mode: "private", title: "ジム", date: d, start_min: 1200, end_min: 1260 })
  const res = await call(R.planner.GET, "GET", `/api/planner?mode=private&from=${d}&to=${d}&includeOther=1`)
  assert.equal(res.json.otherBusy.length, 1)
  assert.deepEqual(Object.keys(res.json.otherBusy[0]).sort(), ["date", "end", "kind", "start"])
  assert.equal(res.json.analysis.private[0].warnings[0].crossCategory, true)
  assert.ok(!JSON.stringify(res.json).includes("機密会議"))
})

test("固定予定: 作成・一覧・更新・削除", async () => {
  const c = await call(R.fixed.POST, "POST", "/api/fixed-events", { mode: "work", title: "仕事", date: "2026-11-02", start_min: 570, end_min: 1110, repeat_days: "1,2,3,4,5" })
  assert.equal(c.status, 201)
  assert.equal((await call(R.fixed.GET, "GET", "/api/fixed-events?mode=work")).json.length, 1)
  assert.equal((await call(R.fixed.GET, "GET", "/api/fixed-events?mode=private")).json.length, 0)
  const u = await call(R.fixedOne.PATCH, "PATCH", "/x", { title: "仕事(改)", end_min: 1080 }, c.json.id)
  assert.equal(u.json.title, "仕事(改)")
  assert.equal((await call(R.fixed.POST, "POST", "/api/fixed-events", { mode: "work", title: "", date: "2026-11-02", start_min: 1, end_min: 2 })).status, 400)
  assert.equal((await call(R.fixedOne.DELETE, "DELETE", "/x", undefined, c.json.id)).status, 200)
  assert.equal(mock.store.myflow_fixed_events.length, 0)
})

test("設定: 既定値→保存→不正値は既定にフォールバック（時間帯はユーザーが変更できる）", async () => {
  const def = await call(R.settings.GET, "GET", "/api/settings")
  assert.deepEqual(def.json.presets.map((p: any) => [p.key, p.label, p.start, p.end]), [
    ["morning", "朝", 360, 600], ["noon", "昼", 720, 1020], ["night", "夜", 1140, 1320],
  ])
  assert.equal(def.json.timezone, "Asia/Tokyo")

  const saved = await call(R.settings.PATCH, "PATCH", "/api/settings", {
    presets: [{ key: "night", label: "夜", start: 1200, end: 1380 }, { key: "morning", label: "朝", start: 700, end: 600 }],
    bufferMinutes: 10,
  })
  assert.equal(saved.status, 200)
  const again = (await call(R.settings.GET, "GET", "/api/settings")).json
  assert.deepEqual(again.presets.find((p: any) => p.key === "night"), { key: "night", label: "夜", start: 1200, end: 1380 }, "夜の時間帯を変更できた")
  assert.deepEqual(again.presets.find((p: any) => p.key === "morning"), { key: "morning", label: "朝", start: 360, end: 600 }, "開始>終了の不正な朝は既定に戻る")
  assert.equal(again.bufferMinutes, 10)

  // 設定を変えると、以降の予定の preset 判定にも反映される
  const t = await addTask("x")
  const b = await call(R.boxes.POST, "POST", "/api/timeboxes", { task_id: t.id, date: today(), window_start: 1200, window_end: 1380, planned_minutes: 30 })
  assert.equal(b.json.timebox.preset, "night")
  assert.equal((await call(R.settings.PATCH, "PATCH", "/api/settings", { timezone: "Mars/Olympus" })).json.timezone, "Asia/Tokyo")
})
