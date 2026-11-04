import test from "node:test"
import assert from "node:assert/strict"
import {
  analyzeDay, describeWarning, expandFixedEvents, mergeIntervals, occursOn, subtractIntervals, taskPlanSummary, totalLength,
  type FixedEventRow, type FixedOccurrence, type TimeboxRow,
} from "../lib/planning"

const NIGHT = { start: 19 * 60, end: 22 * 60 } // 180分
const tb = (o: Partial<TimeboxRow> & { id: string }): TimeboxRow => ({
  mode: "private", task_id: "t-" + o.id, date: "2026-11-05",
  window_start: NIGHT.start, window_end: NIGHT.end, planned_minutes: 30, status: "planned", ...o,
})
const fx = (o: Partial<FixedOccurrence> & { event_id: string }): FixedOccurrence => ({
  mode: "private", title: "予定", date: "2026-11-05", start_min: 0, end_min: 0, ...o,
})

test("区間演算: マージ・差し引き・長さ", () => {
  assert.deepEqual(mergeIntervals([{ start: 10, end: 20 }, { start: 15, end: 30 }, { start: 40, end: 50 }]), [{ start: 10, end: 30 }, { start: 40, end: 50 }])
  assert.deepEqual(subtractIntervals([{ start: 0, end: 100 }], [{ start: 20, end: 30 }, { start: 90, end: 120 }]), [{ start: 0, end: 20 }, { start: 30, end: 90 }])
  assert.equal(totalLength([{ start: 0, end: 10 }, { start: 5, end: 20 }]), 20)
  assert.deepEqual(subtractIntervals([{ start: 0, end: 10 }], [{ start: 0, end: 10 }]), [])
})

test("固定予定の展開: 単発・曜日繰り返し・開始日・終了日", () => {
  const work: FixedEventRow = { id: "w", mode: "work", title: "仕事", date: "2026-11-02", start_min: 570, end_min: 1110, repeat_days: "1,2,3,4,5" }
  const gym: FixedEventRow = { id: "g", mode: "private", title: "ジム", date: "2026-11-05", start_min: 1170, end_min: 1230, repeat_days: "" }
  const occ = expandFixedEvents([work, gym], "2026-11-02", "2026-11-08")
  const workDates = occ.filter(o => o.event_id === "w").map(o => o.date)
  assert.deepEqual(workDates, ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]) // 平日のみ
  assert.deepEqual(occ.filter(o => o.event_id === "g").map(o => o.date), ["2026-11-05"]) // 単発はその日だけ
  // 開始日より前には出ない
  assert.equal(occursOn(work, "2026-10-30"), false)
  // 終了日の翌日には出ない
  assert.equal(occursOn({ ...work, until: "2026-11-04" }, "2026-11-05"), false)
  assert.equal(occursOn({ ...work, until: "2026-11-04" }, "2026-11-04"), true)
})

test("余白: 3時間の時間帯に30分を入れても180分すべては占有しない", () => {
  const r = analyzeDay({ date: "2026-11-05", currentMode: "private", fixed: [], timeboxes: [tb({ id: "a" })], bufferMinutes: 0 })
  assert.equal(r.windows.length, 1)
  assert.equal(r.windows[0].freeMinutes, 180)
  assert.equal(r.windows[0].ownMinutes, 30)
  assert.equal(r.plannedMinutes, 30)
  assert.equal(r.overMinutes, 0)
  assert.deepEqual(r.warnings, [])
})

test("余白: 複数タスクの必要時間を合算して時間帯の空きと比較する", () => {
  const boxes = [tb({ id: "a", planned_minutes: 60 }), tb({ id: "b", planned_minutes: 60 }), tb({ id: "c", planned_minutes: 60 })]
  const ok = analyzeDay({ date: "2026-11-05", currentMode: "private", fixed: [], timeboxes: boxes, bufferMinutes: 0 })
  assert.deepEqual(ok.warnings, []) // ちょうど180分は超過ではない
  const over = analyzeDay({ date: "2026-11-05", currentMode: "private", fixed: [], timeboxes: [...boxes, tb({ id: "d", planned_minutes: 15 })], bufferMinutes: 0 })
  assert.equal(over.warnings.length, 1)
  assert.equal(over.warnings[0].code, "window_over")
  assert.equal(over.warnings[0].overMinutes, 15)
  assert.equal(over.warnings[0].crossCategory, false)
})

test("固定予定が重なっている時間は空きから差し引く", () => {
  const fixed = [fx({ event_id: "gym", start_min: 19 * 60 + 30, end_min: 20 * 60 + 30 })] // 60分
  const r = analyzeDay({
    date: "2026-11-05", currentMode: "private", fixed, bufferMinutes: 0,
    timeboxes: [tb({ id: "a", planned_minutes: 100 }), tb({ id: "b", planned_minutes: 30 })],
  })
  assert.equal(r.windows[0].freeMinutes, 120) // 180 - 60
  assert.equal(r.warnings[0].code, "window_over")
  assert.equal(r.warnings[0].overMinutes, 10) // 130 - 120
})

