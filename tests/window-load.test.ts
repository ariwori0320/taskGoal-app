// 時間帯の負荷(computeWindowLoad)。画面とサーバーが同じ計算を使うことを保証する。

import test from "node:test"
import assert from "node:assert/strict"
import { analyzeDay, computeWindowLoad, type FixedOccurrence, type TimeboxRow } from "../lib/planning"

const NIGHT = { start: 19 * 60, end: 22 * 60 }
const NOON = { start: 12 * 60, end: 17 * 60 }
const tb = (o: Partial<TimeboxRow> & { id: string }): TimeboxRow => ({
  mode: "private", task_id: "t-" + o.id, date: "2026-11-05", window_start: NIGHT.start, window_end: NIGHT.end, planned_minutes: 30, status: "planned", ...o,
})
const fx = (o: Partial<FixedOccurrence> & { event_id: string }): FixedOccurrence => ({
  mode: "private", title: "予定", date: "2026-11-05", start_min: 0, end_min: 0, ...o,
})

test("使えない時間(別カテゴリの勤務時間で埋まっている)は free=0。そこに入っている別カテゴリの作業を『超過』にしない", () => {
  const workBlock = fx({ event_id: "w", mode: "work", title: "仕事", start_min: 570, end_min: 1110, allows_tasks: true })
  const workBox = tb({ id: "w1", mode: "work", planned_minutes: 60, window_start: NOON.start, window_end: NOON.end })
  const priv = computeWindowLoad({ window: NOON, mode: "private", fixed: [workBlock], timeboxes: [workBox], bufferMinutes: 5 })
  assert.equal(priv.free, 0)
  assert.equal(priv.own, 0)
  // 仕事から見ると、勤務時間は使える。自分の作業 60+5 分だけが乗る
  const work = computeWindowLoad({ window: NOON, mode: "work", fixed: [workBlock], timeboxes: [workBox], bufferMinutes: 5 })
  assert.equal(work.free, 300)
  assert.equal(work.own, 65)
  assert.equal(work.remain, 235)
})

test("作業の移動中は、自分自身を除いて計算できる（excludeId）", () => {
  const a = tb({ id: "a", planned_minutes: 100 }), b = tb({ id: "b", planned_minutes: 70 })
  const all = computeWindowLoad({ window: NIGHT, mode: "private", fixed: [], timeboxes: [a, b], bufferMinutes: 0 })
  assert.equal(all.remain, 10)
  const without = computeWindowLoad({ window: NIGHT, mode: "private", fixed: [], timeboxes: [a, b], bufferMinutes: 0, excludeId: "b" })
  assert.equal(without.remain, 80)
})

test("analyzeDay が返す時間帯の負荷は computeWindowLoad と一致する（サーバーと画面で数字がずれない）", () => {
  const fixed = [fx({ event_id: "gym", start_min: 19 * 60 + 30, end_min: 20 * 60 + 30 })]
  const boxes = [tb({ id: "a", planned_minutes: 50 }), tb({ id: "b", planned_minutes: 40 }), tb({ id: "w", mode: "work", planned_minutes: 30 })]
  const a = analyzeDay({ date: "2026-11-05", currentMode: "private", fixed, timeboxes: boxes, bufferMinutes: 5 })
  const w = computeWindowLoad({ window: NIGHT, mode: "private", fixed, timeboxes: boxes, bufferMinutes: 5 })
  assert.equal(a.windows[0].freeMinutes, w.free)
  assert.equal(a.windows[0].ownMinutes, w.own)
  assert.equal(a.windows[0].otherMinutes, w.other)
  assert.equal(a.windows[0].overMinutes, Math.max(0, -w.remain))
})
