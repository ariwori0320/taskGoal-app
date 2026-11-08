import test from "node:test"
import assert from "node:assert/strict"
import { autoCompare, inDateRange, isTaskDone, manualCompare, nextRecurrenceDate, nextRecurrenceText, recurrenceLabel, recursOn } from "../lib/task-utils"
import type { TaskRow } from "../lib/types"

const t = (o: Partial<TaskRow> & { id: string }): TaskRow => ({
  user_id: "default", mode: "private", text: o.id, priority: "mid", start_date: null, due_date: null, done: false, parent_id: null,
  memo: null, is_recurring: false, recurring_days: "", recurring_done_date: null, sort_order: null, created_at: "2026-11-01T00:00:00Z", ...o,
})

test("自動並び: 繰り返し → 期限が早い順 → 優先度の高い順", () => {
  const list = [
    t({ id: "低・期限なし", priority: "low" }),
    t({ id: "高・期限なし", priority: "high" }),
    t({ id: "遅い期限", due_date: "2026-12-01" }),
    t({ id: "早い期限", due_date: "2026-11-10", priority: "low" }),
    t({ id: "繰り返し", is_recurring: true, due_date: "2026-11-02" }),
  ].sort(autoCompare)
  assert.deepEqual(list.map(x => x.id), ["繰り返し", "早い期限", "遅い期限", "高・期限なし", "低・期限なし"])
})

test("手動並び: 繰り返しが先頭、あとは sort_order（未設定は後ろ）", () => {
  const list = [t({ id: "b", sort_order: 2 }), t({ id: "none" }), t({ id: "a", sort_order: 1 }), t({ id: "r", is_recurring: true, sort_order: 9 })].sort(manualCompare)
  assert.deepEqual(list.map(x => x.id), ["r", "a", "b", "none"])
})

test("繰り返し: 毎日/曜日指定の該当判定と、次回の日付（完了済みなら翌日以降）", () => {
  // 2026-11-05 は木曜(4)
  const weekly = { is_recurring: true, recurring_days: "1,3,5", recurring_done_date: null as string | null } // 月水金
  assert.equal(recursOn(weekly, "2026-11-05"), false)
  assert.equal(recursOn(weekly, "2026-11-06"), true)
  assert.equal(nextRecurrenceDate(weekly, "2026-11-05"), "2026-11-06")
  assert.equal(nextRecurrenceText(weekly, "2026-11-05"), "明日")
  const daily = { is_recurring: true, recurring_days: "", recurring_done_date: "2026-11-05" }
  assert.equal(nextRecurrenceDate(daily, "2026-11-05"), "2026-11-06", "今日の分を完了済みなら次は明日")
  assert.equal(nextRecurrenceText({ ...daily, recurring_done_date: null }, "2026-11-05"), "今日")
  assert.equal(recurrenceLabel({ recurring_days: "" }), "毎日")
  assert.equal(recurrenceLabel({ recurring_days: "5,1,3" }), "月・水・金")
  assert.equal(recursOn({ is_recurring: false, recurring_days: "" }, "2026-11-05"), false)
})

test("完了判定: 繰り返しは『その日の分』だけを見る", () => {
  assert.equal(isTaskDone(t({ id: "a", done: true }), "2026-11-05"), true)
  const r = t({ id: "r", is_recurring: true, recurring_done_date: "2026-11-04" })
  assert.equal(isTaskDone(r, "2026-11-05"), false)
  assert.equal(isTaskDone(r, "2026-11-04"), true)
})

test("期間フィルター: 期間に重なるタスクだけ。繰り返しは常に対象", () => {
  const withDue = t({ id: "due", due_date: "2026-11-10" })
  const ranged = t({ id: "ranged", start_date: "2026-11-01", due_date: "2026-11-20" })
  const none = t({ id: "none" })
  const rec = t({ id: "rec", is_recurring: true })
  assert.equal(inDateRange(withDue, "", ""), true)
  assert.equal(inDateRange(withDue, "2026-11-08", "2026-11-12"), true)
  assert.equal(inDateRange(withDue, "2026-11-11", ""), false)
  assert.equal(inDateRange(ranged, "2026-11-15", "2026-11-16"), true, "開始〜期限の途中の日にも重なる")
  assert.equal(inDateRange(none, "2026-11-01", ""), false)
  assert.equal(inDateRange(rec, "2026-11-01", "2026-11-02"), true)
})

import { buildHierarchy } from "../lib/task-utils"

test("階層: 子・孫の path / depth / 葉 / 進み具合（葉で数える）", () => {
  const all = [
    t({ id: "提案書" }),
    t({ id: "資料づくり", parent_id: "提案書" }),
    t({ id: "グラフ", parent_id: "資料づくり", done: true }),
    t({ id: "表", parent_id: "資料づくり" }),
    t({ id: "見直し", parent_id: "提案書" }),
    t({ id: "単独" }),
  ]
  const h = buildHierarchy(all, "2026-11-08")
  assert.deepEqual([h.get("提案書")!.path, h.get("提案書")!.depth, h.get("提案書")!.is_leaf], [[], 0, false])
  assert.deepEqual([h.get("グラフ")!.path, h.get("グラフ")!.depth, h.get("グラフ")!.root_id, h.get("グラフ")!.is_leaf], [["提案書", "資料づくり"], 2, "提案書", true])
  // 親の進み具合: 葉は グラフ(済)・表・見直し の3件中1件
  assert.deepEqual([h.get("提案書")!.leaves_total, h.get("提案書")!.leaves_done], [3, 1])
  assert.deepEqual([h.get("資料づくり")!.leaves_total, h.get("資料づくり")!.leaves_done, h.get("資料づくり")!.children_total, h.get("資料づくり")!.children_done], [2, 1, 2, 1])
  assert.deepEqual([h.get("単独")!.leaves_total, h.get("単独")!.leaves_done, h.get("単独")!.is_leaf], [1, 0, true])
})

test("階層: 親が見えない子はルート扱い／循環があっても止まる", () => {
  const h = buildHierarchy([t({ id: "迷子", parent_id: "不明" }), t({ id: "a", parent_id: "b" }), t({ id: "b", parent_id: "a" })], "2026-11-08")
  assert.deepEqual([h.get("迷子")!.path, h.get("迷子")!.depth], [[], 0])
  assert.ok(h.get("a")!.depth <= 1 && h.get("b")!.depth <= 1)
})