test("時間帯が固定予定で完全に埋まっているときは blocked", () => {
  const fixed = [fx({ event_id: "x", start_min: NIGHT.start, end_min: NIGHT.end })]
  const r = analyzeDay({ date: "2026-11-05", currentMode: "private", fixed, timeboxes: [tb({ id: "a" })], bufferMinutes: 0 })
  assert.equal(r.warnings[0].code, "window_blocked")
})

test("移動・休憩の余白(buffer)を1件ごとに上乗せできる", () => {
  const boxes = [tb({ id: "a", planned_minutes: 85 }), tb({ id: "b", planned_minutes: 85 })]
  const none = analyzeDay({ date: "2026-11-05", currentMode: "private", fixed: [], timeboxes: boxes, bufferMinutes: 0 })
  assert.deepEqual(none.warnings, []) // 170 <= 180
  const withBuf = analyzeDay({ date: "2026-11-05", currentMode: "private", fixed: [], timeboxes: boxes, bufferMinutes: 10 })
  assert.equal(withBuf.warnings[0].overMinutes, 10) // (85+10)*2 = 190
})

test("完了済み・解放済みのタイムボックスは計算に含めない", () => {
  const r = analyzeDay({
    date: "2026-11-05", currentMode: "private", fixed: [], bufferMinutes: 0,
    timeboxes: [tb({ id: "a", planned_minutes: 170 }), tb({ id: "b", planned_minutes: 100, status: "done" }), tb({ id: "c", planned_minutes: 100, status: "released" })],
  })
  assert.deepEqual(r.warnings, [])
  assert.equal(r.plannedMinutes, 170)
})

test("別カテゴリとの競合: 合算で足りないときは crossCategory の警告（別カテゴリのタスク名は出ない）", () => {
  const other = tb({ id: "w1", mode: "work", planned_minutes: 100, task_id: "SECRET-WORK-TASK" })
  const own = tb({ id: "p1", mode: "private", planned_minutes: 100 })
  const r = analyzeDay({ date: "2026-11-05", currentMode: "private", fixed: [], timeboxes: [own, other], bufferMinutes: 0 })
  assert.equal(r.warnings.length, 1)
  assert.equal(r.warnings[0].code, "window_over")
  assert.equal(r.warnings[0].crossCategory, true)
  assert.equal(r.warnings[0].overMinutes, 20)
  assert.equal(r.windows[0].otherMinutes, 100)
  assert.ok(!JSON.stringify(r).includes("SECRET-WORK-TASK"))
  // 反対側(仕事)から見ても対称に警告される
  const rw = analyzeDay({ date: "2026-11-05", currentMode: "work", fixed: [], timeboxes: [own, other], bufferMinutes: 0 })
  assert.equal(rw.warnings[0].crossCategory, true)
})

test("別カテゴリの時間帯が一部しか重ならないときは、重なり部分に入る確実な分だけ数える", () => {
  // 別カテゴリ 17:00-20:00 で60分 → 19時前(17-19)の空き120分で吸収できるので夜には影響しない
  const other = tb({ id: "w1", mode: "work", window_start: 17 * 60, window_end: 20 * 60, planned_minutes: 60 })
  const own = tb({ id: "p1", planned_minutes: 175 })
  const r = analyzeDay({ date: "2026-11-05", currentMode: "private", fixed: [], timeboxes: [own, other], bufferMinutes: 0 })
  assert.deepEqual(r.warnings, [])
  // 別カテゴリが150分だと 17-19 の120分に収まらず、30分が夜に食い込む → 175+30 > 180
  const other2 = { ...other, planned_minutes: 150 }
  const r2 = analyzeDay({ date: "2026-11-05", currentMode: "private", fixed: [], timeboxes: [own, other2], bufferMinutes: 0 })
  assert.equal(r2.warnings[0].crossCategory, true)
  assert.equal(r2.warnings[0].overMinutes, 25)
})

test("固定予定同士の重なり: 別カテゴリとの重なりは時間だけを知らせ、相手の予定名は出さない", () => {
  const fixed = [
    fx({ event_id: "work", mode: "work", title: "機密プロジェクト会議", start_min: 19 * 60 + 30, end_min: 20 * 60 + 30 }),
    fx({ event_id: "gym", mode: "private", title: "ジム", start_min: 20 * 60, end_min: 21 * 60 }),
  ]
  const r = analyzeDay({ date: "2026-11-05", currentMode: "private", fixed, timeboxes: [], bufferMinutes: 0 })
  assert.equal(r.warnings.length, 1)
  assert.equal(r.warnings[0].code, "fixed_overlap")
  assert.equal(r.warnings[0].crossCategory, true)
  assert.equal(r.warnings[0].overMinutes, 30)
  const text = describeWarning(r.warnings[0])
  assert.ok(text.includes("20:00–20:30"))
  assert.ok(!text.includes("機密プロジェクト会議"))
  assert.ok(!JSON.stringify(r).includes("機密プロジェクト会議"))
})

