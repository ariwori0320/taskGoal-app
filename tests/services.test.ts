import test, { before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { startMock, ai, ALL, windowAvoiding } from "./helpers"
import { UI_PRINCIPAL } from "../lib/principal"
import { addDays, nowInTz } from "../lib/time"

let mock: Awaited<ReturnType<typeof startMock>>
let T: typeof import("../lib/services/tasks")
let B: typeof import("../lib/services/timeboxes")
let SC: typeof import("../lib/services/schedule")
let G: typeof import("../lib/services/goals")
let A: typeof import("../lib/services/analytics")

before(async () => {
  mock = await startMock()
  T = await import("../lib/services/tasks")
  B = await import("../lib/services/timeboxes")
  SC = await import("../lib/services/schedule")
  G = await import("../lib/services/goals")
  A = await import("../lib/services/analytics")
})
after(async () => { await mock.close() })
beforeEach(() => mock.reset())

const UI = UI_PRINCIPAL
const today = () => nowInTz("Asia/Tokyo").date
const NIGHT = { window_start: 1140, window_end: 1320 }

async function rejectsWith(p: Promise<unknown>, status: number, code?: string) {
  await assert.rejects(p, (e: unknown) => {
    const err = e as { status?: number; code?: string }
    assert.equal(err.status, status)
    if (code) assert.equal(err.code, code)
    return true
  })
}

const mkTask = (text: string, mode: "work" | "private", extra: Record<string, unknown> = {}) => T.addTask(UI, { text, mode, ...extra })
const rows = (table: string) => mock.store[table] as any[]

// ============ タスク ============

test("タスク追加: 入力検証（空・長すぎ・不正な日付・開始>期限・見積り）", async () => {
  await rejectsWith(T.addTask(UI, { text: "  ", mode: "work" }), 400)
  await rejectsWith(T.addTask(UI, { text: "x".repeat(301), mode: "work" }), 400)
  await rejectsWith(T.addTask(UI, { text: "a", mode: "work", due_date: "2026-02-30" }), 400)
  await rejectsWith(T.addTask(UI, { text: "a", mode: "work", start_date: "2026-11-10", due_date: "2026-11-01" }), 400)
  await rejectsWith(T.addTask(UI, { text: "a", mode: "work", estimate_minutes: 0 }), 400)
  await rejectsWith(T.addTask(UI, { text: "a", mode: "work", estimate_minutes: 1.5 }), 400)
  await rejectsWith(T.addTask(UI, { text: "a", mode: "home" }), 400)
  assert.equal(rows("tasks").length, 0)
})

test("タスク追加: タスク名だけでも追加でき、所要時間は任意（既存データと同じ形）", async () => {
  const t = await mkTask("牛乳を買う", "private")
  assert.equal(t.priority, "mid")
  assert.equal(t.done, false)
  assert.equal(t.parent_id, null)
  assert.ok(!("estimate_minutes" in rows("tasks")[0]), "任意の列は値があるときだけ送る")
})

test("親子: 子は親と同じカテゴリ・3階層まで・子は繰り返し不可", async () => {
  const parent = await mkTask("親", "private")
  const child = await T.addTask(UI, { text: "子", parent_id: parent.id })
  assert.equal(child.mode, "private")
  await rejectsWith(T.addTask(UI, { text: "子2", parent_id: parent.id, mode: "work" }), 400)
  const grand = await T.addTask(UI, { text: "孫", parent_id: child.id })
  assert.equal(grand.mode, "private")
  await rejectsWith(T.addTask(UI, { text: "ひ孫", parent_id: grand.id }), 400)
  await rejectsWith(T.addTask(UI, { text: "繰り返しの子", parent_id: parent.id, is_recurring: true }), 400)
})

test("既存の繰り返しタスクの仕様: 完了は当日分のみ。翌日には未完了に戻る", async () => {
  const r = await mkTask("毎日の習慣", "private", { is_recurring: true, recurring_days: "" })
  const res = await T.completeTask(UI, r.id, true)
  assert.equal(res.task.recurring_done_date, today())
  assert.equal(res.task.done, false, "繰り返しは done を立てない（従来どおり）")
  const list = await T.listTasks(UI, { mode: "private", status: "active" })
  assert.equal(list.tasks.length, 0, "今日は完了済み")
  // 翌日になった想定: 完了日が昨日なら未完了として復活する
  rows("tasks")[0].recurring_done_date = addDays(today(), -1)
  const next = await T.listTasks(UI, { mode: "private", status: "active" })
  assert.equal(next.tasks.length, 1, "翌日には再び未完了")
  await T.completeTask(UI, r.id, false)
  assert.equal(rows("tasks")[0].recurring_done_date, null)
})

test("曜日指定の繰り返しは正規化・検証される", async () => {
  const t = await mkTask("月水金", "private", { is_recurring: true, recurring_days: "5, 1,3,1" })
  assert.equal(t.recurring_days, "1,3,5")
  await rejectsWith(T.addTask(UI, { text: "x", mode: "private", is_recurring: true, recurring_days: "9" }), 400)
})

// ============ 仕事とプライベートの分離（AIの権限） ============

test("分離: 仕事とプライベートのデータは混ざらない（カテゴリ指定の取得）", async () => {
  await mkTask("仕事A", "work"); await mkTask("私的A", "private")
  const w = await T.listTasks(UI, { mode: "work", status: "all" })
  const p = await T.listTasks(UI, { mode: "private", status: "all" })
  assert.deepEqual(w.tasks.map(t => t.text), ["仕事A"])
  assert.deepEqual(p.tasks.map(t => t.text), ["私的A"])
})

test("AI（プライベートのみ許可）は、仕事のタスクを一覧・詳細・変更・完了・削除のどれでも扱えない", async () => {
  const work = await mkTask("機密の仕事タスク", "work")
  const priv = await mkTask("私的タスク", "private")
  const bot = ai(["private"], ALL)

  // 一覧は許可カテゴリだけ
  const all = await T.listTasks(bot, { status: "all" })
  assert.deepEqual(all.tasks.map(t => t.text), ["私的タスク"])
  assert.ok(!JSON.stringify(all).includes("機密"))
  // 明示的に仕事を指定すると 403
  await rejectsWith(T.listTasks(bot, { mode: "work" }), 403)
  // IDを直接指定しても「存在しない」(404)。存在そのものを漏らさない
  await rejectsWith(T.getTaskDetail(bot, work.id), 404)
  await rejectsWith(T.updateTask(bot, work.id, { text: "改ざん" }), 404)
  await rejectsWith(T.completeTask(bot, work.id), 404)
  await rejectsWith(T.deleteTask(bot, work.id, { confirm: true }), 404)
  await rejectsWith(T.changeTaskCategory(bot, work.id, "private"), 404)
  // 追加先も許可カテゴリのみ
  await rejectsWith(T.addTask(bot, { text: "仕事に追加", mode: "work" }), 403)
  // 許可カテゴリには追加できる。mode省略時は許可カテゴリになる
  const added = await T.addTask(bot, { text: "AIが追加" })
  assert.equal(added.mode, "private")
  // 仕事のデータは一切変わっていない
  const w = rows("tasks").find(r => r.id === work.id)
  assert.equal(w.text, "機密の仕事タスク")
  assert.equal(w.done, false)
  assert.ok(rows("tasks").find(r => r.id === priv.id))
})

test("AI: 仕事側へカテゴリを移すことも、仕事側のデータを引き込むことも出来ない", async () => {
  const priv = await mkTask("私的", "private")
  const bot = ai(["private"], ALL)
  await rejectsWith(T.changeTaskCategory(bot, priv.id, "work"), 403) // 移動先が許可されていない
  assert.equal(rows("tasks")[0].mode, "private")
})

test("権限（スコープ）: 付与された操作だけ実行できる", async () => {
  const t = await mkTask("対象", "private")
  const readOnly = ai(["private"], ["read"])
  await rejectsWith(T.addTask(readOnly, { text: "x" }), 403)
  await rejectsWith(T.updateTask(readOnly, t.id, { text: "x" }), 403)
  await rejectsWith(T.completeTask(readOnly, t.id), 403)
  await rejectsWith(T.deleteTask(readOnly, t.id, { confirm: true }), 403)
  await rejectsWith(B.createTimebox(readOnly, { task_id: t.id, date: today(), ...NIGHT, planned_minutes: 30 }), 403)
  assert.equal((await T.listTasks(readOnly, { status: "all" })).tasks.length, 1) // 閲覧はできる
  // 完了だけ許可
  const completer = ai(["private"], ["read", "complete"])
  await T.completeTask(completer, t.id)
  await rejectsWith(T.updateTask(completer, t.id, { text: "x" }), 403)
  // 何も許可されないカテゴリ（modes=[]）では何も見えない
  const none = ai([], ALL)
  assert.deepEqual((await T.listTasks(none, { status: "all" })).tasks, [])
})

test("削除: 確認なしでは実行されず、確認後はサブタスクと予定も一緒に消える", async () => {
  const parent = await mkTask("親", "private")
  const child = await T.addTask(UI, { text: "子", parent_id: parent.id })
  const other = await mkTask("無関係", "private")
  await B.createTimebox(UI, { task_id: child.id, date: today(), ...NIGHT, planned_minutes: 30 })

  const preview = await T.deleteTask(UI, parent.id)
  assert.ok("needsConfirmation" in preview && preview.needsConfirmation)
  assert.equal(rows("tasks").length, 3, "確認なしでは何も消えない")

  const done = await T.deleteTask(UI, parent.id, { confirm: true })
  assert.ok("deleted" in done && done.deleted)
  assert.deepEqual(rows("tasks").map(r => r.id), [other.id])
  assert.equal(rows("myflow_timeboxes").length, 0)
  assert.ok(rows("myflow_events").some(e => e.type === "task_deleted"))
})

test("カテゴリ変更: サブタスクと予定も一緒に移り、単独のサブタスクは変更不可", async () => {
  const parent = await mkTask("親", "private")
  const child = await T.addTask(UI, { text: "子", parent_id: parent.id })
  await B.createTimebox(UI, { task_id: parent.id, date: today(), ...NIGHT, planned_minutes: 30 })
  await rejectsWith(T.changeTaskCategory(UI, child.id, "work"), 400)

  const r = await T.changeTaskCategory(UI, parent.id, "work")
  assert.ok(r.changed)
  assert.deepEqual(rows("tasks").map(x => x.mode), ["work", "work"])
  assert.equal(rows("myflow_timeboxes")[0].mode, "work", "タイムボックスのカテゴリもタスクに揃う")
  // 変更後、プライベート側からは見えない
  assert.equal((await T.listTasks(UI, { mode: "private", status: "all" })).tasks.length, 0)
})

test("カテゴリ変更: AIは多数に影響する変更に承認が必要。別カテゴリの目標とのひも付けは外れる", async () => {
  const bot = ai(["work", "private"], ALL)
  const parent = await mkTask("親", "private")
  let cur = parent
  for (let i = 0; i < 2; i++) cur = await T.addTask(UI, { text: `子${i}`, parent_id: cur.id })
  // 5件を超える状況を作る（親+子孫=3件 だと閾値以下なので、閾値を超えるまで兄弟を追加）
  for (let i = 0; i < 4; i++) await T.addTask(UI, { text: `兄弟${i}`, parent_id: parent.id })
  const preview = await T.changeTaskCategory(bot, parent.id, "work")
  assert.ok("needsConfirmation" in preview && preview.needsConfirmation)
  assert.equal(rows("tasks").every(r => r.mode === "private"), true, "承認前は何も変わらない")
  const done = await T.changeTaskCategory(bot, parent.id, "work", { confirm: true })
  assert.ok(done.changed)

  // 目標とのひも付けは、カテゴリが変わると解除される
  const goal = { id: "g1", user_id: "default", mode: "private", text: "私的目標", pct: 0 }
  rows("goals").push(goal)
  const t = await mkTask("目標付き", "private")
  await T.updateTask(UI, t.id, { goal_id: "g1" })
  assert.equal(rows("tasks").find(r => r.id === t.id).goal_id, "g1")
  await T.changeTaskCategory(UI, t.id, "work")
  assert.equal(rows("tasks").find(r => r.id === t.id).goal_id, null)
})

test("目標とのひも付け: 同じカテゴリの目標にのみ可能", async () => {
  rows("goals").push({ id: "gw", user_id: "default", mode: "work", text: "仕事目標", pct: 10 })
  rows("goals").push({ id: "gp", user_id: "default", mode: "private", text: "私的目標", pct: 20 })
  const t = await mkTask("タスク", "private")
  await rejectsWith(G.linkTaskToGoal(UI, t.id, "gw"), 400)
  await G.linkTaskToGoal(UI, t.id, "gp")
  const progress = await G.getGoalProgress(UI, "gp")
  assert.equal(progress.linked_tasks.total, 1)
  assert.equal(progress.goal.progress_percent, 20)
  // 仕事のみ許可のAIは私的目標を見られない
  await rejectsWith(G.getGoalProgress(ai(["work"], ALL), "gp"), 404)
  const goals = await G.listGoals(ai(["work"], ALL))
  assert.deepEqual(goals.map(g => g.id), ["gw"])
})

// ============ タイムボックス ============

test("タイムボックス: 作成の検証（時間帯・作業時間・完了済みタスク）", async () => {
  const t = await mkTask("動画編集", "private")
  const base = { task_id: t.id, date: today(), ...NIGHT, planned_minutes: 30 }
  await rejectsWith(B.createTimebox(UI, { ...base, date: "2026-13-01" }), 400)
  await rejectsWith(B.createTimebox(UI, { ...base, window_start: 1320, window_end: 1140 }), 400)
  await rejectsWith(B.createTimebox(UI, { ...base, planned_minutes: 0 }), 400)
  await rejectsWith(B.createTimebox(UI, { ...base, planned_minutes: 200 }), 400) // 180分の時間帯に200分は入らない
  await rejectsWith(B.createTimebox(UI, { ...base, task_id: "存在しない" }), 404)
  const ok = await B.createTimebox(UI, base)
  assert.equal(ok.timebox.preset, "night", "夜のプリセットと一致すれば preset=night")
  assert.equal(ok.timebox.mode, "private", "カテゴリはタスクから引き継ぐ")
  const custom = await B.createTimebox(UI, { ...base, window_start: 1100 })
  assert.equal(custom.timebox.preset, "custom")
  await T.completeTask(UI, t.id)
  await rejectsWith(B.createTimebox(UI, base), 400)
})

test("1つのタスクに複数のタイムボックス（120分を30/60/30に分けられる）と、見積りに対する残り", async () => {
  const t = await mkTask("動画編集", "private", { estimate_minutes: 120 })
  const d0 = today()
  await B.createTimebox(UI, { task_id: t.id, date: d0, ...NIGHT, planned_minutes: 30 })
  await B.createTimebox(UI, { task_id: t.id, date: addDays(d0, 1), ...NIGHT, planned_minutes: 60 })
  await B.createTimebox(UI, { task_id: t.id, date: addDays(d0, 2), ...NIGHT, planned_minutes: 30 })
  const detail = await T.getTaskDetail(UI, t.id)
  assert.equal(detail.timeboxes.length, 3)
  assert.equal(detail.timeboxes.reduce((s, b) => s + b.planned_minutes, 0), 120)
  assert.equal(detail.task.estimate_minutes, 120)
})

test("タイムボックス: 移動は先送り/移動として履歴に残り、所要時間の変更も記録される", async () => {
  const t = await mkTask("資料", "private")
  const d0 = today()
  const { timebox } = await B.createTimebox(UI, { task_id: t.id, date: d0, ...NIGHT, planned_minutes: 30 })

  await B.updateTimebox(UI, timebox.id, { date: addDays(d0, 1) })                 // 明日へ = 先送り
  await B.updateTimebox(UI, timebox.id, { window_start: 360, window_end: 600 })  // 朝へ = 移動
  await B.updateTimebox(UI, timebox.id, { date: d0 })                             // 今日へ戻す = 先送りではない
  await B.updateTimebox(UI, timebox.id, { planned_minutes: 45 })                  // 所要時間変更
  const types = rows("myflow_events").map(e => e.type)
  assert.equal(types.filter(x => x === "timebox_postponed").length, 1)
  assert.equal(types.filter(x => x === "timebox_moved").length, 2)
  assert.equal(types.filter(x => x === "timebox_resized").length, 1)
  assert.equal(rows("myflow_timeboxes")[0].preset, "morning", "朝の時間帯(6:00-10:00)に一致したので preset=morning")
  await rejectsWith(B.updateTimebox(UI, timebox.id, {}), 400)
  await rejectsWith(B.updateTimebox(UI, timebox.id, { planned_minutes: 999 }), 400)
})

test("タイムボックス: 余白を超えると警告が返る（作業は拒否しない）", async () => {
  const d = today()
  const a = await mkTask("A", "private"), b = await mkTask("B", "private")
  await B.createTimebox(UI, { task_id: a.id, date: d, ...NIGHT, planned_minutes: 120 })
  const r = await B.createTimebox(UI, { task_id: b.id, date: d, ...NIGHT, planned_minutes: 70 })
  assert.equal(r.analysis.warnings[0]?.code, "window_over")
  assert.equal(rows("myflow_timeboxes").length, 2, "警告のみで作成はできる")
})

test("実行サポート: 予定の実施(今日はここまで)はタスクを完了にしない。時間帯を守れたかも別に記録", async () => {
  const t = await mkTask("TikTok制作", "private", { estimate_minutes: 60 })
  const now = nowInTz("Asia/Tokyo")
  const avoid = windowAvoiding(now.minutes)
  const { timebox } = await B.createTimebox(UI, { task_id: t.id, date: today(), window_start: avoid.start, window_end: avoid.end, planned_minutes: 30 })
  const r = await B.completeTimebox(UI, timebox.id, { actual_minutes: 20 })
  assert.equal(r.timebox.status, "done")
  assert.equal(r.timebox.actual_minutes, 20)
  assert.equal(r.timebox.kept_window, false, "予定の時間帯の外で実施")
  assert.equal(rows("tasks")[0].done, false, "タスクは完了にならない")
  await rejectsWith(B.completeTimebox(UI, timebox.id), 400) // 二重実施はしない
  await rejectsWith(B.updateTimebox(UI, timebox.id, { planned_minutes: 10 }), 400)
})

test("予定していた時間帯を外して完了しても、タスクの完了は正当に記録される（時間帯の遵守とは別管理）", async () => {
  const t = await mkTask("提出物", "private")
  const now = nowInTz("Asia/Tokyo")
  const avoid = windowAvoiding(now.minutes)
  const { timebox: box } = await B.createTimebox(UI, { task_id: t.id, date: today(), window_start: avoid.start, window_end: avoid.end, planned_minutes: 30 })
  const later = await B.createTimebox(UI, { task_id: t.id, date: addDays(today(), 2), ...NIGHT, planned_minutes: 30 })

  const r = await T.completeTask(UI, t.id)
  assert.equal(r.task.done, true)
  assert.equal(r.timebox?.id, box.id)
  assert.equal(r.timebox?.kept_window, false)
  assert.equal(r.releasedTimeboxes, 1, "残りの予定は不要になり、計画から外れる")
  assert.equal(rows("myflow_timeboxes").find(b => b.id === later.timebox.id).status, "released")
  const ev = rows("myflow_events").find(e => e.type === "task_completed")
  assert.equal(ev.payload.kept_window, false)
  assert.equal(ev.payload.had_timebox, true)
})

test("タイムボックスが終了しても自動で完了・失敗扱いにならない（過去の予定も planned のまま）", async () => {
  const t = await mkTask("昨日の予定", "private")
  const { timebox } = await B.createTimebox(UI, { task_id: t.id, date: addDays(today(), -1), ...NIGHT, planned_minutes: 30 })
  const list = await B.listTimeboxes(UI, { mode: "private" })
  assert.equal(list.find(b => b.id === timebox.id)?.status, "planned")
  assert.equal(rows("tasks")[0].done, false)
})

test("未配置に戻す: タスクの予定だけが消え、タスク自体は残る", async () => {
  const t = await mkTask("配置済み", "private")
  const other = await mkTask("別のタスク", "private")
  await B.createTimebox(UI, { task_id: t.id, date: today(), ...NIGHT, planned_minutes: 30 })
  await B.createTimebox(UI, { task_id: t.id, date: addDays(today(), 1), ...NIGHT, planned_minutes: 30 })
  await B.createTimebox(UI, { task_id: other.id, date: today(), ...NIGHT, planned_minutes: 30 })
  const r = await B.unplaceTask(UI, t.id)
  assert.equal(r.removed, 2)
  assert.equal(rows("myflow_timeboxes").length, 1)
  assert.equal(rows("tasks").length, 2)
})

test("分割: 予定の一部を別の日へ。合計の作業時間は保たれる", async () => {
  const t = await mkTask("動画編集", "private", { estimate_minutes: 120 })
  const { timebox } = await B.createTimebox(UI, { task_id: t.id, date: today(), ...NIGHT, planned_minutes: 120 })
  await rejectsWith(B.splitTimebox(UI, timebox.id, { minutes: 120 }), 400) // 全部は分割できない
  await rejectsWith(B.splitTimebox(UI, timebox.id, { minutes: 0 }), 400)
  const { original, created } = await B.splitTimebox(UI, timebox.id, { minutes: 30 })
  assert.equal(original.planned_minutes, 90)
  assert.equal(created.planned_minutes, 30)
  assert.equal(created.date, addDays(today(), 1))
  assert.equal(created.task_id, t.id)
  assert.equal(original.planned_minutes + created.planned_minutes, 120)
})

// ============ スケジュール取得（別カテゴリの扱い） ============

test("別カテゴリとの重なり: 画面には警告と『時間だけ』が出て、予定名は出ない／許可の無いAIには何も出ない", async () => {
  const d = today()
  // 仕事の固定予定 19:30-20:30 と、プライベートの固定予定 20:00-21:00
  await SC.createFixedEvent(UI, { mode: "work", title: "機密プロジェクト会議", date: d, start_min: 1170, end_min: 1230 })
  await SC.createFixedEvent(UI, { mode: "private", title: "ジム", date: d, start_min: 1200, end_min: 1260 })

  const ui = await SC.getSchedule(UI, { mode: "private", from: d, to: d, includeOther: true })
  const warn = ui.analysis.private![0].warnings
  assert.equal(warn.length, 1)
  assert.equal(warn[0].crossCategory, true)
  assert.deepEqual(ui.fixedEvents.map(f => f.title), ["ジム"], "表示する固定予定は自分のカテゴリのみ")
  assert.equal(ui.otherBusy?.length, 1)
  assert.ok(!JSON.stringify(ui).includes("機密プロジェクト会議"), "別カテゴリの予定名は含まれない")

  // 画面でも includeOther を指定しなければ他カテゴリの時間は出ない
  const quiet = await SC.getSchedule(UI, { mode: "private", from: d, to: d })
  assert.equal(quiet.otherBusy, undefined)

  // プライベートのみ許可のAI: 仕事の予定の存在も警告も、一切分からない
  const bot = ai(["private"], ALL)
  const aiRes = await SC.getSchedule(bot, { from: d, to: d, includeOther: true })
  assert.equal(aiRes.otherBusy, undefined)
  assert.deepEqual(aiRes.analysis.private![0].warnings, [])
  assert.equal(aiRes.analysis.work, undefined)
  assert.ok(!JSON.stringify(aiRes).includes("機密"))
  await rejectsWith(SC.getSchedule(bot, { mode: "work", from: d, to: d }), 403)
})

test("スケジュール取得: タイムボックスにタスク名が付き、許可外カテゴリの予定は含まれない", async () => {
  const d = today()
  const p = await mkTask("私的タスク", "private"), w = await mkTask("仕事タスク", "work")
  await B.createTimebox(UI, { task_id: p.id, date: d, ...NIGHT, planned_minutes: 30 })
  await B.createTimebox(UI, { task_id: w.id, date: d, ...NIGHT, planned_minutes: 30 })
  const bot = ai(["private"], ALL)
  const r = await SC.getSchedule(bot, { from: d, to: d })
  assert.deepEqual(r.timeboxes.map(b => b.task_text), ["私的タスク"])
  const tbs = await B.listTimeboxes(bot, {})
  assert.deepEqual(tbs.map(b => b.task_id), [p.id])
  await rejectsWith(B.updateTimebox(bot, rows("myflow_timeboxes").find(b => b.task_id === w.id).id, { planned_minutes: 10 }), 404)
})

test("スケジュール取得: 期間の検証", async () => {
  await rejectsWith(SC.getSchedule(UI, { mode: "work", from: "2026-11-10", to: "2026-11-01" }), 400)
  await rejectsWith(SC.getSchedule(UI, { mode: "work", from: "2026-01-01", to: "2026-12-31" }), 400)
  await rejectsWith(SC.getSchedule(UI, { mode: "work", from: "abc", to: "2026-12-31" }), 400)
})

test("固定予定: 曜日の繰り返しは週をまたいで展開され、検証される", async () => {
  await rejectsWith(SC.createFixedEvent(UI, { mode: "work", title: "日付なし", start_min: 600, end_min: 660 }), 400)
  await rejectsWith(SC.createFixedEvent(UI, { mode: "work", title: "", date: today(), start_min: 600, end_min: 660 }), 400)
  await rejectsWith(SC.createFixedEvent(UI, { mode: "work", title: "逆", date: today(), start_min: 660, end_min: 600 }), 400)
  await SC.createFixedEvent(UI, { mode: "work", title: "仕事", date: "2026-11-02", start_min: 570, end_min: 1110, repeat_days: "1,2,3,4,5" })
  const r = await SC.getSchedule(UI, { mode: "work", from: "2026-11-02", to: "2026-11-15" })
  assert.equal(r.fixedEvents.length, 10, "2週間の平日10日")
  // 仕事のみ許可のAIはプライベートの固定予定を作れない
  await rejectsWith(SC.createFixedEvent(ai(["work"], ALL), { mode: "private", title: "x", date: today(), start_min: 1, end_min: 2 }), 403)
})

// ============ 履歴・集計 ============

test("履歴: 完了・先送りが記録され、AIには許可カテゴリ分だけが見える", async () => {
  const p = await mkTask("私的", "private"), w = await mkTask("仕事", "work")
  const d = today()
  const bp = await B.createTimebox(UI, { task_id: p.id, date: d, ...NIGHT, planned_minutes: 30 })
  const bw = await B.createTimebox(UI, { task_id: w.id, date: d, ...NIGHT, planned_minutes: 30 })
  await B.updateTimebox(UI, bp.timebox.id, { date: addDays(d, 1) })
  await B.updateTimebox(UI, bp.timebox.id, { date: addDays(d, 2) })
  await B.updateTimebox(UI, bw.timebox.id, { date: addDays(d, 1) })
  await T.completeTask(UI, p.id); await T.completeTask(UI, w.id)

  const range = { from: addDays(d, -1), to: addDays(d, 1) }
  const bot = ai(["private"], ALL)
  const hist = await A.completionHistory(bot, range)
  assert.deepEqual(hist.completions.map(c => c.text), ["私的"])
  const pp = await A.postponements(bot, range)
  assert.equal(pp.total_postponements, 2)
  assert.deepEqual(pp.tasks.map(t => [t.text, t.postponed_count]), [["私的", 2]])
  const all = await A.postponements(UI, range)
  assert.equal(all.total_postponements, 3)

  const sum = await A.summary(bot, { period: "week", date: d })
  assert.equal(sum.modes.length, 1)
  assert.ok(sum.note.includes("リニューアル後"))
  await rejectsWith(A.summary(bot, { mode: "work" }), 403)
  await rejectsWith(A.completionHistory(bot, { from: "x", to: "y" }), 400)
})

test("集計: 期限が今週のタスクの完了率・先送りの多いタスクが出る", async () => {
  const d = today()
  const a = await mkTask("今週A", "private", { due_date: d }), b = await mkTask("今週B", "private", { due_date: d })
  await mkTask("来年", "private", { due_date: "2099-01-01" })
  await T.completeTask(UI, a.id)
  const s = await A.summary(UI, { mode: "private", period: "week", date: d })
  assert.equal(s.tasks.due_in_period, 2)
  assert.equal(s.tasks.done_among_due, 1)
  assert.equal(s.tasks.completion_rate_percent, 50)
  assert.equal(s.activity.completed_events, 1)
  void b
})

// ============ マイグレーション前でも既存機能が壊れない ============

test("監査: 履歴には操作者(ui / ai:名前)が残る", async () => {
  const bot = ai(["private"], ALL, "claude")
  const t = await T.addTask(bot, { text: "AIが追加" })
  await T.completeTask(UI, t.id)
  const actors = rows("myflow_events").map(e => `${e.type}:${e.actor}`)
  assert.ok(actors.includes("task_created:ai:claude"))
  assert.ok(actors.includes("task_completed:ui"))
})