test("固定予定同士の重なり: 同じカテゴリ同士は予定名を出す／他カテゴリ同士の重なりは見ているカテゴリには出さない", () => {
  const same = analyzeDay({
    date: "2026-11-05", currentMode: "private", timeboxes: [], bufferMinutes: 0,
    fixed: [fx({ event_id: "a", title: "ジム", start_min: 600, end_min: 660 }), fx({ event_id: "b", title: "歯医者", start_min: 630, end_min: 690 })],
  })
  assert.deepEqual(same.warnings[0].titles, ["ジム", "歯医者"])
  const unrelated = analyzeDay({
    date: "2026-11-05", currentMode: "private", timeboxes: [], bufferMinutes: 0,
    fixed: [fx({ event_id: "a", mode: "work", start_min: 600, end_min: 660 }), fx({ event_id: "b", mode: "work", start_min: 630, end_min: 690 })],
  })
  assert.deepEqual(unrelated.warnings, [])
})

test("describeWarning: 時間帯名(朝・昼・夜)を表示に使える", () => {
  const w = analyzeDay({
    date: "2026-11-05", currentMode: "private", fixed: [], bufferMinutes: 0,
    timeboxes: [tb({ id: "a", planned_minutes: 200 })],
  }).warnings[0]
  const text = describeWarning(w, (s, e) => (s === NIGHT.start && e === NIGHT.end ? "夜" : null))
  assert.match(text, /^夜 19:00–22:00 は予定が20分超過しています/)
})

test("taskPlanSummary: 見積りに対する配置済み・実施済み・未配置の残り", () => {
  const s = taskPlanSummary(120, [
    { status: "planned", planned_minutes: 30 },
    { status: "planned", planned_minutes: 60 },
    { status: "done", planned_minutes: 30, actual_minutes: 20 },
    { status: "released", planned_minutes: 999 },
  ])
  assert.deepEqual(s, { plannedMinutes: 90, doneMinutes: 20, unplacedMinutes: 10 })
  assert.equal(taskPlanSummary(null, [{ status: "planned", planned_minutes: 30 }]).unplacedMinutes, null)
  assert.equal(taskPlanSummary(30, [{ status: "planned", planned_minutes: 60 }]).unplacedMinutes, 0)
})

// ---------- 勤務時間のように「同じカテゴリの作業を入れてよい」固定予定 ----------

test("作業を入れてよい固定予定(勤務時間): 同じカテゴリの作業は差し引かず、別カテゴリには差し引く", () => {
  const NOON = { window_start: 12 * 60, window_end: 17 * 60 } // 300分
  const work = fx({ event_id: "w", mode: "work", title: "仕事", start_min: 570, end_min: 1110, allows_tasks: true })
  // 仕事のタスクは、仕事の勤務時間の中に入れても「時間が取れません」にならない
  const own = analyzeDay({ date: "2026-11-05", currentMode: "work", fixed: [work], bufferMinutes: 0, timeboxes: [tb({ id: "a", mode: "work", planned_minutes: 60, ...NOON })] })
  assert.deepEqual(own.warnings, [])
  assert.equal(own.windows[0].freeMinutes, 300)
  // プライベートの作業を勤務時間の中に入れると、時間が取れない（別カテゴリの勤務時間は差し引く）
  const other = analyzeDay({ date: "2026-11-05", currentMode: "private", fixed: [work], bufferMinutes: 0, timeboxes: [tb({ id: "p", mode: "private", planned_minutes: 60, ...NOON })] })
  assert.equal(other.warnings[0].code, "window_blocked")
  // 「作業を入れてよい」を付けない固定予定(会議など)は、同じカテゴリの作業からも差し引く
  const meeting = fx({ event_id: "m", mode: "work", title: "会議", start_min: 12 * 60, end_min: 17 * 60 })
  const blocked = analyzeDay({ date: "2026-11-05", currentMode: "work", fixed: [meeting], bufferMinutes: 0, timeboxes: [tb({ id: "a", mode: "work", planned_minutes: 60, ...NOON })] })
  assert.equal(blocked.warnings[0].code, "window_blocked")
})

test("勤務時間の中の同じカテゴリの会議は『重なり』として警告しない。別カテゴリとの重なりは警告する", () => {
  const block = fx({ event_id: "w", mode: "work", title: "仕事", start_min: 570, end_min: 1110, allows_tasks: true })
  const meeting = fx({ event_id: "m", mode: "work", title: "定例会議", start_min: 600, end_min: 660 })
  const inside = analyzeDay({ date: "2026-11-05", currentMode: "work", fixed: [block, meeting], timeboxes: [], bufferMinutes: 0 })
  assert.deepEqual(inside.warnings, [])
  const gym = fx({ event_id: "g", mode: "private", title: "ジム", start_min: 1080, end_min: 1170 }) // 18:00-19:30 と勤務(〜18:30)が30分重なる
  const cross = analyzeDay({ date: "2026-11-05", currentMode: "private", fixed: [block, gym], timeboxes: [], bufferMinutes: 0 })
  assert.equal(cross.warnings[0].code, "fixed_overlap")
  assert.equal(cross.warnings[0].crossCategory, true)
  assert.equal(cross.warnings[0].overMinutes, 30)
})
